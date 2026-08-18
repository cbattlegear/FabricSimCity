namespace SqlSimCity.Collection.Probes;

/// <summary>Row shape for <c>server.identity</c> (see sql/probes/server/server_identity.sql).</summary>
public sealed record ServerIdentityResult(
    string? ServerName,
    string? ProductVersion,
    string? ProductLevel,
    string? Edition,
    int EngineEdition,
    bool IsHadrEnabled,
    int CpuCount,
    int SchedulerCount,
    long? PhysicalMemoryMb,
    DateTimeOffset? SqlServerStartTime);

/// <summary>One row of <c>server.database_discovery</c>: a visible database and its compatibility level.</summary>
public sealed record DatabaseDiscoveryRow(
    int DatabaseId,
    string DatabaseName,
    string StateDesc,
    int CompatibilityLevel,
    bool IsQueryStoreOn);

/// <summary>
/// Row shape for <c>querystore.options_2019</c> (and its version variants), scoped to whichever
/// database the connection is currently opened against. <see cref="ReadonlyReason"/> is the raw
/// bitmask from <c>sys.database_query_store_options.readonly_reason</c>; see sql/README.md for bit
/// meanings. A negotiator never treats mere row presence as "Query Store is on" -- only
/// <see cref="ActualStateDesc"/> is authoritative (see the probe's own result-contract note).
/// </summary>
public sealed record QueryStoreOptionsRow(
    string DesiredStateDesc,
    string ActualStateDesc,
    int ReadonlyReason,
    long CurrentStorageSizeMb,
    long MaxStorageSizeMb,
    string QueryCaptureModeDesc);

/// <summary>
/// The catalog-metadata confirmation used for PSP/OPPO/secondary-replica gating (see
/// sql/probes/capability/query_store_plan_metadata.sql). Each flag is true only when the
/// connected engine build actually exposes that column -- never inferred from a reported major
/// version alone.
/// </summary>
public sealed record QueryStorePlanMetadataResult(
    bool HasPlanTypeDesc,
    bool HasIsOptimizedPlanForcingDisabled,
    bool HasCompileReplayScript,
    bool HasReplicaGroupId)
{
    public static QueryStorePlanMetadataResult FromColumnNames(IEnumerable<(string ViewName, string ColumnName)> rows)
    {
        var set = new HashSet<(string, string)>(rows);
        return new QueryStorePlanMetadataResult(
            HasPlanTypeDesc: set.Contains(("sys.query_store_plan", "plan_type_desc")),
            HasIsOptimizedPlanForcingDisabled: set.Contains(("sys.query_store_plan", "is_optimized_plan_forcing_disabled")),
            HasCompileReplayScript: set.Contains(("sys.query_store_plan", "has_compile_replay_script")),
            HasReplicaGroupId: set.Contains(("sys.query_store_runtime_stats", "replica_group_id")));
    }
}

/// <summary>Row shape for <c>capability.azure_resource_governance</c>; only meaningful on Azure SQL Database.</summary>
public sealed record AzureResourceGovernanceRow(double? CpuLimit, long? ProcessMemoryLimitMb);
