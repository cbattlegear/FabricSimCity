namespace SqlSimCity.Storage;

/// <summary>
/// Protected storage is enabled but its configuration is unusable: a missing data
/// directory, a database file name that is not a simple file name, or a retention
/// window that is not positive. Messages carry structural facts only, never file
/// contents.
/// </summary>
public sealed class ProtectedStorageConfigurationException : Exception
{
    public ProtectedStorageConfigurationException(string message)
        : base(message)
    {
    }

    public ProtectedStorageConfigurationException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
