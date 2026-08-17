using System.Security.Cryptography.X509Certificates;
using Azure.Core;
using Microsoft.Data.SqlClient;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer;

internal interface IEntraCredentialLeaseFactory
{
    Task<EntraCredentialLease> CreateAsync(
        EntraAuthenticationStrategy authentication,
        CancellationToken cancellationToken);
}

/// <summary>
/// Resolves one <see cref="EntraCredentialMaterial"/> through
/// <see cref="EntraTokenCredentialFactory"/> and wraps it in an
/// <see cref="EntraCredentialLease"/>. The secret provider is resolved lazily
/// through <paramref name="secretProviderAccessor"/> so constructing a
/// <see cref="SqlConnectionFactory"/> without one never fails until an Entra
/// profile is actually opened.
/// </summary>
internal sealed class DefaultEntraCredentialLeaseFactory : IEntraCredentialLeaseFactory
{
    private readonly Func<ISecretFileProvider> _secretProviderAccessor;

    public DefaultEntraCredentialLeaseFactory(Func<ISecretFileProvider> secretProviderAccessor)
    {
        ArgumentNullException.ThrowIfNull(secretProviderAccessor);
        _secretProviderAccessor = secretProviderAccessor;
    }

    public async Task<EntraCredentialLease> CreateAsync(
        EntraAuthenticationStrategy authentication,
        CancellationToken cancellationToken)
    {
        var secretProvider = _secretProviderAccessor();
        var material = await EntraTokenCredentialFactory
            .CreateAsync(authentication, secretProvider, cancellationToken)
            .ConfigureAwait(false);
        return new EntraCredentialLease(material.Credential, material.OwnedCertificate);
    }
}

/// <summary>
/// Owns one Entra <see cref="TokenCredential"/>, its <see cref="Callback"/>
/// <c>AccessTokenCallback</c> delegate, and any owned
/// <see cref="X509Certificate2"/> for as long as its SqlClient pool can open
/// physical connections. <see cref="Callback"/> is created exactly once, in
/// the constructor, and every connection using this lease is assigned the
/// same delegate instance -- required because <c>AccessTokenCallback</c> is
/// itself part of SqlClient's connection pool key (see
/// <see href="https://learn.microsoft.com/sql/connect/ado-net/sql/azure-active-directory-authentication#using-accesstokencallback">
/// the official documentation</see>): a fresh delegate per connection would
/// silently open one pool per connection instead of sharing one pool per
/// security context. Retirement clears the pool before disposing the owned
/// certificate, and defers disposal while returned results use it, mirroring
/// <see cref="SqlLoginCredentialLease"/>. If the pool clear itself fails, the
/// certificate is deliberately kept valid (fail-closed) and the failure
/// propagates to the caller instead of being swallowed -- see
/// <see cref="Retire"/>.
/// </summary>
internal sealed class EntraCredentialLease : IDisposable, IPooledCredentialLease
{
    private const string DefaultScopeSuffix = "/.default";

    private readonly object _gate = new();
    private X509Certificate2? _ownedCertificate;
    private int _activeConnections;
    private bool _retired;
    private bool _disposed;

    public EntraCredentialLease(TokenCredential credential, X509Certificate2? ownedCertificate)
    {
        ArgumentNullException.ThrowIfNull(credential);
        Credential = credential;
        _ownedCertificate = ownedCertificate;
        Callback = GetTokenAsync;
    }

    public TokenCredential Credential { get; }

    /// <summary>
    /// The single, reused <c>SqlConnection.AccessTokenCallback</c> delegate
    /// for this lease. Every <see cref="SqlConnection"/> built from this
    /// lease must be assigned this exact instance (see class remarks).
    /// </summary>
    public Func<SqlAuthenticationParameters, CancellationToken, Task<SqlAuthenticationToken>> Callback { get; }

    internal bool IsDisposed
    {
        get
        {
            lock (_gate)
            {
                return _disposed;
            }
        }
    }

