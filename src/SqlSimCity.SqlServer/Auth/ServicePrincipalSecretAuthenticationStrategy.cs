using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer.Auth;

/// <summary>
/// Service principal authentication using a client secret. Maps only to
/// <c>Azure.Identity.ClientSecretCredential</c>. Included because the
/// deployment scope explicitly allows it, but
/// <see cref="ServicePrincipalCertificateAuthenticationStrategy"/> is the
/// stronger option and should be preferred for new deployments: a client
/// secret is an opaque string that Azure.Identity retains as a plain .NET
/// string for the process's lifetime and that this library cannot zero on
/// rotation, whereas a certificate's private key is not copied into a bare
/// string. The secret is never held as a plaintext field here -- only a
/// reference the secret provider resolves once per cached Entra security
/// context (profile plus tenant/client/secret reference), not once per
/// connection -- see <see cref="EntraCredentialLease"/>. Rotate a client
/// secret by calling <c>InvalidateEntraProfileAsync</c> after updating the
/// mounted secret file, or by restarting the process; without one of those,
/// a rotated secret is not observed.
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
