namespace SqlSimCity.SqlServer.Auth;

/// <summary>
/// The Microsoft Entra ID authentication family. Every subtype is resolved by
/// <see cref="EntraTokenCredentialFactory"/> to one explicit, non-interactive
/// <c>Azure.Core.TokenCredential</c> and configured through
/// <c>SqlConnection.AccessTokenCallback</c> for the
/// <c>https://database.windows.net/.default</c> scope. None of them use
/// <c>DefaultAzureCredential</c>, any other credential chain, or an
/// interactive/browser user flow -- this is a non-interactive service
/// identity only.
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
