using System.Globalization;
using System.Numerics;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Domain.DatabaseCity;

/// <summary>One on-page object's estimated share of a plan's cost, before any wait time is split by it.</summary>
public sealed record ObjectCostShare(string ObjectId, decimal Share);

/// <summary>
/// Divides a query family's measured wait milliseconds between objects using estimated plan cost
/// shares, exactly.
///
/// <para>
/// The parts and the unattributed remainder always sum to the original total. That is not a nicety:
/// an apportionment that does not reconcile is indistinguishable from an invented number, and this
/// codebase already refuses partial accounts elsewhere -- a wait-category breakdown is withheld
/// entirely unless it reconciles with the family total. Integer arithmetic with largest-remainder
/// allocation keeps the same promise here, so the split can always be added back up and checked.
/// </para>
///
/// <para>
/// Shares are expected to sum to at most 1. Whatever they leave over becomes the unattributed
/// remainder, which is how cost the plan spent on no object, and cost it spent on objects this page
/// does not draw, stay off the buildings that are drawn.
/// </para>
/// </summary>
public static class WaitApportionment
{
    /// <summary>
    /// Fixed-point denominator for share arithmetic. Large enough that rounding never moves a
    /// millisecond on any realistic total, small enough to stay exact in <see cref="decimal"/>.
    /// </summary>
    public const int ShareScale = 1_000_000_000;

    /// <summary>Digits retained on the published share, so two reads of one plan publish one number.</summary>
    public const int ShareDigits = 6;

    public static DatabaseCityWaitAttributionV1 Apportion(
        IReadOnlyList<ObjectCostShare> shares,
        string totalWaitMilliseconds,
        int plansRead,
        string rationale)
    {
        ArgumentNullException.ThrowIfNull(shares);
        ArgumentNullException.ThrowIfNull(rationale);

        if (!BigInteger.TryParse(
                totalWaitMilliseconds, NumberStyles.None, CultureInfo.InvariantCulture, out var total) ||
            total < BigInteger.Zero)
        {
            return DatabaseCityWaitAttributionV1.None;
        }

        if (shares.Count == 0)
        {
            return new DatabaseCityWaitAttributionV1(
                [], total.ToString(CultureInfo.InvariantCulture), plansRead, rationale);
        }

        var scaled = new List<BigInteger>(shares.Count);
        var running = BigInteger.Zero;
        foreach (var share in shares)
        {
            var clamped = share.Share <= 0m ? 0m : share.Share >= 1m ? 1m : share.Share;
            var units = (BigInteger)decimal.Round(clamped * ShareScale, 0, MidpointRounding.AwayFromZero);
            scaled.Add(units);
            running += units;
        }

        // Rounding each share independently can push their sum a few units past the whole. Take the
        // excess off the largest, which is the one least distorted by losing it.
        if (running > ShareScale)
        {
            var excess = running - ShareScale;
            var largest = 0;
            for (var index = 1; index < scaled.Count; index += 1)
                if (scaled[index] > scaled[largest]) largest = index;
            scaled[largest] = BigInteger.Max(BigInteger.Zero, scaled[largest] - excess);
            running = BigInteger.Zero;
            foreach (var units in scaled) running += units;
        }

        // The remainder rides along as one more bucket so every millisecond of the measured total is
        // allocated somewhere and the parts add back up to it.
        var buckets = new List<Bucket>(shares.Count + 1);
        for (var index = 0; index < shares.Count; index += 1)
            buckets.Add(Bucket.For(shares[index].ObjectId, scaled[index], total));
        buckets.Add(Bucket.For(null, ShareScale - running, total));

        var allocated = BigInteger.Zero;
        foreach (var bucket in buckets) allocated += bucket.Whole;

        var deficit = total - allocated;
        if (deficit > BigInteger.Zero)
        {
            // Largest remainder first; ties broken by object id so the same plan always splits the
            // same way. The unattributed bucket sorts last, so a tie never quietly takes a
            // millisecond off a building that earned it.
            var ranked = buckets
                .Select((bucket, index) => (bucket, index))
                .OrderByDescending(entry => entry.bucket.Remainder)
                .ThenBy(entry => entry.bucket.ObjectId is null ? 1 : 0)
                .ThenBy(entry => entry.bucket.ObjectId ?? string.Empty, StringComparer.Ordinal)
                .ToArray();
            for (var index = 0; index < ranked.Length && deficit > BigInteger.Zero; index += 1)
            {
                buckets[ranked[index].index] = ranked[index].bucket with { Whole = ranked[index].bucket.Whole + 1 };
                deficit -= 1;
            }
        }

        var objects = new List<DatabaseCityObjectWaitShareV1>(shares.Count);
        for (var index = 0; index < shares.Count; index += 1)
        {
            objects.Add(new DatabaseCityObjectWaitShareV1(
                shares[index].ObjectId,
                decimal.Round(shares[index].Share, ShareDigits, MidpointRounding.AwayFromZero),
                buckets[index].Whole.ToString(CultureInfo.InvariantCulture)));
        }

        return new DatabaseCityWaitAttributionV1(
            objects,
            buckets[^1].Whole.ToString(CultureInfo.InvariantCulture),
            plansRead,
            rationale);
    }

    private readonly record struct Bucket(string? ObjectId, BigInteger Whole, BigInteger Remainder)
    {
        public BigInteger Whole { get; init; } = Whole;

        public static Bucket For(string? objectId, BigInteger units, BigInteger total)
        {
            if (units <= BigInteger.Zero) return new Bucket(objectId, BigInteger.Zero, BigInteger.Zero);
            var numerator = total * units;
            return new Bucket(objectId, numerator / ShareScale, numerator % ShareScale);
        }
    }
}