    public void Rent()
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            _activeConnections++;
        }
    }

    public void Release()
    {
        lock (_gate)
        {
            if (_activeConnections == 0)
            {
                throw new InvalidOperationException("Entra credential lease released more times than it was rented.");
            }

            _activeConnections--;
            DisposeIfRetiredAndUnused();
        }
    }

    /// <summary>
    /// Clears this lease's SqlClient pool, then disposes the owned
    /// certificate (if any) once no returned result is still using it. If
    /// <paramref name="poolController"/> throws, this lease is left exactly
    /// as it was -- not marked retired, and the certificate not disposed --
    /// so a lingering pool that could not be cleared is never paired with a
    /// credential someone might try to reuse after its certificate was
    /// disposed. The exception propagates to the caller, which must not
    /// swallow it: see <see cref="SqlConnectionFactory.DisposeAsync"/> and
    /// <see cref="SqlConnectionFactory.InvalidateEntraProfileAsync"/>.
    /// </summary>
    public void Retire(ISqlConnectionPoolController poolController, string connectionString)
    {
        ArgumentNullException.ThrowIfNull(poolController);
        ArgumentNullException.ThrowIfNull(connectionString);

        lock (_gate)
        {
            if (_retired)
            {
                return;
            }
        }

        using (var connection = new SqlConnection(connectionString) { AccessTokenCallback = Callback })
        {
            poolController.ClearPool(connection);
        }

        lock (_gate)
        {
            _retired = true;
            DisposeIfRetiredAndUnused();
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _retired = true;
            DisposeIfRetiredAndUnused();
        }
    }

    private void DisposeIfRetiredAndUnused()
    {
        if (!_retired || _activeConnections != 0 || _disposed)
        {
            return;
        }

        _ownedCertificate?.Dispose();
        _ownedCertificate = null;
        _disposed = true;
    }

    /// <summary>
    /// Derives the token scope from <c>authParams.Resource</c> exactly as the
    /// official <c>AccessTokenCallback</c> example does -- appending
    /// <c>/.default</c> only when the resource doesn't already carry a scope
    /// suffix -- rather than a hardcoded public-cloud
    /// <c>https://database.windows.net/.default</c> literal, so sovereign
    /// cloud resources (for example Azure Government or Azure China) resolve
    /// to their own resource's scope. Every other <c>SqlAuthenticationParameters</c>
    /// field (<c>Authority</c>, <c>UserId</c>, <c>ConnectionId</c>, etc.) is
    /// intentionally ignored: the explicit <see cref="AuthenticationStrategy"/>
    /// already fixes tenant, client, and identity, and honoring a
    /// server-supplied override of those from connection parameters would let
    /// the server -- not the profile -- choose the security context.
    /// </summary>
    private async Task<SqlAuthenticationToken> GetTokenAsync(
        SqlAuthenticationParameters authParams,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(authParams);

        var resource = authParams.Resource;
        var scope = resource.EndsWith(DefaultScopeSuffix, StringComparison.Ordinal)
            ? resource
            : resource + DefaultScopeSuffix;

        var token = await Credential
            .GetTokenAsync(new TokenRequestContext([scope]), cancellationToken)
            .ConfigureAwait(false);
        return new SqlAuthenticationToken(token.Token, token.ExpiresOn);
    }
}

/// <summary>
/// Keys the Entra credential/callback cache by the stable connection security
/// context: profile id, connection string, and every identifier or secret
/// reference that determines which identity a strategy authenticates as.
/// Two profiles with different managed identities, tenants, clients, or
/// certificate/secret references always produce different keys and therefore
/// never share a credential or callback.
/// </summary>
internal readonly record struct EntraCredentialCacheKey(
    string ProfileId,
    string ConnectionString,
    Type StrategyType,
    Guid? UserAssignedClientId,
    Guid? TenantId,
    Guid? ClientId,
    string? FederatedTokenFilePath,
    string? CertificateSecretFileName,
    string? CertificatePasswordSecretFileName,
    string? ClientSecretFileName)
{
    public static EntraCredentialCacheKey From(
        ConnectionProfile profile,
        SqlConnectionStringBuilder builder,
        EntraAuthenticationStrategy authentication) => authentication switch
    {
        ManagedIdentityAuthenticationStrategy managedIdentity => new EntraCredentialCacheKey(
            profile.Id.Value,
            builder.ConnectionString,
            typeof(ManagedIdentityAuthenticationStrategy),
            managedIdentity.UserAssignedClientId,
            TenantId: null,
            ClientId: null,
            FederatedTokenFilePath: null,
            CertificateSecretFileName: null,
            CertificatePasswordSecretFileName: null,
            ClientSecretFileName: null),
        WorkloadIdentityAuthenticationStrategy workloadIdentity => new EntraCredentialCacheKey(
            profile.Id.Value,
            builder.ConnectionString,
            typeof(WorkloadIdentityAuthenticationStrategy),
            UserAssignedClientId: null,
            workloadIdentity.TenantId,
            workloadIdentity.ClientId,
            workloadIdentity.FederatedTokenFilePath,
            CertificateSecretFileName: null,
            CertificatePasswordSecretFileName: null,
            ClientSecretFileName: null),
        ServicePrincipalCertificateAuthenticationStrategy certificate => new EntraCredentialCacheKey(
            profile.Id.Value,
            builder.ConnectionString,
            typeof(ServicePrincipalCertificateAuthenticationStrategy),
            UserAssignedClientId: null,
            certificate.TenantId,
            certificate.ClientId,
            FederatedTokenFilePath: null,
            certificate.CertificateSecretReference.FileName,
            certificate.CertificatePasswordSecretReference?.FileName,
            ClientSecretFileName: null),
        ServicePrincipalSecretAuthenticationStrategy secret => new EntraCredentialCacheKey(
            profile.Id.Value,
            builder.ConnectionString,
            typeof(ServicePrincipalSecretAuthenticationStrategy),
            UserAssignedClientId: null,
            secret.TenantId,
            secret.ClientId,
            FederatedTokenFilePath: null,
            CertificateSecretFileName: null,
            CertificatePasswordSecretFileName: null,
            secret.ClientSecretReference.FileName),
        _ => throw new AuthenticationConfigurationException(
            $"Unhandled Entra authentication strategy '{authentication.GetType().Name}'."),
    };
}
