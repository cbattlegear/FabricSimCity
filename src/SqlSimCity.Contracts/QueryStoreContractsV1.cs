namespace SqlSimCity.Contracts.V1;

public enum QueryTextAvailability { Available, Restricted, Encrypted, Missing }
public enum QueryStoreExecutionType { Regular, Aborted, Exception }
public enum QueryPlanType { Compiled, Dispatcher, Variant, Unknown }
public enum QueryOptimizationKind { None, ParameterSensitivePlan, OptionalParameterPlanOptimization }
public enum QueryStoreSource { Fixture, QueryStore }

public sealed record QueryStoreEvidenceV1(
    QueryStoreSource Source,
    DataStatus Status,
    DateTimeOffset? ObservedAt,
    DateTimeOffset? FreshUntil,
    string Reason,
    string Caveat);

public sealed record QueryTextDescriptorV1(
    QueryTextAvailability Availability,
    string? NormalizedText,
    string? NormalizedTextFingerprint,
    string Reason);

public sealed record QueryContextSettingsV1(
    string ContextSettingsId,
    string? Language,
    string? DateFormat,
    string? DateFirst,
    string? CompatibilityLevel,
    string? SetOptions);

public sealed record PhysicalQueryIdentityV1(
    string DatabaseId,
    string QueryId,
    string QueryTextId,
    string QueryHash,
    QueryContextSettingsV1 Context,
    QueryTextDescriptorV1 Text);

public sealed record RuntimeBucketV1(
    string PlanId,
    string IntervalId,
    DateTimeOffset IntervalStart,
    DateTimeOffset IntervalEnd,
    QueryStoreExecutionType ExecutionType,
    string ReplicaGroupId,
    string ExecutionCount,
    decimal AverageDurationMicroseconds,
    decimal AverageCpuMicroseconds,
    decimal AverageLogicalReads8KiBPages,
    string TotalDurationMicroseconds,
    string TotalCpuMicroseconds,
    string TotalLogicalReads8KiBPages,
    IReadOnlyDictionary<string, string> WaitMilliseconds,
    QueryStoreEvidenceV1 Evidence);

public sealed record QueryPlanSummaryV1(
    string PlanId,
    string QueryId,
    string QueryPlanHash,
    QueryPlanType PlanType,
    QueryOptimizationKind Optimization,
    string? DispatcherPlanId,
    bool RuntimeCounted,
    bool IsForced,
    string? ForcingType,
    string ForceFailureCount,
    string? LastForceFailureReason,
    string EngineVersion,
    string CompatibilityLevel,
    DateTimeOffset LastExecutionAt,
    QueryStoreEvidenceV1 Evidence);

public sealed record QueryFamilySummaryV1(
    string FamilyId,
    string DatabaseId,
    string QueryHash,
    string? NormalizedTextFingerprint,
    QueryTextDescriptorV1 Text,
    IReadOnlyList<PhysicalQueryIdentityV1> PhysicalQueries,
    string ExecutionCount,
    string TotalCpuMicroseconds,
    string TotalDurationMicroseconds,
    string TotalLogicalReads8KiBPages,
    string TotalWaitMilliseconds,
    DateTimeOffset FirstObservedAt,
    DateTimeOffset LastObservedAt,
    QueryStoreEvidenceV1 Evidence);

public sealed record QueryFamilyDetailV1(
    string SchemaVersion,
    QueryFamilySummaryV1 Family,
    IReadOnlyList<QueryPlanSummaryV1> Plans,
    IReadOnlyList<RuntimeBucketV1> Runtime);

public sealed record PageV1<T>(
    string SchemaVersion,
    IReadOnlyList<T> Items,
    string? NextPageToken,
    int PageSize,
    string? TotalCount)
{
    public QueryStoreEvidenceV1? Evidence { get; init; }
}

public sealed record ShowplanObjectV1(string? Database, string? Schema, string? Table, string? Index);
public sealed record ShowplanWarningV1(string Kind, string? Detail);
public sealed record ShowplanNodeV1(
    int NodeId,
    int? ParentNodeId,
    string LogicalOperation,
    string PhysicalOperation,
    decimal? EstimatedRows,
    decimal? EstimatedCpuCost,
    decimal? EstimatedIoCost,
    decimal? EstimatedTotalSubtreeCost,
    bool Parallel,
    ShowplanObjectV1? ObjectReference,
    string? Predicate,
    IReadOnlyList<ShowplanWarningV1> Warnings);

public sealed record NormalizedShowplanV1(
    string SchemaVersion,
    string PlanId,
    string ShowplanVersion,
    string? CardinalityEstimatorVersion,
    decimal? SerialDesiredMemoryKiB,
    decimal? SerialRequiredMemoryKiB,
    IReadOnlyList<ShowplanNodeV1> Nodes,
    QueryOptimizationKind Optimization,
    string? DispatcherExpression,
    string StructuralFingerprint,
    string RuntimeOverlayCaveat,
    QueryStoreEvidenceV1 Evidence);

public sealed record PlanChangeV1(string Path, string ChangeKind, string? Before, string? After);

public sealed record PlanComparisonV1(
    string SchemaVersion,
    string LeftPlanId,
    string RightPlanId,
    bool StructurallyEqual,
    IReadOnlyList<PlanChangeV1> Changes,
    string Source,
    string Caveat);

public enum QueryStoreCollectorState { Disabled, Starting, Collecting, Ready, Partial, Stale, BackingOff, Failed }

public sealed record QueryStoreDatabaseStatusV1(
    string DatabaseId,
    QueryStoreCollectionStateV1 State,
    string ResetEpoch,
    DateTimeOffset? CollectedThrough,
    DateTimeOffset? OldestAvailableAt,
    string Reason);

public enum QueryStoreCollectionStateV1 { ReadWrite, ReadOnly, Off, Error, PermissionDenied, Unsupported, Unknown }

public sealed record QueryStoreCollectorStatusV1(
    string SchemaVersion,
    QueryStoreCollectorState State,
    long Sequence,
    DateTimeOffset? LastStartedAt,
    DateTimeOffset? LastPublishedAt,
    DateTimeOffset? NextAttemptAt,
    IReadOnlyList<QueryStoreDatabaseStatusV1> Databases,
    string Reason);
