namespace SqlSimCity.SqlServer.Auth;

/// <summary>
/// The Microsoft Entra ID authentication family. Every subtype is resolved by
/// <see cref="EntraTokenCredentialFactory"/> to one explicit, non-interactive
/// <c>Azure.Core.TokenCredential</c> and configured through
/// <c>SqlConnection.AccessTokenCallback</c>. The token scope is derived at
/// request time from <c>SqlAuthenticationParameters.Resource</c> (appending
/// <c>/.default</c> only when the resource doesn't already carry a scope
/// suffix), exactly as
/// <see href="https://learn.microsoft.com/sql/connect/ado-net/sql/azure-active-directory-authentication#using-accesstokencallback">
/// the official <c>AccessTokenCallback</c> example</see> does -- it is never a
/// hardcoded public-cloud <c>https://database.windows.net</c> literal, so
/// sovereign-cloud resources authenticate correctly. None of them use
/// <c>DefaultAzureCredential</c>, any other credential chain, or an
/// interactive/browser user flow -- this is a non-interactive service
/// identity only. The credential and its <c>AccessTokenCallback</c> delegate
/// are cached and reused per Entra security context by
/// <see cref="EntraCredentialLease"/>/<see cref="SqlConnectionFactory"/> so
/// that repeated opens for the same profile share one connection pool instead
/// of creating a new pool key -- and a new credential/secret read -- per call.
/// </summary>
public abstract class EntraAuthenticationStrategy : AuthenticationStrategy
{
    private protected EntraAuthenticationStrategy()
    {
    }

    private protected static Guid ValidateGuidField(string value, string fieldName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        if (!Guid.TryParse(value, out var parsed))
        {
            throw new AuthenticationConfigurationException($"{fieldName} must be a valid GUID.");
        }

        return parsed;
    }
}
