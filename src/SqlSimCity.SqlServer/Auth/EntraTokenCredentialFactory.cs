using System.Security.Cryptography.X509Certificates;
using Azure.Core;
using Azure.Identity;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer.Auth;

/// <summary>
/// Maps a closed <see cref="EntraAuthenticationStrategy"/> to an explicit,
/// non-interactive <see cref="TokenCredential"/>. This is the only place a
/// credential type is selected for Entra authentication; it never constructs
/// <c>DefaultAzureCredential</c> or any credential chain, and every branch maps
/// to exactly one specific credential type.
/// </summary>
internal static class EntraTokenCredentialFactory
{
    public static async Task<TokenCredential> CreateAsync(
        EntraAuthenticationStrategy strategy,
        ISecretFileProvider secretProvider,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(strategy);
        ArgumentNullException.ThrowIfNull(secretProvider);

        return strategy switch
        {
            ManagedIdentityAuthenticationStrategy managedIdentity => CreateManagedIdentityCredential(managedIdentity),
            WorkloadIdentityAuthenticationStrategy workloadIdentity => CreateWorkloadIdentityCredential(workloadIdentity),
            ServicePrincipalCertificateAuthenticationStrategy certificate =>
                await CreateCertificateCredentialAsync(certificate, secretProvider, cancellationToken).ConfigureAwait(false),
            ServicePrincipalSecretAuthenticationStrategy secret =>
                await CreateSecretCredentialAsync(secret, secretProvider, cancellationToken).ConfigureAwait(false),
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

    private static async Task<TokenCredential> CreateCertificateCredentialAsync(
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

        return new ClientCertificateCredential(strategy.TenantId.ToString(), strategy.ClientId.ToString(), certificate);
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
        // library's own temporary buffer is still cleared immediately after.
        var clientSecret = secretBytes.UseAsUtf8Text(text => new string(text));
        return new ClientSecretCredential(strategy.TenantId.ToString(), strategy.ClientId.ToString(), clientSecret);
    }
}
