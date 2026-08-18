namespace SqlSimCity.Api;

/// <summary>
/// Raised when <c>LiveIncidents:Mode</c> is <c>Connected</c> but the accompanying
/// <c>LiveIncidents:Connection</c> configuration is missing or invalid. Every message here is
/// built only from configuration section/key names and value types (never a resolved secret,
/// connection string, or server response), so this exception is always safe to log verbatim --
/// mirroring <c>ProtectedStorageConfigurationException</c> and <c>ConnectionProfileValidationException</c>.
/// </summary>
public sealed class LiveIncidentsConfigurationException : Exception
{
    public LiveIncidentsConfigurationException(string message)
        : base(message)
    {
    }

    public LiveIncidentsConfigurationException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
