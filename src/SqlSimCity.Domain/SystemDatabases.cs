namespace SqlSimCity.Domain;

/// <summary>
/// The four SQL Server system databases, and the rule that Query Store evidence is never gathered
/// from them.
/// <para>
/// Query Store cannot be enabled on <c>master</c> or <c>tempdb</c> at all, and the engine's own
/// maintenance workload in <c>msdb</c> or the <c>model</c> template is not application evidence a
/// reader of this atlas is looking for. Treating them like user databases produced noise in three
/// places: a Query Store probe that failed or reported OFF, a collector cycle counted as degraded
/// because of it, and a "Query Store cannot provide evidence" finding describing an expected
/// configuration. Collection skips them, the atlas records their Query Store as
/// <c>Unsupported</c> rather than failed, and no Query Store finding is raised against them.
/// </para>
/// </summary>
public static class SystemDatabases
{
    private static readonly HashSet<string> KnownNames =
        new(StringComparer.OrdinalIgnoreCase) { "master", "tempdb", "model", "msdb" };

    /// <summary>
    /// True when <paramref name="databaseName"/> names a SQL Server system database. The names are
    /// reserved by the engine, so no user database can collide with them.
    /// </summary>
    public static bool IsSystemDatabase(string? databaseName) =>
        databaseName is not null && KnownNames.Contains(databaseName.Trim());

    /// <summary>
    /// The reason surfaced wherever a system database's Query Store record is exposed, so the
    /// absence of history reads as a deliberate exclusion rather than a collection failure.
    /// </summary>
    public static string QueryStoreExclusionReason(string databaseName) =>
        $"Query Store evidence is not collected for the system database '{databaseName}'.";
}
