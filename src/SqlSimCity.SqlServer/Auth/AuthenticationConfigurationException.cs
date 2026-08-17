namespace SqlSimCity.SqlServer.Auth;

/// <summary>
/// An authentication strategy field failed validation -- for example a
/// malformed tenant or client GUID, or an unrecognized strategy type reaching
/// a switch that is meant to be exhaustive. Messages never include secret
/// content.
/// </summary>
public sealed class AuthenticationConfigurationException : Exception
{
    public AuthenticationConfigurationException(string message)
        : base(message)
    {
    }

    public AuthenticationConfigurationException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
