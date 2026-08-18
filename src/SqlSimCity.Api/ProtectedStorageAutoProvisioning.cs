using SqlSimCity.Storage;
using SqlSimCity.Storage.Crypto;

namespace SqlSimCity.Api;

/// <summary>
/// The outcome of auto-provisioning protected storage, so the caller can apply
/// the configuration and report exactly what happened.
/// </summary>
public sealed record ProtectedStorageProvisioning(
    string KeyFilePath,
    bool KeyCreated,
    IReadOnlyDictionary<string, string?> ConfigurationOverrides,
    string? UnavailableReason = null);

/// <summary>
/// Makes connected Query Store history work for an operator whose entire
/// configuration is a connection string.
///
/// Query Store history persists query <em>text</em>, so it refuses to run
/// without encryption at rest and there is deliberately no plaintext fallback.
/// That requirement is sound, but it used to be enforced against operators who
/// had never been told about it: supplying a connection string enabled Atlas and
/// live incidents while Query Store history silently stayed on
/// <c>UnavailableQueryStoreHistorySource</c>, so pointing SQLSimCity at a real
/// server made the query views emptier than fixture mode, with no error.
///
/// This closes that gap by generating a key rather than by weakening the
/// requirement. Encryption at rest still holds; what changes is who creates the
/// key. The hardened path is untouched: an operator who sets
/// <c>ProtectedStorage:Enabled</c> explicitly, or who runs the field-by-field
/// connection configuration, still supplies their own key and still fails
/// closed without one.
/// </summary>
public static class ProtectedStorageAutoProvisioning
{
    private static readonly Action<ILogger, string, Exception?> LogKeyGenerated =
        LoggerMessage.Define<string>(
            LogLevel.Warning, new EventId(31, "ProtectedStorageKeyGenerated"),
            "Connected Query Store history was enabled by a connection string, so an AES-256 storage " +
            "key was generated at '{KeyFilePath}'. Query text is encrypted at rest with it. It is kept " +
            "inside the data directory so it is exactly as durable as the data it protects, and " +
            "'tools/backup-data.sh' deliberately excludes it, so YOUR BACKUPS DO NOT CONTAIN THIS KEY: " +
            "copy it somewhere safe yourself and treat it as a production credential. If it is lost or " +
            "replaced, every stored query history record becomes permanently unrecoverable and the " +
            "store will refuse to open.");

    private static readonly Action<ILogger, string, Exception?> LogKeyReused =
        LoggerMessage.Define<string>(
            LogLevel.Information, new EventId(32, "ProtectedStorageKeyReused"),
            "Connected Query Store history was enabled by a connection string and is using the existing " +
            "storage key at '{KeyFilePath}'.");

    private static readonly Action<ILogger, string, string, Exception?> LogKeyUnavailable =
        LoggerMessage.Define<string, string>(
            LogLevel.Warning, new EventId(33, "ProtectedStorageKeyUnavailable"),
            "Connected Query Store history was requested by a connection string but no storage key could " +
            "be created at '{KeyFilePath}', so query history collection is disabled and query views will " +
            "be empty. Query text cannot be persisted without encryption at rest. Make " +
            "ProtectedStorage:DataDirectory writable by the running user, or set " +
            "ProtectedStorage:Enabled=true with your own key file at ProtectedStorage:KeyFilePath. " +
            "Underlying cause: {Reason}");

    /// <summary>
    /// States at startup that a key now exists and that it is the operator's to
    /// look after, rather than letting a generated credential appear silently.
    /// </summary>
    public static void Report(
        ProtectedStorageProvisioning? provisioning,
        ILoggerFactory loggerFactory)
    {
        ArgumentNullException.ThrowIfNull(loggerFactory);

        if (provisioning is null)
        {
            return;
        }

        var logger = loggerFactory.CreateLogger(typeof(ProtectedStorageAutoProvisioning).FullName!);
        if (provisioning.UnavailableReason is not null)
        {
            LogKeyUnavailable(logger, provisioning.KeyFilePath, provisioning.UnavailableReason, null);
        }
        else if (provisioning.KeyCreated)
        {
            LogKeyGenerated(logger, provisioning.KeyFilePath, null);
        }
        else
        {
            LogKeyReused(logger, provisioning.KeyFilePath, null);
        }
    }

