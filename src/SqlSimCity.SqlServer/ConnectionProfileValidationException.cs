namespace SqlSimCity.SqlServer;

/// <summary>
/// A connection profile field failed validation. Messages describe the field
/// and the rule broken; they never echo the raw operator-supplied value, which
/// could itself carry connection-string syntax or other unwanted content.
/// </summary>
public sealed class ConnectionProfileValidationException : Exception
{
    public ConnectionProfileValidationException(string message)
        : base(message)
    {
    }

    public ConnectionProfileValidationException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
