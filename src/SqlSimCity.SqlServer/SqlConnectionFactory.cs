using Azure.Core;
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
/// </summary>
public sealed class SqlConnectionFactory : ISqlConnectionFactory
{
    private static readonly string[] EntraDatabaseScope = ["https://database.windows.net/.default"];

    private readonly ISqlConnectionOpener _opener;
    private readonly ISecretFileProvider? _secretProvider;
    private readonly ISqlLoginCredentialLeaseFactory _credentialLeaseFactory;
    private readonly ISqlConnectionPoolController _poolController;
    private readonly object _credentialGate = new();
    private readonly Dictionary<SqlLoginCredentialCacheKey, Lazy<Task<SqlLoginCredentialLease>>> _credentialLeases = [];
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
        ISecretFileProvider? secretProvider = null)
    {
        ArgumentNullException.ThrowIfNull(credentialLeaseFactory);
        ArgumentNullException.ThrowIfNull(opener);
        ArgumentNullException.ThrowIfNull(poolController);
        _credentialLeaseFactory = credentialLeaseFactory;
        _opener = opener;
        _poolController = poolController;
        _secretProvider = secretProvider;
    }

    public async Task<SqlConnectionOpenResult> OpenAsync(ConnectionProfile profile, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(profile);
        cancellationToken.ThrowIfCancellationRequested();
        ThrowIfDisposed();

        var builder = BuildConnectionStringBuilder(profile);
        SqlConnection? connection = null;
        SqlLoginCredentialLease? credentialLease = null;

        try
        {
            (connection, credentialLease) = await CreateConnectionAsync(profile, builder, cancellationToken)
                .ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            await _opener.OpenAsync(connection, cancellationToken).ConfigureAwait(false);

            var warnings = profile.TrustServerCertificate
                ? new[] { ConnectionWarning.TrustServerCertificateEnabled }
                : Array.Empty<ConnectionWarning>();

            return new SqlConnectionOpenResult(
                connection,
                warnings,
                credentialLease is null ? null : credentialLease.Release);
        }
        catch
        {
            if (connection is not null)
            {
                await connection.DisposeAsync().ConfigureAwait(false);
            }

            credentialLease?.Release();
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
        Lazy<Task<SqlLoginCredentialLease>>? lazyLease;
        lock (_credentialGate)
        {
            _credentialLeases.Remove(key, out lazyLease);
        }

        if (lazyLease is null || !lazyLease.IsValueCreated)
        {
            return;
        }

        var lease = await lazyLease.Value.ConfigureAwait(false);
        lease.Retire(_poolController, key.ConnectionString);
    }

    public void Dispose() => DisposeAsync().AsTask().GetAwaiter().GetResult();

    public async ValueTask DisposeAsync()
    {
        List<KeyValuePair<SqlLoginCredentialCacheKey, Lazy<Task<SqlLoginCredentialLease>>>> leases;
        lock (_credentialGate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            leases = [.. _credentialLeases];
            _credentialLeases.Clear();
        }

        foreach (var (key, lazyLease) in leases)
        {
            if (!lazyLease.IsValueCreated)
            {
                continue;
            }

            try
            {
                var lease = await lazyLease.Value.ConfigureAwait(false);
                lease.Retire(_poolController, key.ConnectionString);
            }
            catch
            {
                // A failed secret load owns no credential and is already removed
                // from the cache by OpenAsync, so factory shutdown can continue.
            }
        }
    }

    private async Task<(SqlConnection Connection, SqlLoginCredentialLease? CredentialLease)> CreateConnectionAsync(
        ConnectionProfile profile,
        SqlConnectionStringBuilder builder,
        CancellationToken cancellationToken)
    {
        switch (profile.Authentication)
        {
            case SqlLoginAuthenticationStrategy sqlLogin:
            {
                var lease = await RentSqlLoginCredentialAsync(profile, builder, sqlLogin, cancellationToken)
                    .ConfigureAwait(false);
                try
                {
                    return (new SqlConnection(builder.ConnectionString, lease.Credential), lease);
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
                var tokenCredential = await EntraTokenCredentialFactory
                    .CreateAsync(entra, GetSecretProvider(), cancellationToken)
                    .ConfigureAwait(false);

                var connection = new SqlConnection(builder.ConnectionString);
                connection.AccessTokenCallback = async (authParams, ct) =>
                {
                    var token = await tokenCredential
                        .GetTokenAsync(new TokenRequestContext(EntraDatabaseScope), ct)
                        .ConfigureAwait(false);
                    return new SqlAuthenticationToken(token.Token, token.ExpiresOn);
                };

                return (connection, null);
            }

            default:
                throw new AuthenticationConfigurationException(
                    $"Unhandled authentication strategy '{profile.Authentication.GetType().Name}'.");
        }
    }

    private async Task<SqlLoginCredentialLease> RentSqlLoginCredentialAsync(
        ConnectionProfile profile,
        SqlConnectionStringBuilder builder,
        SqlLoginAuthenticationStrategy authentication,
        CancellationToken cancellationToken)
    {
        var key = SqlLoginCredentialCacheKey.From(profile, builder, authentication);

        while (true)
        {
            Lazy<Task<SqlLoginCredentialLease>> lazyLease;
            lock (_credentialGate)
            {
                ThrowIfDisposed();
                if (!_credentialLeases.TryGetValue(key, out lazyLease!))
                {
                    lazyLease = new Lazy<Task<SqlLoginCredentialLease>>(
                        () => _credentialLeaseFactory.CreateAsync(authentication, CancellationToken.None),
                        LazyThreadSafetyMode.ExecutionAndPublication);
                    _credentialLeases.Add(key, lazyLease);
                }
            }

            SqlLoginCredentialLease lease;
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
                    if (_credentialLeases.TryGetValue(key, out var current) && ReferenceEquals(current, lazyLease))
                    {
                        _credentialLeases.Remove(key);
                    }
                }

                throw;
            }

            lock (_credentialGate)
            {
                ThrowIfDisposed();
                if (_credentialLeases.TryGetValue(key, out var current) && ReferenceEquals(current, lazyLease))
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
