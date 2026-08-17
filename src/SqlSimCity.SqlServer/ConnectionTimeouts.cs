namespace SqlSimCity.SqlServer;

/// <summary>
/// Validated connect and command timeouts, in whole seconds, for one
/// connection profile.
/// </summary>
public sealed class ConnectionTimeouts
{
    public const int MinConnectSeconds = 1;
    public const int MaxConnectSeconds = 300;
    public const int MinCommandSeconds = 1;
    public const int MaxCommandSeconds = 3_600;

    public int ConnectTimeoutSeconds { get; }

    public int CommandTimeoutSeconds { get; }

    public ConnectionTimeouts(int connectTimeoutSeconds, int commandTimeoutSeconds)
    {
        if (connectTimeoutSeconds < MinConnectSeconds || connectTimeoutSeconds > MaxConnectSeconds)
        {
            throw new ConnectionProfileValidationException(
                $"{nameof(connectTimeoutSeconds)} must be between {MinConnectSeconds} and {MaxConnectSeconds}.");
        }

        if (commandTimeoutSeconds < MinCommandSeconds || commandTimeoutSeconds > MaxCommandSeconds)
        {
            throw new ConnectionProfileValidationException(
                $"{nameof(commandTimeoutSeconds)} must be between {MinCommandSeconds} and {MaxCommandSeconds}.");
        }

        ConnectTimeoutSeconds = connectTimeoutSeconds;
        CommandTimeoutSeconds = commandTimeoutSeconds;
    }
}
