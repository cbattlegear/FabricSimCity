using System.Globalization;

namespace SqlSimCity.Edge.Connector;

/// <summary>
/// Immutable, validated connector configuration. Values come from environment variables (or a small
/// JSON file); secrets are never configuration values — only file paths are configured, and the
/// bytes are read from those files at use time. HTTP is refused unless the endpoint is an explicit
/// loopback development address.
/// </summary>
public sealed record ConnectorOptions
{
    public required string ConnectorId { get; init; }
    public required string TargetId { get; init; }
    public required string KeyId { get; init; }
    public required Uri IngestEndpoint { get; init; }

    /// <summary>Path to the per-connector HMAC secret (base64, at least 32 bytes) file or Docker secret.</summary>
    public required string SigningSecretFile { get; init; }

    /// <summary>Directory holding the encrypted spool.</summary>
    public required string SpoolDirectory { get; init; }

    /// <summary>Path to the spool AES-256 key file (separate from the signing secret).</summary>
    public required string SpoolKeyFile { get; init; }

    /// <summary>Directory containing the validated V1 fixtures the connector packages as observations.</summary>
    public required string FixturesDirectory { get; init; }

    public TimeSpan CollectInterval { get; init; } = TimeSpan.FromSeconds(15);
    public TimeSpan DeliverInterval { get; init; } = TimeSpan.FromSeconds(5);
    public bool AllowLoopbackHttp { get; init; }

    /// <summary>Optional loopback-only health port. 0 disables it. Never a control API.</summary>
    public int LoopbackHealthPort { get; init; }

    public long SpoolMaxBytes { get; init; } = 64L * 1024 * 1024;
    public int SpoolMaxItems { get; init; } = 4096;
    public TimeSpan SpoolMaxAge { get; init; } = TimeSpan.FromHours(24);

    public void Validate()
    {
        RequireNonEmpty(ConnectorId, nameof(ConnectorId));
        RequireNonEmpty(TargetId, nameof(TargetId));
        RequireNonEmpty(KeyId, nameof(KeyId));
        RequireNonEmpty(SigningSecretFile, nameof(SigningSecretFile));
        RequireNonEmpty(SpoolDirectory, nameof(SpoolDirectory));
        RequireNonEmpty(SpoolKeyFile, nameof(SpoolKeyFile));
        RequireNonEmpty(FixturesDirectory, nameof(FixturesDirectory));
        ArgumentNullException.ThrowIfNull(IngestEndpoint);
        if (!IngestEndpoint.IsAbsoluteUri)
            throw new ConnectorConfigurationException("SQLSIMCITY_EDGE_INGEST_ENDPOINT must be an absolute URI.");
        if (CollectInterval < TimeSpan.FromSeconds(1) || CollectInterval > TimeSpan.FromHours(1))
            throw new ConnectorConfigurationException("Collect interval must be between 1 second and 1 hour.");
        if (DeliverInterval < TimeSpan.FromSeconds(1) || DeliverInterval > TimeSpan.FromHours(1))
            throw new ConnectorConfigurationException("Deliver interval must be between 1 second and 1 hour.");
        if (LoopbackHealthPort is < 0 or > 65535)
            throw new ConnectorConfigurationException("Loopback health port must be between 0 and 65535.");
    }

    /// <summary>Reads options from environment variables prefixed <c>SQLSIMCITY_EDGE_</c>.</summary>
    public static ConnectorOptions FromEnvironment(IReadOnlyDictionary<string, string?> env)
    {
        ArgumentNullException.ThrowIfNull(env);
        string? Get(string key) => env.TryGetValue("SQLSIMCITY_EDGE_" + key, out var value) ? value : null;

        var options = new ConnectorOptions
        {
            ConnectorId = Get("CONNECTOR_ID") ?? throw Missing("CONNECTOR_ID"),
            TargetId = Get("TARGET_ID") ?? throw Missing("TARGET_ID"),
            KeyId = Get("KEY_ID") ?? throw Missing("KEY_ID"),
            IngestEndpoint = new Uri(Get("INGEST_ENDPOINT") ?? throw Missing("INGEST_ENDPOINT"), UriKind.Absolute),
            SigningSecretFile = Get("SIGNING_SECRET_FILE") ?? throw Missing("SIGNING_SECRET_FILE"),
            SpoolDirectory = Get("SPOOL_DIR") ?? throw Missing("SPOOL_DIR"),
            SpoolKeyFile = Get("SPOOL_KEY_FILE") ?? throw Missing("SPOOL_KEY_FILE"),
            FixturesDirectory = Get("FIXTURES_DIR") ?? throw Missing("FIXTURES_DIR"),
            CollectInterval = ParseSeconds(Get("COLLECT_INTERVAL_SECONDS"), 15),
            DeliverInterval = ParseSeconds(Get("DELIVER_INTERVAL_SECONDS"), 5),
            AllowLoopbackHttp = ParseBool(Get("ALLOW_LOOPBACK_HTTP")),
            LoopbackHealthPort = ParseInt(Get("LOOPBACK_HEALTH_PORT"), 0),
            SpoolMaxBytes = ParseLong(Get("SPOOL_MAX_BYTES"), 64L * 1024 * 1024),
            SpoolMaxItems = ParseInt(Get("SPOOL_MAX_ITEMS"), 4096),
            SpoolMaxAge = ParseSeconds(Get("SPOOL_MAX_AGE_SECONDS"), 24 * 3600),
        };

        options.Validate();
        return options;
    }

    private static ConnectorConfigurationException Missing(string key)
        => new($"Required environment variable SQLSIMCITY_EDGE_{key} is not set.");

    private static void RequireNonEmpty(string value, string name)
    {
        if (string.IsNullOrWhiteSpace(value))
            throw new ConnectorConfigurationException($"{name} must be configured.");
    }

    private static TimeSpan ParseSeconds(string? value, int fallback)
        => TimeSpan.FromSeconds(ParseInt(value, fallback));

    private static int ParseInt(string? value, int fallback)
        => int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : fallback;

    private static long ParseLong(string? value, long fallback)
        => long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : fallback;

    private static bool ParseBool(string? value)
        => bool.TryParse(value, out var parsed) && parsed;
}

/// <summary>Raised when connector configuration is missing or invalid. Never contains secret material.</summary>
public sealed class ConnectorConfigurationException(string message) : Exception(message);
