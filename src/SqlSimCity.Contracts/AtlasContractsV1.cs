namespace SqlSimCity.Contracts.V1;

public enum MeasurementStatus { Known, Unknown }
public enum EvidenceSource { Fixture, LiveDmvSample, QueryStoreAggregate, InferredTopology }
public enum DataStatus { Available, Stale, Disconnected, PermissionDenied, Disabled, Unsupported, Unknown }
public enum QueryStoreCapability { Available, Disabled, PermissionDenied, Unsupported, Unknown }
public enum QueryStoreHealth { Healthy, ReadOnly, Error, Stale, Unavailable, Unknown }
public enum EdgeConfidence { Confirmed, Probable, Unknown }

public sealed record EvidenceV1(
    EvidenceSource Source,
    DataStatus Status,
    DateTimeOffset? ObservedAt,
    DateTimeOffset? FreshUntil,
    string Reason);

public sealed record ByteMeasurementV1(
    string? Bytes,
    MeasurementStatus Status,
    string? Reason,
    EvidenceV1 Evidence);

public sealed record LiveActivityV1(
    int? ActiveSessions,
    int? RunningRequests,
    int? BlockedSessions,
    decimal? BatchRequestsPerSecond,
    EvidenceV1 Evidence);

public sealed record QueryStoreHistoryV1(
    long? ExecutionCount,
    long? LogicalReads8KiBPages,
    decimal? AverageDurationMicroseconds,
    DateTimeOffset? WindowStart,
    DateTimeOffset? WindowEnd,
    QueryStoreCapability Capability,
    QueryStoreHealth Health,
    string Reason,
    EvidenceV1 Evidence);

public sealed record DatabaseAtlasItemV1(
    string DatabaseId,
    string Name,
    ByteMeasurementV1 Allocated,
    ByteMeasurementV1 Used,
    LiveActivityV1 LiveActivity,
    QueryStoreHistoryV1 QueryStore);

public sealed record AtlasEdgeV1(
    string EdgeId,
    string FromDatabaseId,
    string ToDatabaseId,
    EdgeConfidence Confidence,
    string Rationale,
    EvidenceV1 Evidence);

public sealed record AtlasTargetV1(string TargetId, string DisplayName, string Platform);

public sealed record AtlasSnapshotV1(
    string SchemaVersion,
    string SnapshotId,
    AtlasTargetV1 Target,
    DateTimeOffset GeneratedAt,
    IReadOnlyList<DatabaseAtlasItemV1> Databases,
    IReadOnlyList<AtlasEdgeV1> Edges);
