using System.Buffers;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;

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

    // SqlClient TCP routing/protocol syntax and other characters that would
    // let a host or instance name be misread as something other than a plain
    // identifier: comma (port separator), backslash (instance separator),
    // colon (protocol prefix or IPv6), slash, quotes, and brackets.
    private static readonly SearchValues<char> RoutingSyntaxCharacters =
        SearchValues.Create([',', '\\', ':', '/', '\'', '"', '[', ']']);

    // Mirrors SQL Server's own named-instance naming rule: must start with a
    // letter or underscore and contain only letters, digits, and underscores.
    private static readonly Regex InstanceNameShape = new("^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);

    public string Host { get; }

    public string? InstanceName { get; }

    public int? Port { get; }

    public ServerAddress(string host, string? instanceName = null, int? port = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(host);
        ConnectionValidation.EnsureNoControlCharacters(host, nameof(host));
        ConnectionValidation.EnsureNoConnectionStringFragment(host, nameof(host));
        ConnectionValidation.EnsureLength(host, nameof(host), 1, MaxHostLength);
        EnsureHostSyntax(host);

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
            EnsureInstanceNameSyntax(instanceName);
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

    private static void EnsureHostSyntax(string host)
    {
        if (host.Any(char.IsWhiteSpace))
        {
            throw new ConnectionProfileValidationException("host must not contain whitespace.");
        }

        var unbracketedHost = host.Trim('[', ']');
        if (IPAddress.TryParse(unbracketedHost, out var address) &&
            address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            throw new ConnectionProfileValidationException(
                "IPv6 host literals are not supported until their SqlClient TCP data-source syntax is implemented.");
        }

        if (host.IndexOfAny(RoutingSyntaxCharacters) >= 0)
        {
            throw new ConnectionProfileValidationException(
                "host must not embed a port, instance, protocol prefix, quote, bracket, or other SqlClient routing syntax; use port or instanceName instead.");
        }
    }

    private static void EnsureInstanceNameSyntax(string instanceName)
    {
        if (instanceName.Any(char.IsWhiteSpace) || instanceName.IndexOfAny(RoutingSyntaxCharacters) >= 0)
        {
            throw new ConnectionProfileValidationException(
                "instanceName must not contain whitespace or SqlClient routing syntax (',', '\\', ':', '/', quotes, or brackets).");
        }

        if (!InstanceNameShape.IsMatch(instanceName))
        {
            throw new ConnectionProfileValidationException(
                "instanceName must start with a letter or underscore and contain only letters, digits, and underscores.");
        }
    }
}

