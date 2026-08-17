using Microsoft.Data.SqlClient;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer;

/// <summary>
/// Builds every connection through <see cref="SqlConnectionStringBuilder"/>
/// only, then applies exactly one authentication strategy with no fallback to
/// another on failure. SQL-login credentials are cached by stable profile
/// configuration so the same <see cref="SqlCredential"/> backs one pool until
/// this factory is disposed or explicitly invalidated after secret rotation.
/// Entra credentials and their <c>AccessTokenCallback</c> delegate are cached
/// the same way, by stable Entra security context (profile id, connection
/// string, and every strategy identifier/secret reference): the callback
/// itself is part of SqlClient's connection pool key, so reusing the exact
/// same delegate and <c>TokenCredential</c> for sequential and concurrent
/// opens of the same profile is required to share one pool instead of
/// creating a new pool -- and re-materializing a secret or certificate --
/// per connection. See <see cref="EntraCredentialLease"/>.
/// </summary>
public sealed class SqlConnectionFactory : ISqlConnectionFactory
{
    private readonly ISqlConnectionOpener _opener;
    private readonly ISecretFileProvider? _secretProvider;
    private readonly ISqlLoginCredentialLeaseFactory _credentialLeaseFactory;
    private readonly IEntraCredentialLeaseFactory _entraLeaseFactory;
    private readonly ISqlConnectionPoolController _poolController;
    private readonly object _credentialGate = new();
    private readonly Dictionary<SqlLoginCredentialCacheKey, CredentialCacheEntry<SqlLoginCredentialLease>> _credentialLeases = [];
    private readonly Dictionary<EntraCredentialCacheKey, CredentialCacheEntry<EntraCredentialLease>> _entraLeases = [];
    private readonly List<PendingRetirement<SqlLoginCredentialCacheKey, SqlLoginCredentialLease>> _pendingSqlLoginRetirements = [];
    private readonly List<PendingRetirement<EntraCredentialCacheKey, EntraCredentialLease>> _pendingEntraRetirements = [];
    private bool _shutdownStarted;

    public SqlConnectionFactory(ISecretFileProvider secretProvider)
        : this(secretProvider, new DefaultSqlConnectionOpener())
    {
    }

    public SqlConnectionFactory(ISecretFileProvider secretProvider, ISqlConnectionOpener opener)
        : this(
            new SecretFileSqlLoginCredentialLeaseFactory(secretProvider),
            opener,
            new DefaultSqlConnectionPoolController(),
            secretProvider)
    {
    }

    internal SqlConnectionFactory(
        ISqlLoginCredentialLeaseFactory credentialLeaseFactory,
        ISqlConnectionOpener opener,
        ISqlConnectionPoolController poolController,
        ISecretFileProvider? secretProvider = null,
        IEntraCredentialLeaseFactory? entraLeaseFactory = null)
    {
        ArgumentNullException.ThrowIfNull(credentialLeaseFactory);
        ArgumentNullException.ThrowIfNull(opener);
        ArgumentNullException.ThrowIfNull(poolController);
        _credentialLeaseFactory = credentialLeaseFactory;
        _opener = opener;
        _poolController = poolController;
        _secretProvider = secretProvider;
        _entraLeaseFactory = entraLeaseFactory ?? new DefaultEntraCredentialLeaseFactory(GetSecretProvider);
    }

    public async Task<SqlConnectionOpenResult> OpenAsync(ConnectionProfile profile, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(profile);
        cancellationToken.ThrowIfCancellationRequested();
        ThrowIfDisposed();

        var builder = BuildConnectionStringBuilder(profile);
        SqlConnection? connection = null;
        Action? releaseCredentialLease = null;

        try
        {
            (connection, releaseCredentialLease) = await CreateConnectionAsync(profile, builder, cancellationToken)
                .ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            await _opener.OpenAsync(connection, cancellationToken).ConfigureAwait(false);

            var warnings = profile.TrustServerCertificate
                ? new[] { ConnectionWarning.TrustServerCertificateEnabled }
                : Array.Empty<ConnectionWarning>();

            return new SqlConnectionOpenResult(connection, warnings, releaseCredentialLease);
        }
        catch
        {
            if (connection is not null)
            {
                await connection.DisposeAsync().ConfigureAwait(false);
            }

            releaseCredentialLease?.Invoke();
            throw;
        }
    }

