namespace SqlSimCity.SqlServer.Auth;

/// <summary>
/// Kubernetes/AKS workload identity federation. Maps only to
/// <c>Azure.Identity.WorkloadIdentityCredential</c>, which itself re-reads the
/// projected federated token file on every token request, so this library does
/// nothing extra to handle token rotation. <see cref="FederatedTokenFilePath"/>
/// overrides the platform-provided <c>AZURE_FEDERATED_TOKEN_FILE</c> path only
/// when explicitly configured; it is a file path, never secret content.
/// </summary>
public sealed class WorkloadIdentityAuthenticationStrategy : EntraAuthenticationStrategy
{
    private const int MaxPathLength = 4_096;

    public Guid TenantId { get; }

    public Guid ClientId { get; }

    public string? FederatedTokenFilePath { get; }

    public WorkloadIdentityAuthenticationStrategy(string tenantId, string clientId, string? federatedTokenFilePath = null)
    {
        TenantId = ValidateGuidField(tenantId, nameof(tenantId));
        ClientId = ValidateGuidField(clientId, nameof(clientId));

        if (federatedTokenFilePath is not null)
        {
            ConnectionValidation.EnsureNoControlCharacters(federatedTokenFilePath, nameof(federatedTokenFilePath));
            ConnectionValidation.EnsureLength(federatedTokenFilePath, nameof(federatedTokenFilePath), 1, MaxPathLength);
        }

        FederatedTokenFilePath = federatedTokenFilePath;
    }
}
