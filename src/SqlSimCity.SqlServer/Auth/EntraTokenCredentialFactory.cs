using System.Security.Cryptography.X509Certificates;
using Azure.Core;
using Azure.Identity;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer.Auth;

/// <summary>
/// Maps a closed <see cref="EntraAuthenticationStrategy"/> to an explicit,
/// non-interactive <see cref="TokenCredential"/> plus any disposable material
/// this factory alone allocated for it. This is the only place a credential
/// type is selected for Entra authentication; it never constructs
/// <c>DefaultAzureCredential</c> or any credential chain, and every branch maps
/// to exactly one specific credential type. Callers -- in practice
/// <see cref="EntraCredentialLease"/> -- own the returned
/// <see cref="EntraCredentialMaterial.OwnedCertificate"/> and must dispose it
/// once the credential is safely retired, not once per connection: this
/// factory is invoked once per cached Entra security context, not once per
/// <c>SqlConnection</c>.
/// </summary>
internal static class EntraTokenCredentialFactory
{
    public static async Task<EntraCredentialMaterial> CreateAsync(
        EntraAuthenticationStrategy strategy,
        ISecretFileProvider secretProvider,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(strategy);
        ArgumentNullException.ThrowIfNull(secretProvider);

        return strategy switch
        {
            ManagedIdentityAuthenticationStrategy managedIdentity =>
                new EntraCredentialMaterial(CreateManagedIdentityCredential(managedIdentity), OwnedCertificate: null),
            WorkloadIdentityAuthenticationStrategy workloadIdentity =>
                new EntraCredentialMaterial(CreateWorkloadIdentityCredential(workloadIdentity), OwnedCertificate: null),
            ServicePrincipalCertificateAuthenticationStrategy certificate =>
                await CreateCertificateCredentialMaterialAsync(certificate, secretProvider, cancellationToken).ConfigureAwait(false),
            ServicePrincipalSecretAuthenticationStrategy secret =>
                new EntraCredentialMaterial(
                    await CreateSecretCredentialAsync(secret, secretProvider, cancellationToken).ConfigureAwait(false),
                    OwnedCertificate: null),
            _ => throw new AuthenticationConfigurationException(
                $"Unhandled Entra authentication strategy '{strategy.GetType().Name}'."),
        };
    }

    private static ManagedIdentityCredential CreateManagedIdentityCredential(ManagedIdentityAuthenticationStrategy strategy)
    {
        var id = strategy.UserAssignedClientId is { } clientId
            ? ManagedIdentityId.FromUserAssignedClientId(clientId.ToString())
            : ManagedIdentityId.SystemAssigned;
        return new ManagedIdentityCredential(id);
    }

    private static WorkloadIdentityCredential CreateWorkloadIdentityCredential(WorkloadIdentityAuthenticationStrategy strategy) =>
        new(new WorkloadIdentityCredentialOptions
        {
            TenantId = strategy.TenantId.ToString(),
            ClientId = strategy.ClientId.ToString(),
            TokenFilePath = strategy.FederatedTokenFilePath,
        });

    private static async Task<EntraCredentialMaterial> CreateCertificateCredentialMaterialAsync(
        ServicePrincipalCertificateAuthenticationStrategy strategy,
        ISecretFileProvider secretProvider,
        CancellationToken cancellationToken)
    {
        using var certificateBytes = await secretProvider
            .ReadAsync(strategy.CertificateSecretReference, cancellationToken)
            .ConfigureAwait(false);

        X509Certificate2 certificate;
        if (strategy.CertificatePasswordSecretReference is { } passwordReference)
        {
            using var passwordBytes = await secretProvider.ReadAsync(passwordReference, cancellationToken).ConfigureAwait(false);
            certificate = passwordBytes.UseAsUtf8Text(password =>
                X509CertificateLoader.LoadPkcs12(certificateBytes.Span, password));
        }
        else
        {
            certificate = X509CertificateLoader.LoadPkcs12(certificateBytes.Span, ReadOnlySpan<char>.Empty);
        }

        try
        {
            // ClientCertificateCredential is not IDisposable and Azure.Identity
            // never disposes the certificate it was given, so this factory's
            // caller (EntraCredentialLease) owns `certificate` and must dispose
            // it once the credential is safely retired.
            var credential = new ClientCertificateCredential(strategy.TenantId.ToString(), strategy.ClientId.ToString(), certificate);
            return new EntraCredentialMaterial(credential, certificate);
        }
        catch
        {
            certificate.Dispose();
            throw;
        }
    }

    private static async Task<TokenCredential> CreateSecretCredentialAsync(
        ServicePrincipalSecretAuthenticationStrategy strategy,
        ISecretFileProvider secretProvider,
        CancellationToken cancellationToken)
    {
        using var secretBytes = await secretProvider.ReadAsync(strategy.ClientSecretReference, cancellationToken).ConfigureAwait(false);

        // ClientSecretCredential's public constructor only accepts a `string`
        // client secret; Azure.Identity retains it internally to send in HTTPS
        // token requests, so materializing a string here is unavoidable. This
        // library's own temporary buffer is still cleared immediately after,
        // but the resulting .NET string is immutable and cannot be zeroed --
        // it is pinned in memory for the lifetime of the process's string
        // pool/GC and until process exit for `ServicePrincipalCertificate`'s
        // stronger, non-string PFX private key. Prefer the certificate
        // strategy for new deployments for this reason. Rotating a client
        // secret requires an explicit `InvalidateEntraProfileAsync` call (or a
        // process restart) before a new secret takes effect, exactly like SQL
        // login password rotation.
        var clientSecret = secretBytes.UseAsUtf8Text(text => new string(text));
        return new ClientSecretCredential(strategy.TenantId.ToString(), strategy.ClientId.ToString(), clientSecret);
    }
}

/// <summary>
/// One Entra <see cref="TokenCredential"/> plus any disposable material this
/// factory alone allocated to construct it. <see cref="OwnedCertificate"/> is
/// non-null only for <see cref="ServicePrincipalCertificateAuthenticationStrategy"/>,
/// since <see cref="TokenCredential"/> itself is never <see cref="IDisposable"/>
/// -- the certificate is the only disposable secret material this library
/// must retire explicitly.
/// </summary>
internal sealed record EntraCredentialMaterial(TokenCredential Credential, X509Certificate2? OwnedCertificate);