    /// <summary>
    /// Invalidates one SQL-login credential after an operator rotates its mounted
    /// secret. Retirement waits for every returned result to be disposed before
    /// clearing the old pool and zeroing the password. Use a bounded cancellation
    /// token when the caller cannot wait indefinitely, then retry cleanup after
    /// outstanding results have been disposed.
    /// </summary>
    public async Task InvalidateSqlLoginProfileAsync(
        ConnectionProfile profile,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(profile);
        ThrowIfDisposed();

        if (profile.Authentication is not SqlLoginAuthenticationStrategy authentication)
        {
            throw new ArgumentException(
                "Only SQL-login profiles have cached credentials to invalidate.",
                nameof(profile));
        }

        var key = SqlLoginCredentialCacheKey.From(profile, BuildConnectionStringBuilder(profile), authentication);
        await InvalidateLeaseAsync(
                _credentialLeases,
                _pendingSqlLoginRetirements,
                key,
                cancellationToken)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Invalidates one Entra credential/callback after an operator rotates its
    /// mounted certificate or client secret, or wants to force a managed- or
    /// workload-identity profile to acquire a fresh <c>TokenCredential</c>.
    /// Retirement waits for every returned result to be disposed before clearing
    /// the old pool and releasing owned certificate material. A bounded
    /// cancellation token leaves retirement pending and non-rentable for retry.
    /// </summary>
    public async Task InvalidateEntraProfileAsync(
        ConnectionProfile profile,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(profile);
        ThrowIfDisposed();

        if (profile.Authentication is not EntraAuthenticationStrategy authentication)
        {
            throw new ArgumentException(
                "Only Entra profiles have cached credential callbacks to invalidate.",
                nameof(profile));
        }

        var key = EntraCredentialCacheKey.From(profile, BuildConnectionStringBuilder(profile), authentication);
        await InvalidateLeaseAsync(
                _entraLeases,
                _pendingEntraRetirements,
                key,
                cancellationToken)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Atomically removes and marks the cached entry before waiting for active
    /// results. Failed cleanup remains pending for retry and can never make the
    /// old lease rentable again.
    /// </summary>
    private async Task InvalidateLeaseAsync<TKey, TLease>(
        Dictionary<TKey, CredentialCacheEntry<TLease>> cache,
        List<PendingRetirement<TKey, TLease>> pendingRetirements,
        TKey key,
        CancellationToken cancellationToken)
        where TKey : notnull, ICredentialCacheKey
        where TLease : class, IPooledCredentialLease
    {
        List<PendingRetirement<TKey, TLease>> matching;
        lock (_credentialGate)
        {
            ThrowIfShutdownStarted();
            if (cache.Remove(key, out var entry))
            {
                entry.BeginRetirement();
                pendingRetirements.Add(new PendingRetirement<TKey, TLease>(key, entry));
            }

            matching = pendingRetirements
                .Where(pending => EqualityComparer<TKey>.Default.Equals(pending.Key, key))
                .ToList();
        }

        var failures = await CleanupRetirementsAsync(
                pendingRetirements,
                matching,
                cancellationToken)
            .ConfigureAwait(false);
        ThrowCleanupFailures(failures);
    }

    public async Task RetryPendingCleanupAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        List<PendingRetirement<SqlLoginCredentialCacheKey, SqlLoginCredentialLease>> sqlLogin;
        List<PendingRetirement<EntraCredentialCacheKey, EntraCredentialLease>> entra;
        lock (_credentialGate)
        {
            sqlLogin = [.. _pendingSqlLoginRetirements];
            entra = [.. _pendingEntraRetirements];
        }

        var failures = await CleanupRetirementsAsync(
                _pendingSqlLoginRetirements,
                sqlLogin,
                cancellationToken)
            .ConfigureAwait(false);
        failures.AddRange(await CleanupRetirementsAsync(
                _pendingEntraRetirements,
                entra,
                cancellationToken)
            .ConfigureAwait(false));
        ThrowCleanupFailures(failures);
    }

    public void Dispose() => DisposeAsync().AsTask().GetAwaiter().GetResult();

    /// <summary>
    /// Retires every cached SQL-login and Entra credential lease, clearing
    /// each one's pool before releasing its secret material. A pool-clear
    /// failure for one lease never stops the rest from being retired, but
    /// every such failure is collected and re-thrown as an
    /// <see cref="AggregateException"/> once shutdown finishes -- shutdown
    /// never silently leaves a credential whose pool could not be cleared
    /// without reporting it. Failed retirements remain reachable so another
    /// <see cref="DisposeAsync"/> or <see cref="RetryPendingCleanupAsync"/> call
    /// can retry them.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        lock (_credentialGate)
        {
            if (!_shutdownStarted)
            {
                _shutdownStarted = true;
                MoveToPending(_credentialLeases, _pendingSqlLoginRetirements);
                MoveToPending(_entraLeases, _pendingEntraRetirements);
            }
        }

        List<Exception> retireFailures;
        try
        {
            await RetryPendingCleanupAsync().ConfigureAwait(false);
            return;
        }
        catch (AggregateException ex)
        {
            retireFailures = [.. ex.InnerExceptions];
        }
        catch (Exception ex)
        {
            retireFailures = [ex];
        }

        if (retireFailures.Count > 0)
        {
            throw new AggregateException(
                "One or more credential pools could not be cleared during factory shutdown; their credentials remain valid and undisposed.",
                retireFailures);
        }
    }

