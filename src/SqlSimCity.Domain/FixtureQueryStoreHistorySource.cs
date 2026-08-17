using System.Globalization;
using System.Text;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Domain;

public sealed class FixtureQueryStoreHistorySource : IQueryStoreHistorySource
{
    private static readonly DateTimeOffset CapturedAt = new(2026, 8, 17, 17, 3, 0, TimeSpan.Zero);
    private static readonly QueryStoreEvidenceV1 Evidence = new(
        QueryStoreSource.Fixture, DataStatus.Available, CapturedAt, CapturedAt.AddHours(1),
        "Deterministic sanitized Query Store fixture; no SQL Server connection or secret is used.",
        "Compiled plan structure and aggregate query-level runtime; no actual operator progress or actual operator metrics.");
    private readonly IReadOnlyList<QueryFamilyDetailV1> _families;
    private readonly Dictionary<string, NormalizedShowplanV1> _plans;

    public FixtureQueryStoreHistorySource()
    {
        _plans = BuildPlans().ToDictionary(plan => plan.PlanId, StringComparer.Ordinal);
        _families = BuildFamilies();
    }

    public PageV1<QueryFamilySummaryV1> GetQueries(
        string? databaseId,
        string metric,
        int pageSize,
        string? pageToken)
    {
        pageSize = Math.Clamp(pageSize, 1, 200);
        var offset = DecodePageToken(pageToken);
        var query = _families
            .Select(family => family.Family)
            .Where(family => databaseId is null || string.Equals(family.DatabaseId, databaseId, StringComparison.Ordinal));
        var ordered = metric.ToLowerInvariant() switch
        {
            "execution" or "executions" => query.OrderByDescending(family => Parse(family.ExecutionCount)),
            "duration" => query.OrderByDescending(family => Parse(family.TotalDurationMicroseconds)),
            "reads" => query.OrderByDescending(family => Parse(family.TotalLogicalReads8KiBPages)),
            "waits" => query.OrderByDescending(family => Parse(family.TotalWaitMilliseconds)),
            _ => query.OrderByDescending(family => Parse(family.TotalCpuMicroseconds)),
        };

        var all = ordered.ThenBy(family => family.FamilyId, StringComparer.Ordinal).ToArray();
        var items = all.Skip(offset).Take(pageSize).ToArray();
        var next = offset + items.Length < all.Length ? EncodePageToken(offset + items.Length) : null;
        return new PageV1<QueryFamilySummaryV1>(
            "1.0", items, next, pageSize, all.Length.ToString(CultureInfo.InvariantCulture))
        { Evidence = Evidence };
    }

    public QueryFamilyDetailV1? GetFamily(string familyId) =>
        _families.SingleOrDefault(family => string.Equals(family.Family.FamilyId, familyId, StringComparison.Ordinal));

    public NormalizedShowplanV1? GetPlan(string planId) =>
        _plans.TryGetValue(planId, out var plan) ? plan : null;

    public PlanComparisonV1? ComparePlans(string leftPlanId, string rightPlanId)
    {
        if (!_plans.TryGetValue(leftPlanId, out var left) || !_plans.TryGetValue(rightPlanId, out var right)) return null;
        var changes = new List<PlanChangeV1>();
        var ids = left.Nodes.Select(n => n.NodeId).Union(right.Nodes.Select(n => n.NodeId)).Order().ToArray();
        foreach (var id in ids)
        {
            var before = left.Nodes.SingleOrDefault(node => node.NodeId == id);
            var after = right.Nodes.SingleOrDefault(node => node.NodeId == id);
            if (before is null || after is null)
            {
                changes.Add(new PlanChangeV1($"node/{id}", before is null ? "Added" : "Removed",
                    before?.PhysicalOperation, after?.PhysicalOperation));
                continue;
            }
            AddChange(changes, $"node/{id}/topology", before.ParentNodeId?.ToString(CultureInfo.InvariantCulture),
                after.ParentNodeId?.ToString(CultureInfo.InvariantCulture));
            AddChange(changes, $"node/{id}/physicalOperation", before.PhysicalOperation, after.PhysicalOperation);
            AddChange(changes, $"node/{id}/logicalOperation", before.LogicalOperation, after.LogicalOperation);
            AddChange(changes, $"node/{id}/object", ObjectName(before.ObjectReference), ObjectName(after.ObjectReference));
            AddChange(changes, $"node/{id}/predicate", before.Predicate, after.Predicate);
        }

        return new PlanComparisonV1(
            "1.0", leftPlanId, rightPlanId,
            string.Equals(left.StructuralFingerprint, right.StructuralFingerprint, StringComparison.Ordinal),
            changes, "Normalized Query Store Showplan",
            "Structural comparison, not a raw XML line diff. Runtime overlays are query-level aggregates and are not attributed to operators.");
    }

