namespace SqlSimCity.Contracts.V1;

public enum DatabaseCityMetric { Cpu, Duration, Reads, Executions }
public enum DatabaseObjectKind { Table, IndexedView }
public enum DatabaseIndexKind { Heap, Clustered, Nonclustered, Columnstore, Other }
public enum QueryAttributionConfidence { Confirmed, Probable, Unknown }
public enum DatabaseCityRouteKind { ObjectReference, CrossDatabaseReference }

/// <summary>
/// Where an object sits in the collector's stable ordering, so a city can be laid out the same way
/// on every collection and every page.
/// </summary>
/// <param name="NeighborhoodOrdinal">
/// The object's schema's position among the database's schemas, ordered by schema id.
/// </param>
/// <param name="ObjectOrdinal">
/// The object's position among <b>every object in the database</b>, ordered by schema id then object
/// id — not its position within its own schema. Database-wide is the only meaning both collectors can
/// honour, because one pages the database without knowing where a schema begins; reading it as a
/// per-schema index made the five-hundredth object look like a schema holding five hundred and one
/// (#49). Nothing that sizes the city may be derived from it: an ordinal states an order, not a count.
/// </param>
/// <param name="X">Legacy lattice coordinate derived from the ordinals. The city is no longer a
/// lattice and does not read these; they change whenever the ordinals do.</param>
/// <param name="Z">See <paramref name="X"/>.</param>
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
/// <summary>
/// One object's modelled share of a query family's measured wait time.
/// <para>
/// <see cref="WaitMilliseconds"/> is <em>not</em> a measurement of how long this object waited.
/// Query Store measures one wait total per query and never says which table caused it. The split is
/// <see cref="EstimatedCostShare"/>: the fraction of the compiled plan's <em>estimated</em> cost the
/// optimizer placed on operators reading this object. Presenting it requires saying so.
/// </para>
/// </summary>
public sealed record DatabaseCityObjectWaitShareV1(
    string ObjectId,
    decimal EstimatedCostShare,
    string WaitMilliseconds);

/// <summary>
/// A query family's measured wait time apportioned across the objects its compiled plans read.
/// <para>
/// The parts and <see cref="UnattributedWaitMilliseconds"/> sum to exactly the family's
/// <c>TotalWaitMilliseconds</c>, so the apportionment can always be checked against the measurement
/// it came from. The unattributed part covers cost the plan spent on no object at all, plus every
/// object the plan named that this page does not draw -- off-page, another database, or a reference
/// the collector could not resolve. Folding that into the objects on screen would hand this page
/// wait time that demonstrably belongs elsewhere.
/// </para>
/// <para>
/// An empty <see cref="Objects"/> list means no apportionment was possible, never that no object
/// waited.
/// </para>
/// </summary>
public sealed record DatabaseCityWaitAttributionV1(
    IReadOnlyList<DatabaseCityObjectWaitShareV1> Objects,
    string UnattributedWaitMilliseconds,
    int PlansRead,
    string Rationale)
{
    public static readonly DatabaseCityWaitAttributionV1 None = new(
        [], "0", 0,
        "No compiled plan cost estimate was available for this family, so its wait time is not apportioned.");
}

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
    EvidenceV1 Evidence)
{
    /// <summary>
    /// The family's measured wait time spread across the objects its plans read, in proportion to
    /// estimated plan cost. Modelled, not measured; see <see cref="DatabaseCityWaitAttributionV1"/>.
    /// </summary>
    public DatabaseCityWaitAttributionV1 WaitAttribution { get; init; } = DatabaseCityWaitAttributionV1.None;
}

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
