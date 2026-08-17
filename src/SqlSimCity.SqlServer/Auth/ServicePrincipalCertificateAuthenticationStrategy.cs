using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer.Auth;

/// <summary>
/// Service principal authentication using a client certificate (PKCS#12/PFX).
/// Maps only to <c>Azure.Identity.ClientCertificateCredential</c>. The
/// certificate bytes and its optional PFX password are resolved once per
/// connection attempt through <c>ISecretFileProvider</c>; this type never holds
/// plaintext certificate or password material itself, only references.
/// </summary>
public sealed class ServicePrincipalCertificateAuthenticationStrategy : EntraAuthenticationStrategy
{
    public Guid TenantId { get; }

    public Guid ClientId { get; }

    public SecretFileReference CertificateSecretReference { get; }

    public SecretFileReference? CertificatePasswordSecretReference { get; }

    public ServicePrincipalCertificateAuthenticationStrategy(
        string tenantId,
        string clientId,
        SecretFileReference certificateSecretReference,
        SecretFileReference? certificatePasswordSecretReference = null)
    {
        TenantId = ValidateGuidField(tenantId, nameof(tenantId));
        ClientId = ValidateGuidField(clientId, nameof(clientId));
        CertificateSecretReference = certificateSecretReference;
        CertificatePasswordSecretReference = certificatePasswordSecretReference;
    }
}
