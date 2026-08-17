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
    private readonly Dictionary<SqlLoginCredentialCacheKey, Lazy<Task<SqlLoginCredentialLease>>> _credentialLeases = [];
    private readonly Dictionary<EntraCredentialCacheKey, Lazy<Task<EntraCredentialLease>>> _entraLeases = [];
    private bool _disposed;

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
    /// secret. Returned results retain the old password until they are disposed;
    /// callers must dispose every result before expecting the password to zero.
    /// </summary>
    public async Task InvalidateSqlLoginProfileAsync(ConnectionProfile profile)
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
        await InvalidateLeaseAsync(_credentialLeases, key, lease => lease.Retire(_poolController, key.ConnectionString))
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Invalidates one Entra credential/callback after an operator rotates its
    /// mounted certificate or client secret, or wants to force a managed- or
    /// workload-identity profile to acquire a fresh <c>TokenCredential</c>.
    /// Returned results retain the old credential and any owned certificate
    /// until they are disposed; callers must dispose every result before
    /// expecting owned certificate material to be released.
    /// </summary>
    public async Task InvalidateEntraProfileAsync(ConnectionProfile profile)
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
        await InvalidateLeaseAsync(_entraLeases, key, lease => lease.Retire(_poolController, key.ConnectionString))
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Retires the cached lease for <paramref name="key"/> and removes it from
    /// <paramref name="cache"/> only once <paramref name="retire"/> succeeds.
    /// If <paramref name="retire"/> throws (a pool-clear failure), the lease
    /// is deliberately left in the cache exactly as it was -- still valid,
    /// still the one every subsequent open reuses -- instead of being evicted
    /// out from under a pool that could not actually be cleared, which would
    /// otherwise both orphan the unretired lease's credential material forever
    /// and silently start a second, duplicate pool on the next open. The
    /// exception still propagates to the caller, and a later retry of this
    /// same invalidation finds the identical lease and can retire it once the
    /// underlying failure is resolved.
    /// </summary>
    private async Task InvalidateLeaseAsync<TKey, TLease>(
        Dictionary<TKey, Lazy<Task<TLease>>> cache,
        TKey key,
        Action<TLease> retire)
        where TKey : notnull
        where TLease : class, IPooledCredentialLease
    {
        Lazy<Task<TLease>>? lazyLease;
        lock (_credentialGate)
        {
            cache.TryGetValue(key, out lazyLease);
        }

        if (lazyLease is null || !lazyLease.IsValueCreated)
        {
            return;
        }

        var lease = await lazyLease.Value.ConfigureAwait(false);
        retire(lease);

        lock (_credentialGate)
        {
            if (cache.TryGetValue(key, out var current) && ReferenceEquals(current, lazyLease))
            {
                cache.Remove(key);
            }
        }
    }

    public void Dispose() => DisposeAsync().AsTask().GetAwaiter().GetResult();

    /// <summary>
    /// Retires every cached SQL-login and Entra credential lease, clearing
    /// each one's pool before releasing its secret material. A pool-clear
    /// failure for one lease never stops the rest from being retired, but
    /// every such failure is collected and re-thrown as an
    /// <see cref="AggregateException"/> once shutdown finishes -- shutdown
    /// never silently leaves a credential whose pool could not be cleared
    /// without reporting it. A lease whose creation itself failed (for
    /// example a missing secret file) owned no credential material and is
    /// skipped without being treated as a failure.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        List<KeyValuePair<SqlLoginCredentialCacheKey, Lazy<Task<SqlLoginCredentialLease>>>> sqlLoginLeases;
        List<KeyValuePair<EntraCredentialCacheKey, Lazy<Task<EntraCredentialLease>>>> entraLeases;
        lock (_credentialGate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            sqlLoginLeases = [.. _credentialLeases];
            entraLeases = [.. _entraLeases];
            _credentialLeases.Clear();
            _entraLeases.Clear();
        }

        List<Exception>? retireFailures = null;

        foreach (var (key, lazyLease) in sqlLoginLeases)
        {
            if (!lazyLease.IsValueCreated)
            {
                continue;
            }

            var failure = await RetireDuringShutdownAsync(lazyLease.Value, lease => lease.Retire(_poolController, key.ConnectionString))
                .ConfigureAwait(false);
            if (failure is not null)
            {
                (retireFailures ??= []).Add(failure);
            }
        }

        foreach (var (key, lazyLease) in entraLeases)
        {
            if (!lazyLease.IsValueCreated)
            {
                continue;
            }

            var failure = await RetireDuringShutdownAsync(lazyLease.Value, lease => lease.Retire(_poolController, key.ConnectionString))
                .ConfigureAwait(false);
            if (failure is not null)
            {
                (retireFailures ??= []).Add(failure);
            }
        }

        if (retireFailures is { Count: > 0 })
        {
            throw new AggregateException(
                "One or more credential pools could not be cleared during factory shutdown; their credentials remain valid and undisposed.",
                retireFailures);
        }
    }

    /// <summary>
    /// Awaits one cached lease's creation task and retires it, returning the
    /// retirement failure (if any) instead of throwing so
    /// <see cref="DisposeAsync"/> can keep retiring the remaining leases and
    /// still report every failure it encountered.
    /// </summary>
    private static async Task<Exception?> RetireDuringShutdownAsync<TLease>(Task<TLease> leaseTask, Action<TLease> retire)
    {
        TLease lease;
        try
        {
            lease = await leaseTask.ConfigureAwait(false);
        }
        catch
        {
            // Lease creation itself failed (for example a missing or unreadable
            // secret file); no credential material was ever produced, so there
            // is nothing to retire or report.
            return null;
        }

        try
        {
            retire(lease);
            return null;
        }
        catch (Exception ex)
        {
            return ex;
        }
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
        Dictionary<TKey, Lazy<Task<TLease>>> cache,
        TKey key,
        Func<Task<TLease>> createLease,
        CancellationToken cancellationToken)
        where TKey : notnull
        where TLease : class, IPooledCredentialLease
    {
        while (true)
        {
            Lazy<Task<TLease>> lazyLease;
            lock (_credentialGate)
            {
                ThrowIfDisposed();
                if (!cache.TryGetValue(key, out lazyLease!))
                {
                    lazyLease = new Lazy<Task<TLease>>(createLease, LazyThreadSafetyMode.ExecutionAndPublication);
                    cache.Add(key, lazyLease);
                }
            }

            TLease lease;
            try
            {
                lease = await lazyLease.Value.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch
            {
                lock (_credentialGate)
                {
                    if (cache.TryGetValue(key, out var current) && ReferenceEquals(current, lazyLease))
                    {
                        cache.Remove(key);
                    }
                }

                throw;
            }

            lock (_credentialGate)
            {
                ThrowIfDisposed();
                if (cache.TryGetValue(key, out var current) && ReferenceEquals(current, lazyLease))
                {
                    lease.Rent();
                    return lease;
                }
            }
        }
    }

    private ISecretFileProvider GetSecretProvider() =>
        _secretProvider ?? throw new InvalidOperationException(
            "An injected SQL-login lease factory must also provide a secret provider for Entra authentication.");

    private void ThrowIfDisposed()
    {
        lock (_credentialGate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
        }
    }

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