    private static IReadOnlyList<QueryFamilyDetailV1> BuildFamilies()
    {
        var context7 = new QueryContextSettingsV1("7", "us_english", "mdy", "7", "160", "ANSI_NULLS,QUOTED_IDENTIFIER");
        var context9 = new QueryContextSettingsV1("9", "us_english", "ymd", "1", "160", "ANSI_NULLS,QUOTED_IDENTIFIER");
        var text = new QueryTextDescriptorV1(
            QueryTextAvailability.Available,
            "SELECT order_id, total FROM dbo.orders WHERE customer_id = @customer_id",
            "fixture-fingerprint-orders-v1",
            "Sanitized normalized fixture text; raw SQL text is not returned.");
        var physical = new[]
        {
            new PhysicalQueryIdentityV1("sales", "41", "18", "0x94A001", context7, text),
            new PhysicalQueryIdentityV1("sales", "58", "18", "0x94A001", context9, text),
        };
        var plans = new[]
        {
            Plan("sales:200", "41", "0x200", QueryPlanType.Dispatcher,
                QueryOptimizationKind.ParameterSensitivePlan, null, false, false, null, 0, null,
                new DateTimeOffset(2026, 8, 17, 16, 57, 0, TimeSpan.Zero)),
            Plan("sales:201", "41", "0x201", QueryPlanType.Variant,
                QueryOptimizationKind.ParameterSensitivePlan, "sales:200", true, false, null, 0, null,
                new DateTimeOffset(2026, 8, 17, 16, 58, 30, TimeSpan.Zero)),
            Plan("sales:202", "41", "0x202", QueryPlanType.Variant,
                QueryOptimizationKind.ParameterSensitivePlan, "sales:200", true, true, "Manual", 3, "NO_PLAN",
                new DateTimeOffset(2026, 8, 17, 16, 59, 0, TimeSpan.Zero)),
            Plan("sales:300", "41", "0x300", QueryPlanType.Dispatcher,
                QueryOptimizationKind.OptionalParameterPlanOptimization, null, false, false, null, 0, null,
                new DateTimeOffset(2026, 8, 17, 16, 59, 5, TimeSpan.Zero), "17.0", "170"),
            Plan("sales:301", "41", "0x301", QueryPlanType.Variant,
                QueryOptimizationKind.OptionalParameterPlanOptimization, "sales:300", true, false, null, 0, null,
                new DateTimeOffset(2026, 8, 17, 16, 59, 10, TimeSpan.Zero), "17.0", "170"),
        };
        var runtime = new[]
        {
            Runtime("sales:201", "active-01", QueryStoreExecutionType.Regular, "primary", 47, 2_000m, 1_000m, 0.4m, 94_000m, 47_000m, 18.8m),
            Runtime("sales:202", "active-01", QueryStoreExecutionType.Aborted, "primary", 5, 9_000m, 4_500m, 2m, 45_000m, 22_500m, 10m),
            Runtime("sales:202", "active-01", QueryStoreExecutionType.Exception, "primary", 2, 20_000m, 10_000m, 4m, 40_000m, 20_000m, 8m),
            Runtime("sales:301", "active-01", QueryStoreExecutionType.Regular, "replica-2", 1_010,
                3_960.3960396039603960396039604m, 1_980.1980198019801980198019802m, 1m,
                4_000_000m, 2_000_000m, 1_010m),
        };
        var summary = new QueryFamilySummaryV1(
            "qf:sales-orders", "sales", "0x94A001", text.NormalizedTextFingerprint, text, physical,
            "1064", "2089500", "4179000", "1046.8", "287",
            new DateTimeOffset(2026, 8, 17, 16, 0, 0, TimeSpan.Zero), CapturedAt, Evidence);

        var restrictedText = new QueryTextDescriptorV1(
            QueryTextAvailability.Restricted, null, null,
            "Text is restricted; this physical query is deliberately not merged by query_hash alone.");
        var restrictedPhysical = new[]
        {
            new PhysicalQueryIdentityV1("warehouse", "72", "90", "0x94A001",
                new QueryContextSettingsV1("4", null, null, null, "150", "ARITHABORT"), restrictedText),
        };
        var restrictedSummary = new QueryFamilySummaryV1(
            "qf:warehouse-physical-72", "warehouse", "0x94A001", null, restrictedText, restrictedPhysical,
            "12", "24000", "48000", "120", "7",
            CapturedAt.AddHours(-1), CapturedAt, Evidence);
        var restrictedPlans = new[]
        {
            Plan("warehouse:3", "72", "0x003", QueryPlanType.Compiled, QueryOptimizationKind.None,
                null, true, false, null, 0, null, CapturedAt.AddMinutes(-1)),
        };

        return
        [
            new QueryFamilyDetailV1("1.0", summary, plans, runtime),
            new QueryFamilyDetailV1("1.0", restrictedSummary, restrictedPlans,
                [Runtime("warehouse:3", "closed-09", QueryStoreExecutionType.Regular, "primary", 12, 4_000m, 2_000m, 10m, 48_000m, 24_000m, 120m)]),
        ];
    }

