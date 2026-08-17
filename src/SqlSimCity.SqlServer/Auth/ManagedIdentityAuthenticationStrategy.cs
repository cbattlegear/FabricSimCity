namespace SqlSimCity.SqlServer.Auth;

/// <summary>
/// Azure managed identity authentication: system-assigned when
/// <see cref="UserAssignedClientId"/> is <c>null</c>, or the named
/// user-assigned identity otherwise. Maps only to
/// <c>Azure.Identity.ManagedIdentityCredential</c>; never
/// <c>DefaultAzureCredential</c>.
/// </summary>
public sealed class ManagedIdentityAuthenticationStrategy : EntraAuthenticationStrategy
{
    public Guid? UserAssignedClientId { get; }

    public ManagedIdentityAuthenticationStrategy(string? userAssignedClientId = null)
    {
        UserAssignedClientId = userAssignedClientId is null
            ? null
            : ValidateGuidField(userAssignedClientId, nameof(userAssignedClientId));
    }
}
