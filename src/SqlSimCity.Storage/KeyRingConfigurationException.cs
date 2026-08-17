namespace SqlSimCity.Storage;

/// <summary>
/// The configured key ring file is missing, unreadable, malformed, or declares
/// duplicate/missing/invalid key versions or key lengths. Messages never
/// include key material or file contents, only structural facts.
/// </summary>
public sealed class KeyRingConfigurationException : Exception
{
    public KeyRingConfigurationException(string message)
        : base(message)
    {
    }

    public KeyRingConfigurationException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
