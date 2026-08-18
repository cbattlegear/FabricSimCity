using SqlSimCity.Contracts.V1;
using SqlSimCity.SqlServer;

namespace SqlSimCity.Api;

/// <summary>
/// Resolves the optional single-connection-string shortcut shared by every
/// connected surface (Atlas, Query Store history, and live incidents), so one
/// ordinary ADO.NET connection string can stand in for a field-by-field
/// connection profile and a mounted password file.
///
/// Resolution order, first non-empty wins: the section's own
/// <c>ConnectionString</c> key, then the standard .NET
/// <c>ConnectionStrings:SqlSimCity</c> (settable as the
/// <c>ConnectionStrings__SqlSimCity</c> environment variable), then the
/// <c>SQLSIMCITY_CONNECTION_STRING</c> environment variable, which matches the
/// edge connector's naming.
///
/// Configuring one turns the corresponding surface on: it is an explicit
/// statement that a real target exists, and the fixture path stays the default
/// whenever no connection string is configured. A connection string is a
/// convenience, not the hardened path -- see <see cref="ConnectionStringProfile"/>
/// and SECURITY.md for what an inline password gives up.
/// </summary>
public static class SqlSimCityConnectionString
{
    /// <summary>The standard <c>ConnectionStrings</c> entry name.</summary>
    public const string ConnectionStringName = "SqlSimCity";

    /// <summary>The unprefixed environment variable, for parity with the edge connector.</summary>
    public const string EnvironmentVariableName = "SQLSIMCITY_CONNECTION_STRING";

    public static string? Resolve(IConfiguration configuration, string? sectionScopedKey = null)
    {
        ArgumentNullException.ThrowIfNull(configuration);

        string?[] candidates =
        [
            sectionScopedKey is null ? null : configuration[sectionScopedKey],
            configuration.GetConnectionString(ConnectionStringName),
            configuration[EnvironmentVariableName],
        ];

        foreach (var candidate in candidates)
        {
            if (!string.IsNullOrWhiteSpace(candidate))
            {
                return candidate.Trim();
            }
        }

        return null;
    }

    /// <summary>
    /// The engine platform to assume when only a connection string is configured.
    /// A connection string cannot state the platform, so an Azure SQL endpoint is
    /// taken as Azure SQL Database and everything else as on-premises SQL Server.
    /// Explicit configuration always wins over this default, and Managed Instance
    /// -- which shares the Azure SQL host suffix -- must always be stated.
    /// </summary>
    public static EnginePlatform DefaultPlatform(ConnectionStringProfile parsed)
    {
        ArgumentNullException.ThrowIfNull(parsed);
        return parsed.IsAzureSqlHost ? EnginePlatform.AzureSqlDatabase : EnginePlatform.SqlServerOnPremises;
    }

    private static readonly Action<ILogger, Exception?> LogInlineConnectionString =
        LoggerMessage.Define(
            LogLevel.Warning, new EventId(30, "InlineConnectionStringConfigured"),
            "A SQL connection string is configured. Any password it carries is readable from this " +
            "process's environment and cannot be rotated without a restart, unlike the mounted secret " +
            "files the field-by-field configuration uses. Prefer field-by-field configuration in production.");

    /// <summary>
    /// Rejects a connection string configured alongside any field it would
    /// override, mirroring the edge connector, so an operator can never edit a
    /// value that has no effect.
    ///
    /// This matters most for the two *shared*, unscoped sources
    /// (<c>ConnectionStrings:SqlSimCity</c> and <c>SQLSIMCITY_CONNECTION_STRING</c>):
    /// <c>ConnectionStrings__*</c> is a conventional name that hosting platforms
    /// inject automatically, and without this guard one appearing in the
    /// environment would silently replace a hardened field profile -- its
    /// authentication strategy, its TLS trust setting, and its mounted password
    /// file -- with the connection string's weaker equivalents.
    ///
    /// Labels that a connection string cannot express are deliberately not
    /// conflicts, since they must stay configurable alongside one.
    /// </summary>
    public static void EnsureNoFieldConflict(
        IConfiguration configuration,
        string connectionSectionName,
        IReadOnlyList<string> overriddenKeys,
        Func<string, Exception> createException)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(overriddenKeys);
        ArgumentNullException.ThrowIfNull(createException);

        var section = configuration.GetSection(connectionSectionName);
        foreach (var key in overriddenKeys)
        {
            var child = section.GetSection(key);
            if (child.Value is not null || child.GetChildren().Any())
            {
                throw createException(
                    $"{connectionSectionName}:{key} cannot be combined with a connection string, which already " +
                    "supplies it. Configure the connection string alone, or remove it and configure every " +
                    "connection field explicitly.");
            }
        }
    }

    /// <summary>
    /// Warns once at startup when any connected surface is driven by a connection
    /// string, so the trade-off an inline password makes is stated rather than silent.
    /// </summary>
    public static void WarnIfConfigured(IConfiguration configuration, ILoggerFactory loggerFactory)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(loggerFactory);

        string?[] sectionScopedKeys =
        [
            null,
            AtlasConfiguration.ConnectionStringKey,
            $"{LiveIncidentsOptions.SectionName}:{nameof(LiveIncidentsOptions.Connection)}:" +
            $"{nameof(LiveIncidentsConnectionOptions.ConnectionString)}",
        ];

        if (sectionScopedKeys.Any(key => Resolve(configuration, key) is not null))
        {
            LogInlineConnectionString(loggerFactory.CreateLogger(typeof(SqlSimCityConnectionString).FullName!), null);
        }
    }
}
