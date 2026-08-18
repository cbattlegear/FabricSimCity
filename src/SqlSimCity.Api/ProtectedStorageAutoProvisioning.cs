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
            "key was generated at '{KeyFilePath}'. Query text is encrypted at rest with it. Back this " +
            "file up separately from the data directory and treat it as a production credential: if it " +
            "is lost or replaced, every stored query history record becomes permanently unrecoverable " +
            "and the store will refuse to open. In a container, keep this path on a persistent volume " +
            "or the key will not survive being recreated.");

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
            "be empty. Query text cannot be persisted without encryption at rest. Give this path a " +
            "writable persistent volume, or set ProtectedStorage:Enabled=true with your own key file at " +
            "ProtectedStorage:KeyFilePath. Underlying cause: {Reason}");

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
    /// Directory name used for a generated key, created as a sibling of the data
    /// directory rather than inside it.
    ///
    /// The location is not cosmetic. <c>tools/backup-data.sh</c> refuses to take
    /// a backup at all when the key file resolves inside the data directory,
    /// because a backup containing its own decryption key protects nobody. A
    /// generated key must therefore live outside <c>DataDirectory</c> or it
    /// would silently break backups for exactly the operators who never
    /// configured any of this.
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
    /// and otherwise picks a persistent path beside the data directory.
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

        var fullDataDirectory = Path.GetFullPath(dataDirectory);
        var parent = Path.GetDirectoryName(fullDataDirectory);

        // A data directory at a filesystem root has no parent to sit beside; the
        // root itself is still outside the data directory, which is the property
        // that matters to the backup tool.
        var keyDirectory = string.IsNullOrEmpty(parent)
            ? Path.Combine(fullDataDirectory, "..", KeyDirectoryName)
            : Path.Combine(parent, KeyDirectoryName);

        return Path.GetFullPath(Path.Combine(keyDirectory, KeyFileName));
    }
}