    private static IEnumerable<NormalizedShowplanV1> BuildPlans()
    {
        yield return Graph("sales:200", "dispatcher-v1", QueryOptimizationKind.ParameterSensitivePlan,
            "customer_id <= 100 | customer_id > 100", "Dispatcher", "Parameter Sensitive Plan");
        yield return Graph("sales:201", "variant-seek-v1", QueryOptimizationKind.ParameterSensitivePlan,
            "@customer_id <= 100", "Index Seek", "Index Seek");
        yield return Graph("sales:202", "variant-scan-v1", QueryOptimizationKind.ParameterSensitivePlan,
            "@customer_id > 100", "Clustered Index Scan", "Clustered Index Scan");
        yield return Graph("sales:300", "oppo-dispatcher-v1", QueryOptimizationKind.OptionalParameterPlanOptimization,
            "region IS NULL | region IS NOT NULL", "Dispatcher", "Optional Parameter Plan");
        yield return Graph("sales:301", "oppo-variant-v1", QueryOptimizationKind.OptionalParameterPlanOptimization,
            "@region IS NULL", "Index Seek", "Index Seek");
        yield return Graph("warehouse:3", "warehouse-plan-v1", QueryOptimizationKind.None,
            null, "Hash Match", "Hash Match");
    }

    private static NormalizedShowplanV1 Graph(
        string id, string fingerprint, QueryOptimizationKind optimization,
        string? predicate, string logical, string physical) =>
        new("1.0", id, "1.6", "160", 1024, 512,
            [
                new ShowplanNodeV1(0, null, logical, physical, 100, 0.01m, 0.02m, 0.03m, true,
                    null, predicate, []),
                new ShowplanNodeV1(1, 0, "Index Access", physical == "Clustered Index Scan" ? physical : "Index Seek",
                    100, 0.01m, 0.01m, 0.02m, true,
                    new ShowplanObjectV1("[sales]", "[dbo]", "[orders]", "[IX_orders_customer]"), predicate, []),
            ],
            optimization, predicate, fingerprint,
            "Compiled plan with aggregate query runtime only; never actual operator progress.", Evidence);

    private static QueryPlanSummaryV1 Plan(
        string id, string queryId, string hash, QueryPlanType type, QueryOptimizationKind optimization,
        string? dispatcherId, bool runtimeCounted, bool forced, string? forcingType,
        int failures, string? failureReason, DateTimeOffset lastExecution,
        string engineVersion = "16.0", string compatibilityLevel = "160") =>
        new(id, queryId, hash, type, optimization, dispatcherId, runtimeCounted, forced, forcingType,
            failures.ToString(CultureInfo.InvariantCulture), failureReason, engineVersion, compatibilityLevel, lastExecution, Evidence);

    private static RuntimeBucketV1 Runtime(
        string planId, string interval, QueryStoreExecutionType executionType, string replica, long count,
        decimal averageDuration, decimal averageCpu, decimal averageReads,
        decimal totalDuration, decimal totalCpu, decimal totalReads) =>
        new(planId, interval, CapturedAt.AddHours(-1), CapturedAt.AddMinutes(57), executionType, replica,
            count.ToString(CultureInfo.InvariantCulture), averageDuration, averageCpu, averageReads,
            totalDuration.ToString(CultureInfo.InvariantCulture), totalCpu.ToString(CultureInfo.InvariantCulture),
            totalReads.ToString(CultureInfo.InvariantCulture),
            new Dictionary<string, string> { ["CPU"] = "120", ["Lock"] = "7" }, Evidence);

    private static decimal Parse(string value) => decimal.Parse(value, CultureInfo.InvariantCulture);
    private static string? ObjectName(ShowplanObjectV1? value) =>
        value is null ? null : $"{value.Database}.{value.Schema}.{value.Table}.{value.Index}";
    private static void AddChange(List<PlanChangeV1> changes, string path, string? before, string? after)
    {
        if (!string.Equals(before, after, StringComparison.Ordinal))
            changes.Add(new PlanChangeV1(path, "Changed", before, after));
    }
    private static int DecodePageToken(string? token)
    {
        if (token is null) return 0;
        try
        {
            var raw = Encoding.UTF8.GetString(Convert.FromBase64String(token));
            return int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var value) && value >= 0 ? value : 0;
        }
        catch (FormatException) { return 0; }
    }
    private static string EncodePageToken(int offset) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(offset.ToString(CultureInfo.InvariantCulture)));
}