    /// <summary>
    /// Directory name used for a generated key, created inside the data
    /// directory.
    ///
    /// Placing it there is a deliberate trade-off. A container's only reliably
    /// writable, reliably persistent location is the data volume itself: a key
    /// written anywhere else in a container either fails (read-only root
    /// filesystem) or lands on the ephemeral container layer, where it is lost
    /// on recreate while the data survives -- which would leave every protected
    /// record permanently unopenable. Durability of the key must therefore match
    /// durability of the data it protects, and inside the data directory is the
    /// only placement that guarantees it.
    ///
    /// The cost is that a raw volume snapshot contains both. What is preserved
    /// is that no <em>backup</em> contains the key: <c>tools/backup-data.sh</c>
    /// excludes this directory and verifies it is absent from the archive.
    /// </summary>
    private const string KeyDirectoryName = "sqlsimcity-keys";

    private const string KeyFileName = "storage-key.json";

    /// <summary>
    /// Decides whether protected storage should be provisioned automatically and,
    /// when it should, creates the key file if it is missing.
    ///
    /// Returns <c>null</c> whenever the operator is steering this themselves, so
    /// this can only ever add capability to a configuration that would otherwise
    /// have served nothing.
    /// </summary>
    public static ProtectedStorageProvisioning? TryProvision(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);

        // Only the connection-string convenience path is auto-provisioned. The
        // field-by-field path is the hardened one and keeps its hard failure.
        if (AtlasConfiguration.ResolveConnectionString(configuration) is null)
        {
            return null;
        }

        if (QueryStoreHistoryConfiguration.IsDisabled(configuration))
        {
            return null;
        }

        // An operator who enabled protected storage has made deliberate choices
        // about key custody; never generate a key over the top of that.
        if (configuration.GetValue<bool>($"{ProtectedStorageOptions.SectionName}:Enabled"))
        {
            return null;
        }

        var keyFilePath = ResolveKeyFilePath(configuration);

        bool keyCreated;
        try
        {
            keyCreated = KeyRingProvisioner.TryCreate(keyFilePath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            // The shipped container runs with a read-only root filesystem and only
            // the data volume writable, so a key beside /data lands somewhere that
            // cannot be created. Convenience must never take down a deployment that
            // starts today: turn the feature off explicitly, which reproduces the
            // previous behavior exactly, and say why. Disabled is the mode that
            // IsConnected treats as a hard opt-out, so this also keeps the startup
            // check below from failing on a half-provisioned configuration.
            return new ProtectedStorageProvisioning(
                keyFilePath,
                KeyCreated: false,
                new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
                {
                    ["QueryStoreHistory:Mode"] = "Disabled",
                },
                UnavailableReason: ex.Message);
        }

        var overrides = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
        {
            [$"{ProtectedStorageOptions.SectionName}:Enabled"] = "true",
            [$"{ProtectedStorageOptions.SectionName}:KeyFilePath"] = keyFilePath,
        };

        return new ProtectedStorageProvisioning(keyFilePath, keyCreated, overrides);
    }

    /// <summary>
    /// Prefers a key file that is already present at the configured path, so an
    /// operator who mounted one without also setting <c>Enabled</c> keeps it,
    /// and otherwise generates inside the data directory.
    ///
    /// The shipped default points at <c>/run/secrets</c>, which is tmpfs under
    /// Docker. Generating there would produce a key that disappears on restart
    /// and leave an unopenable store behind, so it is never used as a
    /// destination for a generated key -- only honoured when a file is really
    /// there.
    /// </summary>
    private static string ResolveKeyFilePath(IConfiguration configuration)
    {
        var configured = configuration.GetValue<string>(
            $"{ProtectedStorageOptions.SectionName}:KeyFilePath");

        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured))
        {
            return configured;
        }

        var dataDirectory = configuration.GetValue<string>(
            $"{ProtectedStorageOptions.SectionName}:DataDirectory");

        if (string.IsNullOrWhiteSpace(dataDirectory))
        {
            dataDirectory = "/data";
        }

        return Path.GetFullPath(Path.Combine(
            Path.GetFullPath(dataDirectory), KeyDirectoryName, KeyFileName));
    }
}