    /// <summary>
    /// Attempts pending retirements while retaining every failed entry for retry.
    /// </summary>
    private async Task<List<Exception>> CleanupRetirementsAsync<TKey, TLease>(
        List<PendingRetirement<TKey, TLease>> pendingRetirements,
        IReadOnlyList<PendingRetirement<TKey, TLease>> retirements,
        CancellationToken cancellationToken)
        where TKey : notnull, ICredentialCacheKey
        where TLease : class, IPooledCredentialLease
    {
        List<Exception> failures = [];
        foreach (var pending in retirements)
        {
            try
            {
                await pending.Entry
                    .RetireAsync(_poolController, pending.Key.ConnectionString, cancellationToken)
                    .ConfigureAwait(false);
                lock (_credentialGate)
                {
                    pendingRetirements.Remove(pending);
                }
            }
            catch (Exception ex)
            {
                failures.Add(ex);
            }
        }

        return failures;
    }

    private async Task<(SqlConnection Connection, Action? ReleaseCredentialLease)> CreateConnectionAsync(
        ConnectionProfile profile,
        SqlConnectionStringBuilder builder,
        CancellationToken cancellationToken)
    {
        switch (profile.Authentication)
        {
            case SqlLoginAuthenticationStrategy sqlLogin:
            {
                var lease = await RentLeaseAsync(
                        _credentialLeases,
                        _pendingSqlLoginRetirements,
                        SqlLoginCredentialCacheKey.From(profile, builder, sqlLogin),
                        () => _credentialLeaseFactory.CreateAsync(sqlLogin, CancellationToken.None),
                        cancellationToken)
                    .ConfigureAwait(false);
                try
                {
                    return (new SqlConnection(builder.ConnectionString, lease.Credential), lease.Release);
                }
                catch
                {
                    lease.Release();
                    throw;
                }
            }

            case KerberosAuthenticationStrategy:
                builder.IntegratedSecurity = true;
                return (new SqlConnection(builder.ConnectionString), null);

            case EntraAuthenticationStrategy entra:
            {
                var lease = await RentLeaseAsync(
                        _entraLeases,
                        _pendingEntraRetirements,
                        EntraCredentialCacheKey.From(profile, builder, entra),
                        () => _entraLeaseFactory.CreateAsync(entra, CancellationToken.None),
                        cancellationToken)
                    .ConfigureAwait(false);
                try
                {
                    var connection = new SqlConnection(builder.ConnectionString)
                    {
                        // Reuse the exact same delegate instance every time: it is
                        // part of SqlClient's connection pool key (see
                        // EntraCredentialLease), so a fresh closure per connection
                        // would silently open one pool per connection.
                        AccessTokenCallback = lease.Callback,
                    };
                    return (connection, lease.Release);
                }
                catch
                {
                    lease.Release();
                    throw;
                }
            }

            default:
                throw new AuthenticationConfigurationException(
                    $"Unhandled authentication strategy '{profile.Authentication.GetType().Name}'.");
        }
    }

