using System.Security.Cryptography;
using System.Text;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.QueryStore;

public sealed record RuntimeStatInput(
    string PlanId,
    string IntervalId,
    DateTimeOffset IntervalStart,
    DateTimeOffset IntervalEnd,
    QueryStoreExecutionType ExecutionType,
    string ReplicaGroupId,
    long ExecutionCount,
    decimal AverageDurationMicroseconds,
    decimal AverageCpuMicroseconds,
    decimal AverageLogicalReads8KiBPages);

public sealed record RuntimeBucketKey(
    string PlanId,
    string IntervalId,
    DateTimeOffset IntervalStart,
    DateTimeOffset IntervalEnd,
    QueryStoreExecutionType ExecutionType,
    string ReplicaGroupId);

public sealed record AggregatedRuntimeBucket(
    RuntimeBucketKey Key,
    long ExecutionCount,
    decimal AverageDurationMicroseconds,
    decimal AverageCpuMicroseconds,
    decimal AverageLogicalReads8KiBPages,
    decimal TotalDurationMicroseconds,
    decimal TotalCpuMicroseconds,
    decimal TotalLogicalReads8KiBPages);

public static class QueryStoreRuntimeAggregator
{
    public static IReadOnlyList<AggregatedRuntimeBucket> Aggregate(IEnumerable<RuntimeStatInput> rows)
    {
        ArgumentNullException.ThrowIfNull(rows);
        return rows
            .GroupBy(row => new RuntimeBucketKey(
                row.PlanId, row.IntervalId, row.IntervalStart, row.IntervalEnd,
                row.ExecutionType, row.ReplicaGroupId))
            .Select(group =>
            {
                var count = group.Sum(row => row.ExecutionCount);
                var duration = group.Sum(row => row.AverageDurationMicroseconds * row.ExecutionCount);
                var cpu = group.Sum(row => row.AverageCpuMicroseconds * row.ExecutionCount);
                var reads = group.Sum(row => row.AverageLogicalReads8KiBPages * row.ExecutionCount);
                return new AggregatedRuntimeBucket(
                    group.Key, count,
                    count == 0 ? 0 : duration / count,
                    count == 0 ? 0 : cpu / count,
                    count == 0 ? 0 : reads / count,
                    duration, cpu, reads);
            })
            .OrderBy(bucket => bucket.Key.IntervalStart)
            .ThenBy(bucket => bucket.Key.PlanId, StringComparer.Ordinal)
            .ThenBy(bucket => bucket.Key.ExecutionType)
            .ThenBy(bucket => bucket.Key.ReplicaGroupId, StringComparer.Ordinal)
            .ToArray();
    }
}

public sealed record QueryFamilyIdentity(
    string FamilyId,
    string DatabaseId,
    string QueryHash,
    string? NormalizedTextFingerprint,
    string PhysicalFallbackId)
{
    public static QueryFamilyIdentity Create(
        string databaseId,
        string queryHash,
        string? normalizedText,
        string physicalQueryId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databaseId);
        ArgumentException.ThrowIfNullOrWhiteSpace(queryHash);
        ArgumentException.ThrowIfNullOrWhiteSpace(physicalQueryId);

        var fingerprint = normalizedText is null ? null : Hash(normalizedText);
        var discriminator = fingerprint ?? $"physical:{physicalQueryId}";
        return new QueryFamilyIdentity(
            $"qf:{Hash($"{databaseId}\n{queryHash}\n{discriminator}")}",
            databaseId, queryHash, fingerprint, physicalQueryId);
    }

    private static string Hash(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
}
