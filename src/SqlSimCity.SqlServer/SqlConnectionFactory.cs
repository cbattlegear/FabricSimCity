using Azure.Core;
using Microsoft.Data.SqlClient;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer;

/// <summary>
/// Builds every connection through <see cref="SqlConnectionStringBuilder"/>
/// only, then applies exactly one authentication strategy with no fallback to
/// another on failure. SQL login passwords are handed to <see cref="SqlCredential"/>,
/// never concatenated into the connection string; Entra strategies configure
/// <see cref="SqlConnection.AccessTokenCallback"/> with an explicit
/// <see cref="TokenCredential"/> (see <see cref="EntraTokenCredentialFactory"/>)
/// and the resulting token never appears in the connection string or any
/// log/exception produced by this library.
/// </summary>
public sealed class SqlConnectionFactory : ISqlConnectionFactory
{
    private static readonly string[] EntraDatabaseScope = ["https://database.windows.net/.default"];

    private readonly ISecretFileProvider _secretProvider;
    private readonly ISqlConnectionOpener _opener;

    public SqlConnectionFactory(ISecretFileProvider secretProvider)
        : this(secretProvider, new DefaultSqlConnectionOpener())
    {
    }

    public SqlConnectionFactory(ISecretFileProvider secretProvider, ISqlConnectionOpener opener)
    {
        ArgumentNullException.ThrowIfNull(secretProvider);
        ArgumentNullException.ThrowIfNull(opener);
        _secretProvider = secretProvider;
        _opener = opener;
    }

    public async Task<SqlConnectionOpenResult> OpenAsync(ConnectionProfile profile, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(profile);
        cancellationToken.ThrowIfCancellationRequested();

        var builder = BuildConnectionStringBuilder(profile);
        System.Security.SecureString? securePassword = null;

        try
        {
            var connection = await CreateConnectionAsync(profile, builder, sp => securePassword = sp, cancellationToken)
                .ConfigureAwait(false);

            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                await _opener.OpenAsync(connection, cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                await connection.DisposeAsync().ConfigureAwait(false);
                throw;
            }

            var warnings = profile.TrustServerCertificate
                ? new[] { ConnectionWarning.TrustServerCertificateEnabled }
                : Array.Empty<ConnectionWarning>();

            return new SqlConnectionOpenResult(connection, warnings);
        }
        finally
        {
            securePassword?.Dispose();
        }
    }

    private async Task<SqlConnection> CreateConnectionAsync(
        ConnectionProfile profile,
        SqlConnectionStringBuilder builder,
        Action<System.Security.SecureString> onSecurePasswordCreated,
        CancellationToken cancellationToken)
    {
        switch (profile.Authentication)
        {
            case SqlLoginAuthenticationStrategy sqlLogin:
            {
                System.Security.SecureString securePassword;
                using (var passwordBytes = await _secretProvider
                    .ReadAsync(sqlLogin.PasswordSecretReference, cancellationToken)
                    .ConfigureAwait(false))
                {
                    securePassword = passwordBytes.ToUtf8SecureString();
                }

                onSecurePasswordCreated(securePassword);
                var credential = new SqlCredential(sqlLogin.Username, securePassword);
                return new SqlConnection(builder.ConnectionString, credential);
            }

            case KerberosAuthenticationStrategy:
                builder.IntegratedSecurity = true;
                return new SqlConnection(builder.ConnectionString);

            case EntraAuthenticationStrategy entra:
            {
                var tokenCredential = await EntraTokenCredentialFactory
                    .CreateAsync(entra, _secretProvider, cancellationToken)
                    .ConfigureAwait(false);

                var connection = new SqlConnection(builder.ConnectionString);
                connection.AccessTokenCallback = async (authParams, ct) =>
                {
                    var token = await tokenCredential
                        .GetTokenAsync(new TokenRequestContext(EntraDatabaseScope), ct)
                        .ConfigureAwait(false);
                    return new SqlAuthenticationToken(token.Token, token.ExpiresOn);
                };

                return connection;
            }

            default:
                throw new AuthenticationConfigurationException(
                    $"Unhandled authentication strategy '{profile.Authentication.GetType().Name}'.");
        }
    }

    /// <summary>
    /// Builds the connection string in isolation from authentication so it can
    /// be unit tested without a secret provider or network access. Always sets
    /// <c>Encrypt</c> explicitly, <c>TrustServerCertificate</c> only from the
    /// profile's own opt-in, <c>PersistSecurityInfo=false</c>,
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