    /// <summary>
    /// Rents one cached, reference-counted lease for <paramref name="key"/>,
    /// creating it through <paramref name="createLease"/> the first time that
    /// key is seen and reusing the exact same instance -- and, for Entra,
    /// the exact same <c>AccessTokenCallback</c> delegate -- for every
    /// subsequent sequential or concurrent open. Shared by both the
    /// SQL-login and Entra caches so pending-creation races, cancellation,
    /// and failed-creation cache eviction are handled identically and only
    /// once.
    /// </summary>
    private async Task<TLease> RentLeaseAsync<TKey, TLease>(
        Dictionary<TKey, CredentialCacheEntry<TLease>> cache,
        List<PendingRetirement<TKey, TLease>> pendingRetirements,
        TKey key,
        Func<Task<TLease>> createLease,
        CancellationToken cancellationToken)
        where TKey : notnull, ICredentialCacheKey
        where TLease : class, IPooledCredentialLease
    {
        while (true)
        {
            CredentialCacheEntry<TLease> entry;
            lock (_credentialGate)
            {
                ThrowIfShutdownStarted();
                if (!cache.TryGetValue(key, out entry!))
                {
                    entry = new CredentialCacheEntry<TLease>(createLease);
                    cache.Add(key, entry);
                }
            }

            TLease lease;
            try
            {
                lease = await entry.CreationTask.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch
            {
                lock (_credentialGate)
                {
                    if (cache.TryGetValue(key, out var current) && ReferenceEquals(current, entry))
                    {
                        cache.Remove(key);
                        entry.BeginRetirement();
                    }
                }

                throw;
            }

            PendingRetirement<TKey, TLease>? rejectedRetirement = null;
            lock (_credentialGate)
            {
                ThrowIfShutdownStarted();
                if (cache.TryGetValue(key, out var current) && ReferenceEquals(current, entry))
                {
                    if (entry.TryRent(lease))
                    {
                        return lease;
                    }

                    cache.Remove(key);
                    entry.BeginRetirement();
                    rejectedRetirement = new PendingRetirement<TKey, TLease>(key, entry);
                    pendingRetirements.Add(rejectedRetirement);
                }
            }

            if (rejectedRetirement is not null)
            {
                var failures = await CleanupRetirementsAsync(
                        pendingRetirements,
                        [rejectedRetirement],
                        cancellationToken)
                    .ConfigureAwait(false);
                ThrowCleanupFailures(failures);
            }
        }
    }

    private static void MoveToPending<TKey, TLease>(
        Dictionary<TKey, CredentialCacheEntry<TLease>> cache,
        List<PendingRetirement<TKey, TLease>> pendingRetirements)
        where TKey : notnull
        where TLease : class, IPooledCredentialLease
    {
        foreach (var (key, entry) in cache)
        {
            entry.BeginRetirement();
            pendingRetirements.Add(new PendingRetirement<TKey, TLease>(key, entry));
        }

        cache.Clear();
    }

    private static void ThrowCleanupFailures(List<Exception> failures)
    {
        if (failures.Count == 0)
        {
            return;
        }

        if (failures.Count == 1)
        {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failures[0]).Throw();
        }

        throw new AggregateException("One or more credential retirements failed.", failures);
    }

