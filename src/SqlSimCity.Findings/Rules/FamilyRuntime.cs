using SqlSimCity.Contracts.V1;
using SqlSimCity.Findings.Engine;

namespace SqlSimCity.Findings.Rules;

/// <summary>A per-plan roll-up of comparable Query Store runtime buckets, preserving exact execution counts.</summary>
internal sealed record PlanAggregate(
    string PlanId,
    decimal ExecutionCount,
    decimal TotalDurationMicroseconds,
    decimal TotalCpuMicroseconds,
    decimal TotalLogicalReads)
{
    internal decimal AverageDurationMicroseconds => ExecutionCount > 0 ? TotalDurationMicroseconds / ExecutionCount : 0m;
    internal decimal AverageCpuMicroseconds => ExecutionCount > 0 ? TotalCpuMicroseconds / ExecutionCount : 0m;
}

/// <summary>
/// Deterministic aggregation helpers over a family's runtime buckets. Comparisons only ever combine
/// buckets that share a replica group, epoch, and execution type, so a regression is never inferred
/// across incomparable windows (requirement 4). Exact counts are preserved as decimals throughout.
/// </summary>
internal static class FamilyRuntime
{
    internal static IReadOnlyList<PlanAggregate> AggregateByPlan(IEnumerable<RuntimeBucketV1> buckets)
    {
        return buckets
            .GroupBy(bucket => bucket.PlanId, StringComparer.Ordinal)
            .Select(group => new PlanAggregate(
                group.Key,
                group.Sum(b => FindingImpact.Parse(b.ExecutionCount)),
                group.Sum(b => FindingImpact.Parse(b.TotalDurationMicroseconds)),
                group.Sum(b => FindingImpact.Parse(b.TotalCpuMicroseconds)),
                group.Sum(b => FindingImpact.Parse(b.TotalLogicalReads8KiBPages))))
            .OrderBy(aggregate => aggregate.PlanId, StringComparer.Ordinal)
            .ToArray();
    }

    /// <summary>Groups Regular-execution buckets into comparable (replica, epoch) slices.</summary>
    internal static IEnumerable<IGrouping<(string Replica, string Epoch), RuntimeBucketV1>> ComparableRegularSlices(
        QueryFamilyDetailV1 family) =>
        family.Runtime
            .Where(bucket => bucket.ExecutionType == QueryStoreExecutionType.Regular)
            .GroupBy(bucket => (bucket.ReplicaGroupId, bucket.EpochId))
            .OrderBy(group => group.Key.ReplicaGroupId, StringComparer.Ordinal)
            .ThenBy(group => group.Key.EpochId, StringComparer.Ordinal);

    internal static DateTimeOffset? EarliestInterval(QueryFamilyDetailV1 family) =>
        family.Runtime.Count == 0 ? null : family.Runtime.Min(bucket => bucket.IntervalStart);

    internal static DateTimeOffset? LatestInterval(QueryFamilyDetailV1 family) =>
        family.Runtime.Count == 0 ? null : family.Runtime.Max(bucket => bucket.IntervalEnd);
}
