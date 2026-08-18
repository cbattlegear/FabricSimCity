using System.Security.Cryptography;
using System.Text;
using System.Globalization;
using System.Numerics;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.QueryStore;

public sealed record RuntimeStatInput(
    string PlanId,
    string IntervalId,
    DateTimeOffset IntervalStart,
    DateTimeOffset IntervalEnd,
    QueryStoreExecutionType ExecutionType,
    string ReplicaGroupId,
    BigInteger ExecutionCount,
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
    BigInteger ExecutionCount,
    decimal AverageDurationMicroseconds,
    decimal AverageCpuMicroseconds,
    decimal AverageLogicalReads8KiBPages,
    string TotalDurationMicroseconds,
    string TotalCpuMicroseconds,
    string TotalLogicalReads8KiBPages);

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
                var count = group.Aggregate(BigInteger.Zero, (total, row) => total + row.ExecutionCount);
                var duration = new BigDecimalAccumulator();
                var cpu = new BigDecimalAccumulator();
                var reads = new BigDecimalAccumulator();
                foreach (var row in group)
                {
                    duration.Add(row.AverageDurationMicroseconds, row.ExecutionCount);
                    cpu.Add(row.AverageCpuMicroseconds, row.ExecutionCount);
                    reads.Add(row.AverageLogicalReads8KiBPages, row.ExecutionCount);
                }
                return new AggregatedRuntimeBucket(
                    group.Key, count,
                    duration.Average(count),
                    cpu.Average(count),
                    reads.Average(count),
                    duration.ToExactString(), cpu.ToExactString(), reads.ToExactString());
            })
            .OrderBy(bucket => bucket.Key.IntervalStart)
            .ThenBy(bucket => bucket.Key.PlanId, StringComparer.Ordinal)
            .ThenBy(bucket => bucket.Key.ExecutionType)
            .ThenBy(bucket => bucket.Key.ReplicaGroupId, StringComparer.Ordinal)
            .ToArray();
    }

    internal sealed class BigDecimalAccumulator
    {
        private BigInteger _unscaled;
        private int _scale;

        public void Add(decimal value, BigInteger multiplier)
        {
            var (unscaled, scale) = Parts(value);
            if (scale > _scale)
            {
                _unscaled *= BigInteger.Pow(10, scale - _scale);
                _scale = scale;
            }
            else if (scale < _scale)
            {
                unscaled *= BigInteger.Pow(10, _scale - scale);
            }
            _unscaled += unscaled * multiplier;
        }

        public void AddExact(string value)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(value);
            var span = value.AsSpan();
            var negative = span[0] == '-';
            if (negative) span = span[1..];
            var point = span.IndexOf('.');
            var scale = point < 0 ? 0 : span.Length - point - 1;
            var digits = point < 0 ? span.ToString() : string.Concat(span[..point], span[(point + 1)..]);
            var unscaled = BigInteger.Parse(digits, CultureInfo.InvariantCulture);
            if (negative) unscaled = -unscaled;
            if (scale > _scale)
            {
                _unscaled *= BigInteger.Pow(10, scale - _scale);
                _scale = scale;
            }
            else if (scale < _scale)
            {
                unscaled *= BigInteger.Pow(10, _scale - scale);
            }
            _unscaled += unscaled;
        }

        public decimal Average(BigInteger count)
        {
            if (count.IsZero) return 0;
            var denominator = count * BigInteger.Pow(10, _scale);
            var sign = _unscaled.Sign < 0 ? "-" : "";
            var scaled = BigInteger.Divide(BigInteger.Abs(_unscaled) * BigInteger.Pow(10, 28), denominator);
            var digits = scaled.ToString(CultureInfo.InvariantCulture).PadLeft(29, '0');
            var text = $"{sign}{digits[..^28]}.{digits[^28..]}".TrimEnd('0').TrimEnd('.');
            return decimal.Parse(text, CultureInfo.InvariantCulture);
        }

        public string ToExactString()
        {
            var sign = _unscaled.Sign < 0 ? "-" : "";
            var digits = BigInteger.Abs(_unscaled).ToString(CultureInfo.InvariantCulture);
            if (_scale == 0) return sign + digits;
            digits = digits.PadLeft(_scale + 1, '0');
            return $"{sign}{digits[..^_scale]}.{digits[^_scale..]}".TrimEnd('0').TrimEnd('.');
        }

        private static (BigInteger Unscaled, int Scale) Parts(decimal value)
        {
            var bits = decimal.GetBits(value);
            var unscaled = (BigInteger)(uint)bits[0] |
                           (BigInteger)(uint)bits[1] << 32 |
                           (BigInteger)(uint)bits[2] << 64;
            if ((bits[3] & int.MinValue) != 0) unscaled = -unscaled;
            return (unscaled, (bits[3] >> 16) & 0x7f);
        }
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
