namespace SqlSimCity.Contracts.V1;

public enum MeasurementStatus { Known, Unknown }
public enum EvidenceSource { Fixture, LiveDmvSample, QueryStoreAggregate, InferredTopology, LiveDmvCumulative, CatalogSnapshot, NotProbed }
public enum DataStatus { Available, Stale, Disconnected, PermissionDenied, Disabled, Unsupported, Unknown }
public enum QueryStoreCapability { Available, Disabled, PermissionDenied, Unsupported, Unknown }
public enum QueryStoreHealth { Healthy, ReadOnly, ReadableSecondary, Error, Stale, Unavailable, Unknown }
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
    string? ExecutionCount,
    string? LogicalReads8KiBPages,
    decimal? AverageDurationMicroseconds,
    DateTimeOffset? WindowStart,
    DateTimeOffset? WindowEnd,
    QueryStoreCapability Capability,
    QueryStoreHealth Health,
    string Reason,
    EvidenceV1 Evidence)
{
    public string? TotalDurationMicroseconds { get; init; }
    public string? TotalCpuMicroseconds { get; init; }
    public string? DesiredState { get; init; }
    public string? CaptureMode { get; init; }
    public string? CurrentStorageBytes { get; init; }
    public string? MaxStorageBytes { get; init; }
    public string? AbortedExecutionCount { get; init; }
    public string? ExceptionExecutionCount { get; init; }
}

public sealed record FileIoV1(
    string? BytesRead,
    string? BytesWritten,
    string? ReadBytesPerSecond,
    string? WriteBytesPerSecond,
    string? SampleMilliseconds,
    string? ResetEpochToken,
    EvidenceV1 Evidence);

public sealed record DatabaseAtlasItemV1(
    string DatabaseId,
    string Name,
    ByteMeasurementV1 Allocated,
    ByteMeasurementV1 Used,
    LiveActivityV1 LiveActivity,
    QueryStoreHistoryV1 QueryStore)
{
    public string? State { get; init; }
    public int? CompatibilityLevel { get; init; }
    public ByteMeasurementV1? LogAllocated { get; init; }
    public ByteMeasurementV1? LogUsed { get; init; }
    public FileIoV1? FileIo { get; init; }
}

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
    IReadOnlyList<AtlasEdgeV1> Edges)
{
    public AtlasCollectionMetadataV1? Collection { get; init; }
}

public enum AtlasCollectorMode { Fixture, Connected }
public enum AtlasCollectorState { Ready, Collecting, Paused, BackingOff, Degraded, Disconnected }

public sealed record AtlasCollectionMetadataV1(
    AtlasCollectorMode Mode,
    AtlasCollectorState State,
    long Sequence,
    DateTimeOffset? CollectedAt,
    DateTimeOffset? SourceTimestamp,
    DateTimeOffset? StaleAfter,
    bool IsStale,
    int DatabaseCount,
    int FailureCount,
    int SkipCount,
    long DurationMilliseconds,
    string Reason)
{
    public long RowCount { get; init; }
}

public sealed record AtlasCollectorStatusV1(
    AtlasCollectorMode Mode,
    AtlasCollectorState State,
    long Sequence,
    DateTimeOffset? LastCollectedAt,
    DateTimeOffset? SourceTimestamp,
    DateTimeOffset? StaleAfter,
    bool IsStale,
    int DatabaseCount,
    int FailureCount,
    int SkipCount,
    long LastDurationMilliseconds,
    int ConsecutiveFailures,
    DateTimeOffset? NextAttemptAt,
    string Reason)
{
    public long RowCount { get; init; }
}
