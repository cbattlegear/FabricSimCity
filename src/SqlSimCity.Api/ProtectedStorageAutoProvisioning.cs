using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using SqlSimCity.Storage;

namespace SqlSimCity.Api;

/// <summary>
/// The outcome of auto-enabling protected storage, so the caller can apply the
/// configuration and report exactly what happened.
/// </summary>
public sealed record ProtectedStorageProvisioning(
    string DataDirectory,
    IReadOnlyDictionary<string, string?> ConfigurationOverrides,
    string? UnavailableReason = null);

/// <summary>
/// Makes connected Query Store history work for an operator whose entire
/// configuration is a connection string.
///
/// Query Store history retains query text and plan XML, so it needs somewhere to
/// put them. That used to mean an encryption key, and the requirement was
/// enforced against operators who had never been told about it: supplying a
/// connection string enabled Atlas and live incidents while Query Store history
/// silently stayed on <c>UnavailableQueryStoreHistorySource</c>, so pointing
/// SQLSimCity at a real server made the query views emptier than fixture mode,
/// with no error.
///
/// Records are now written in the clear, so there is no key to provision and no
/// credential to look after. What remains is enabling the store and checking that
/// its directory can actually be written, so the failure is a startup warning
/// rather than an empty page. An operator who set <c>ProtectedStorage:Enabled</c>
/// themselves is left alone.
/// </summary>
public static class ProtectedStorageAutoProvisioning
{
    private static readonly Action<ILogger, string, Exception?> LogStorageEnabled =
        LoggerMessage.Define<string>(
            LogLevel.Warning, new EventId(31, "ProtectedStorageEnabled"),
            "Connected Query Store history was enabled by a connection string, so retained query " +
            "history is being written to '{DataDirectory}'. CAPTURED QUERY TEXT AND PLAN XML ARE " +
            "STORED IN THE CLEAR, and plan XML can contain literal parameter values from your " +
            "queries. Anyone who can read that directory, or a backup or volume snapshot of it, can " +
            "read everything collected. Restrict it with filesystem permissions if that matters. " +
            "Delete the directory to start over; it is a cache of the server's own data, not a " +
            "system of record.");

    private static readonly Action<ILogger, string, string, Exception?> LogStorageUnavailable =
        LoggerMessage.Define<string, string>(
            LogLevel.Warning, new EventId(33, "ProtectedStorageUnavailable"),
            "Connected Query Store history was requested by a connection string but its storage " +
            "directory '{DataDirectory}' is not writable, so query history collection is disabled " +
            "and query views will be empty. Make ProtectedStorage:DataDirectory writable by the " +
            "running user, or set ProtectedStorage:Enabled=true with a directory of your own. " +
            "Underlying cause: {Reason}");

    /// <summary>
    /// States at startup where collected evidence is being written and that it is
    /// readable there, rather than letting that surprise an operator later.
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
            LogStorageUnavailable(logger, provisioning.DataDirectory, provisioning.UnavailableReason, null);
        }
        else
        {
            LogStorageEnabled(logger, provisioning.DataDirectory, null);
        }
    }

    private const string DefaultDataDirectory = "/data";

    /// <summary>
    /// Decides whether protected storage should be enabled automatically and, when
    /// it should, confirms its directory can be written.
    ///
    /// Returns <c>null</c> whenever the operator is steering this themselves, so
    /// this can only ever add capability to a configuration that would otherwise
    /// have served nothing.
    /// </summary>
    public static ProtectedStorageProvisioning? TryProvision(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);

        // Only the connection-string convenience path is auto-enabled. The
        // field-by-field path is the deliberate one and keeps its hard failure.
        if (AtlasConfiguration.ResolveConnectionString(configuration) is null)
        {
            return null;
        }

        if (QueryStoreHistoryConfiguration.IsDisabled(configuration))
        {
            return null;
        }

        // An operator who enabled protected storage has made deliberate choices
        // about where evidence lands; never override that.
        if (configuration.GetValue<bool>($"{ProtectedStorageOptions.SectionName}:Enabled"))
        {
            return null;
        }

        var dataDirectory = ResolveDataDirectory(configuration);

        try
        {
            EnsureWritable(dataDirectory);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException)
        {
            // The shipped container runs with a read-only root filesystem and only
            // the data volume writable, so a misconfigured path lands somewhere that
            // cannot be created. Convenience must never take down a deployment that
            // starts today: turn the feature off explicitly, which reproduces the
            // previous behavior exactly, and say why. Disabled is the mode that
            // IsConnected treats as a hard opt-out, so this also keeps the startup
            // check below from failing on a half-configured deployment.
            return new ProtectedStorageProvisioning(
                dataDirectory,
                new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
                {
                    ["QueryStoreHistory:Mode"] = "Disabled",
                },
                UnavailableReason: ex.Message);
        }

        var overrides = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
        {
            [$"{ProtectedStorageOptions.SectionName}:Enabled"] = "true",
            [$"{ProtectedStorageOptions.SectionName}:DataDirectory"] = dataDirectory,
        };

        return new ProtectedStorageProvisioning(dataDirectory, overrides);
    }

    /// <summary>
    /// Proves the directory is writable now, so an unwritable volume becomes a
    /// startup warning naming the cause instead of a failure at the first write.
    /// </summary>
    private static void EnsureWritable(string dataDirectory)
    {
        Directory.CreateDirectory(dataDirectory);
        var probePath = Path.Combine(dataDirectory, $".sqlsimcity-write-probe-{Guid.NewGuid():N}");
        File.WriteAllBytes(probePath, []);
        File.Delete(probePath);
    }

    private static string ResolveDataDirectory(IConfiguration configuration)
    {
        var configured = configuration.GetValue<string>(
            $"{ProtectedStorageOptions.SectionName}:DataDirectory");

        return Path.GetFullPath(string.IsNullOrWhiteSpace(configured) ? DefaultDataDirectory : configured);
    }
}
