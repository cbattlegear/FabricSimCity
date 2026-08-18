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

public sealed record DatabaseCityAttributedExposureV1(
    string? ExecutionCount,
    string? TotalCpuMicroseconds,
    string? TotalDurationMicroseconds,
    string? TotalLogicalReads8KiBPages,
    QueryAttributionConfidence Confidence,
    string Rationale,
    EvidenceV1 Evidence);

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

public sealed record DatabaseCityQueryFamilyV1(
    string FamilyId,
    string QueryHash,
    string ExecutionCount,
    string TotalCpuMicroseconds,
    string TotalDurationMicroseconds,
    string TotalLogicalReads8KiBPages,
    string TotalWaitMilliseconds,
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
