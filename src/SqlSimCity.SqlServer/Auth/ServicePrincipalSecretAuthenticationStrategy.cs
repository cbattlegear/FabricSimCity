using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer.Auth;

/// <summary>
/// Service principal authentication using a client secret. Maps only to
/// <c>Azure.Identity.ClientSecretCredential</c>. Included because the
/// deployment scope explicitly allows it, but
/// <see cref="ServicePrincipalCertificateAuthenticationStrategy"/> is the
/// stronger option and should be preferred for new deployments. The secret is
/// never held as a plaintext field here -- only a reference the secret
/// provider resolves once per connection attempt.
/// </summary>
public sealed class ServicePrincipalSecretAuthenticationStrategy : EntraAuthenticationStrategy
{
    public Guid TenantId { get; }

    public Guid ClientId { get; }

    public SecretFileReference ClientSecretReference { get; }

    public ServicePrincipalSecretAuthenticationStrategy(string tenantId, string clientId, SecretFileReference clientSecretReference)
    {
        TenantId = ValidateGuidField(tenantId, nameof(tenantId));
        ClientId = ValidateGuidField(clientId, nameof(clientId));
        ClientSecretReference = clientSecretReference;
    }
}
