namespace SqlSimCity.Contracts.V1;

public enum DatabaseCityMetric { Cpu, Duration, Reads, Executions }
public enum DatabaseObjectKind { Table, IndexedView }
public enum DatabaseIndexKind { Heap, Clustered, Nonclustered, Columnstore, Other }
public enum QueryAttributionConfidence { Confirmed, Probable, Unknown }
public enum DatabaseCityRouteKind { ObjectReference, CrossDatabaseReference }

public sealed record DatabaseCityLayoutV1(
    int NeighborhoodOrdinal,
    int ObjectOrdinal,
    long X,
    long Z);

public sealed record DatabaseCityDirectActivityV1(
    string? TotalOperations,
    string? ResetEpochToken,
    EvidenceV1 Evidence);

/// <summary>
/// Query Store totals from ranked families that named this object <b>alongside others</b>, carried
/// whole and never divided, because Query Store measures one total per query and never a per-object
/// share. The same figures are reported again on every other object those queries named, so these
/// values are <b>not additive across buildings</b>: summing them over a city counts one query once
/// per object it touched. They are the honest answer for a normalized schema, where almost every
/// ranked query joins several tables and so can never be credited to one of them.
/// </summary>
public sealed record DatabaseCitySharedExposureV1(
    string FamilyCount,
    string ExecutionCount,
    string TotalCpuMicroseconds,
    string TotalDurationMicroseconds,
    string TotalLogicalReads8KiBPages,
    string Rationale);

/// <summary>
/// What a bounded page can say about one object's Query Store exposure. The scalar totals are
/// populated only when ranked families named this object and nothing else at all; when they are
/// <see langword="null"/>, <see cref="Shared"/> may still carry the query-level totals of families
/// that named it together with other objects.
/// </summary>
public sealed record DatabaseCityAttributedExposureV1(
    string? ExecutionCount,
    string? TotalCpuMicroseconds,
    string? TotalDurationMicroseconds,
    string? TotalLogicalReads8KiBPages,
    QueryAttributionConfidence Confidence,
    string Rationale,
    EvidenceV1 Evidence)
{
    /// <summary>
    /// Non-additive query-level totals from families that named this object alongside others, or
    /// <see langword="null"/> when no ranked family did.
    /// </summary>
    public DatabaseCitySharedExposureV1? Shared { get; init; }
}

public sealed record DatabaseCityIndexV1(
    string IndexId,
    string Name,
    DatabaseIndexKind Kind,
    DatabaseCityDirectActivityV1 DirectActivity);

public sealed record DatabaseCitySchemaV1(
    string SchemaId,
    string Name,
    int NeighborhoodOrdinal,
    string ObjectCount,
    EvidenceV1 Evidence);

public sealed record DatabaseCityObjectV1(
    string ObjectId,
    string SchemaId,
    string SchemaName,
    string Name,
    DatabaseObjectKind Kind,
    string? ReservedPages8KiB,
    string? UsedPages8KiB,
    string? ReservedBytes,
    string? UsedBytes,
    MeasurementStatus SizeStatus,
    string? SizeReason,
    DatabaseCityLayoutV1 Layout,
    IReadOnlyList<DatabaseCityIndexV1> Indexes,
    DatabaseCityDirectActivityV1 DirectActivity,
    DatabaseCityAttributedExposureV1 AttributedExposure);

/// <summary>
/// One captured query family. <paramref name="WaitMillisecondsByCategory"/> is keyed by the verbatim
/// Query Store <c>wait_category_desc</c> and is the evidence behind the city's wait lanes: it says
/// which physical resource the family queued for, which <paramref name="TotalWaitMilliseconds"/>
/// alone cannot. An <b>empty</b> dictionary means no wait-category evidence was captured -- most
/// often because <c>sys.query_store_wait_stats</c> does not exist before SQL Server 2017 (14.x) --
/// and never that the family waited for nothing. Categories are passed through unmapped and
/// untranslated so a category this build does not recognise is still reported rather than dropped.
/// </summary>
public sealed record DatabaseCityQueryFamilyV1(
    string FamilyId,
    string QueryHash,
    string ExecutionCount,
    string TotalCpuMicroseconds,
    string TotalDurationMicroseconds,
    string TotalLogicalReads8KiBPages,
    string TotalWaitMilliseconds,
    IReadOnlyDictionary<string, string> WaitMillisecondsByCategory,
    IReadOnlyList<string> ObjectIds,
    QueryAttributionConfidence Confidence,
    string Rationale,
    EvidenceV1 Evidence);

public sealed record DatabaseCityWorkloadAggregateV1(
    string? FamilyCount,
    string? ExecutionCount,
    string? TotalCpuMicroseconds,
    string? TotalDurationMicroseconds,
    string? TotalLogicalReads8KiBPages,
    string? TotalWaitMilliseconds,
    EvidenceV1 Evidence);

public sealed record DatabaseCityRouteV1(
    string RouteId,
    string FromObjectId,
    string ToId,
    DatabaseCityRouteKind Kind,
    EdgeConfidence Confidence,
    string Rationale,
    EvidenceV1 Evidence);

public sealed record DatabaseCitySummaryV1(
    string DatabaseId,
    string Name,
    string? SchemaCount,
    string? ObjectCount,
    string? ReservedBytes,
    MeasurementStatus SizeStatus,
    EvidenceV1 Evidence);

public sealed record DatabaseCitySummarySnapshotV1(
    string SchemaVersion,
    DateTimeOffset GeneratedAt,
    IReadOnlyList<DatabaseCitySummaryV1> Databases);

public sealed record DatabaseCityPageV1(
    string SchemaVersion,
    string DatabaseId,
    string DatabaseName,
    DatabaseCityMetric Metric,
    int PageSize,
    string? NextPageToken,
    string? TotalObjects,
    IReadOnlyList<DatabaseCitySchemaV1> Schemas,
    IReadOnlyList<DatabaseCityObjectV1> Objects,
    IReadOnlyList<DatabaseCityQueryFamilyV1> TopQueryFamilies,
    DatabaseCityWorkloadAggregateV1 OtherWorkload,
    IReadOnlyList<DatabaseCityRouteV1> Routes,
    EvidenceV1 Evidence);
