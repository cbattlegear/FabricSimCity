using SqlSimCity.Contracts.V1;
using SqlSimCity.Findings.Engine;

namespace SqlSimCity.Findings.Tests;

/// <summary>Deterministic builders for the contract records the findings rules consume.</summary>
internal static class FindingsTestData
{
    internal static readonly DateTimeOffset Now = new(2026, 8, 17, 17, 0, 0, TimeSpan.Zero);

    internal static QueryStoreEvidenceV1 QsEvidence(DataStatus status = DataStatus.Available) =>
        new(QueryStoreSource.Fixture, status, Now.AddHours(-1), Now.AddHours(1), "Deterministic test evidence.", "Test caveat.");

    internal static EvidenceV1 Evidence(EvidenceSource source = EvidenceSource.QueryStoreAggregate, DataStatus status = DataStatus.Available) =>
        new(source, status, Now, Now.AddHours(1), "Deterministic test evidence.");

    internal static QueryTextDescriptorV1 Text() =>
        new(QueryTextAvailability.Available, "SELECT 1", "fp", "Sanitized test text.");

    internal static RuntimeBucketV1 Bucket(
        string planId,
        QueryStoreExecutionType type = QueryStoreExecutionType.Regular,
        string replica = "primary",
        string epoch = "e1",
        long count = 100,
        decimal avgDuration = 1000,
        decimal totalDuration = 100000,
        decimal totalCpu = 50000,
        decimal totalReads = 200,
        IReadOnlyDictionary<string, string>? waits = null,
        string interval = "i1") =>
        new(planId, interval, epoch, Now.AddHours(-2), Now.AddHours(-1), type, replica,
            count.ToString(),
            avgDuration, avgDuration / 2, totalReads / Math.Max(count, 1),
            totalDuration.ToString(), totalCpu.ToString(), totalReads.ToString(),
            waits ?? new Dictionary<string, string>(), QsEvidence());

    internal static QueryPlanSummaryV1 Plan(
        string planId,
        QueryPlanType type = QueryPlanType.Compiled,
        QueryOptimizationKind optimization = QueryOptimizationKind.None,
        bool forced = false,
        int forceFailures = 0,
        string? dispatcherId = null,
        DateTimeOffset? lastExecution = null) =>
        new(planId, "q1", "0xhash", type, optimization, dispatcherId, true, forced,
            forced ? "Manual" : null, forceFailures.ToString(), forceFailures > 0 ? "NO_PLAN" : null,
            "16.0", "160", lastExecution ?? Now, QsEvidence());

    internal static QueryFamilyDetailV1 Family(
        string familyId,
        IReadOnlyList<QueryPlanSummaryV1> plans,
        IReadOnlyList<RuntimeBucketV1> runtime,
        string databaseId = "db1",
        decimal totalCpu = 100000,
        DataStatus status = DataStatus.Available)
    {
        var summary = new QueryFamilySummaryV1(
            familyId, databaseId, "0xhash", "fp", Text(), [],
            runtime.Sum(b => long.Parse(b.ExecutionCount)).ToString(),
            totalCpu.ToString(), "100000", "200", "0",
            Now.AddHours(-3), Now, QsEvidence(status));
        return new QueryFamilyDetailV1("1.0", summary, plans, runtime);
    }

    internal static FindingsEvidenceBundle Bundle(
        IReadOnlyList<QueryFamilyDetailV1>? families = null,
        AtlasSnapshotV1? atlas = null,
        LiveIncidentSnapshotV1? live = null,
        IReadOnlyList<NormalizedShowplanV1>? plans = null,
        string targetId = "target-1") =>
        new(targetId, "Test target", Now, null, atlas, live, null,
            families ?? [], plans ?? [], "Deterministic test bundle.");

    internal static AtlasSnapshotV1 Atlas(params DatabaseAtlasItemV1[] databases) =>
        new("1.0", "snap", new AtlasTargetV1("target-1", "Test target", "SQL Server"),
            Now, databases, []);

    internal static DatabaseAtlasItemV1 AtlasDb(
        string id, string name, QueryStoreCapability capability, QueryStoreHealth health,
        DataStatus status, string? current = null, string? max = null) =>
        new($"target-1/database/{id}", name,
            new ByteMeasurementV1("1024", MeasurementStatus.Known, null, Evidence()),
            new ByteMeasurementV1("512", MeasurementStatus.Known, null, Evidence()),
            new LiveActivityV1(1, 1, 0, 1m, Evidence(EvidenceSource.LiveDmvSample)),
            new QueryStoreHistoryV1("100", "800", 1000m, Now.AddHours(-24), Now, capability, health,
                "Test Query Store state.", new EvidenceV1(EvidenceSource.QueryStoreAggregate, status, Now, Now.AddHours(1), "Test."))
            { CurrentStorageBytes = current, MaxStorageBytes = max });

    internal static NormalizedShowplanV1 Showplan(string planId, params ShowplanWarningV1[] warnings) =>
        new("1.0", planId, "1.6", "160", 1024, 512,
            [new ShowplanNodeV1(0, null, "Select", "Select", 100, 0.1m, 0.1m, 0.2m, false, null, null, warnings)],
            QueryOptimizationKind.None, null, "fp", "Compiled plan; no operator timing.", QsEvidence());
}