    private sealed class CredentialCacheEntry<TLease>
        where TLease : class, IPooledCredentialLease
    {
        private readonly object _gate = new();
        private TLease? _lease;
        private bool _retirementStarted;
        private bool _everRented;

        public CredentialCacheEntry(Func<Task<TLease>> createLease)
        {
            ArgumentNullException.ThrowIfNull(createLease);
            CreationTask = CaptureAsync(createLease());
        }

        public Task<TLease> CreationTask { get; }

        public bool TryRent(TLease lease)
        {
            lock (_gate)
            {
                if (_retirementStarted || !ReferenceEquals(_lease, lease) || !lease.TryRent())
                {
                    return false;
                }

                _everRented = true;
                return true;
            }
        }

        public void BeginRetirement()
        {
            lock (_gate)
            {
                if (_retirementStarted)
                {
                    return;
                }

                _retirementStarted = true;
                _lease?.BeginRetirement();
            }
        }

        public async ValueTask RetireAsync(
            ISqlConnectionPoolController poolController,
            string connectionString,
            CancellationToken cancellationToken)
        {
            BeginRetirement();

            TLease lease;
            try
            {
                lease = await CreationTask.ConfigureAwait(false);
            }
            catch
            {
                // A failed creation task produced no lease material to retire.
                return;
            }

            bool clearPool;
            lock (_gate)
            {
                clearPool = _everRented;
            }

            await lease
                .RetireAsync(poolController, connectionString, clearPool, cancellationToken)
                .ConfigureAwait(false);
        }

        private async Task<TLease> CaptureAsync(Task<TLease> creationTask)
        {
            var lease = await creationTask.ConfigureAwait(false);
            lock (_gate)
            {
                _lease = lease;
                if (_retirementStarted)
                {
                    lease.BeginRetirement();
                }
            }

            return lease;
        }
    }

    private sealed record PendingRetirement<TKey, TLease>(
        TKey Key,
        CredentialCacheEntry<TLease> Entry)
        where TKey : notnull
        where TLease : class, IPooledCredentialLease;

    private ISecretFileProvider GetSecretProvider() =>
        _secretProvider ?? throw new InvalidOperationException(
            "An injected SQL-login lease factory must also provide a secret provider for Entra authentication.");

    private void ThrowIfDisposed()
    {
        lock (_credentialGate)
        {
            ThrowIfShutdownStarted();
        }
    }

    private void ThrowIfShutdownStarted() =>
        ObjectDisposedException.ThrowIf(_shutdownStarted, this);

    /// <summary>
    /// Builds the connection string in isolation from authentication so it can
    /// be unit tested without a secret provider or network access. Always sets
    /// <c>Encrypt</c> explicitly, <c>TrustServerCertificate</c> only from the
    /// profile's own valid opt-in, <c>PersistSecurityInfo=false</c>,
    /// <c>ApplicationIntent=ReadOnly</c>, and bounded connect/command timeouts
    /// and pool bounds. Never sets a user ID or password here.
    /// </summary>
    internal static SqlConnectionStringBuilder BuildConnectionStringBuilder(ConnectionProfile profile)
    {
        ArgumentNullException.ThrowIfNull(profile);

        var builder = new SqlConnectionStringBuilder
        {
            DataSource = profile.Server.ToDataSource(),
            InitialCatalog = profile.InitialDatabase,
            Encrypt = profile.Encryption == EncryptionPolicy.Strict
                ? SqlConnectionEncryptOption.Strict
                : SqlConnectionEncryptOption.Mandatory,
            TrustServerCertificate = profile.TrustServerCertificate,
            PersistSecurityInfo = false,
            ApplicationIntent = ApplicationIntent.ReadOnly,
            ApplicationName = ConnectionProfile.ApplicationName,
            ConnectTimeout = profile.Timeouts.ConnectTimeoutSeconds,
            CommandTimeout = profile.Timeouts.CommandTimeoutSeconds,
            Pooling = true,
            MinPoolSize = profile.Pool.MinPoolSize,
            MaxPoolSize = profile.Pool.MaxPoolSize,
        };

        if (profile.HostNameInCertificate is { } hostNameInCertificate)
        {
            builder.HostNameInCertificate = hostNameInCertificate;
        }

        return builder;
    }
}
