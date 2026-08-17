namespace SqlSimCity.SqlServer;

/// <summary>
/// A validated SQL Server target: a host (name, FQDN, or IP literal) plus at
/// most one of a named instance or an explicit TCP port -- specifying both is
/// ambiguous about which one resolves the endpoint, so it is rejected rather
/// than silently preferring one.
/// </summary>
public sealed class ServerAddress
{
    private const int MaxHostLength = 255;
    private const int MaxInstanceNameLength = 128;
    public const int MinPort = 1;
    public const int MaxPort = 65535;

    public string Host { get; }

    public string? InstanceName { get; }

    public int? Port { get; }

    public ServerAddress(string host, string? instanceName = null, int? port = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(host);
        ConnectionValidation.EnsureNoControlCharacters(host, nameof(host));
        ConnectionValidation.EnsureNoConnectionStringFragment(host, nameof(host));
        ConnectionValidation.EnsureLength(host, nameof(host), 1, MaxHostLength);

        if (instanceName is not null && port is not null)
        {
            throw new ConnectionProfileValidationException(
                $"{nameof(instanceName)} and {nameof(port)} are mutually exclusive on a {nameof(ServerAddress)}.");
        }

        if (instanceName is not null)
        {
            ConnectionValidation.EnsureNoControlCharacters(instanceName, nameof(instanceName));
            ConnectionValidation.EnsureNoConnectionStringFragment(instanceName, nameof(instanceName));
            ConnectionValidation.EnsureLength(instanceName, nameof(instanceName), 1, MaxInstanceNameLength);
        }

        if (port is int p && (p < MinPort || p > MaxPort))
        {
            throw new ConnectionProfileValidationException($"{nameof(port)} must be between {MinPort} and {MaxPort}.");
        }

        Host = host;
        InstanceName = instanceName;
        Port = port;
    }

    /// <summary>
    /// Renders the SqlClient `Data Source` TCP form: <c>tcp:host,port</c> when a
    /// port is set, <c>host\instance</c> when a named instance is set, or the
    /// bare host otherwise (default instance, default port).
    /// </summary>
    public string ToDataSource() => Port is int port
        ? $"tcp:{Host},{port}"
        : InstanceName is { } instance
            ? $"{Host}\\{instance}"
            : Host;
}
