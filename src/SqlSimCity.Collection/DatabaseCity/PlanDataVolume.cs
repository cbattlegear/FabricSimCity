using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.DatabaseCity;

/// <summary>Estimated bytes one execution of a plan reads from one object reference.</summary>
public sealed record PlanObjectDataVolume(ShowplanObjectV1 Reference, decimal EstimatedBytes);

/// <summary>
/// How many bytes one execution of a compiled plan was expected to move, and which objects it was
/// expected to move them from.
/// <para>
/// <see cref="OperatorsMissingRowSize"/> counts operators that named an object and stated a row
/// count but no row size. Those contribute nothing to <see cref="TotalBytes"/> and are reported
/// separately so a partial figure is never read as a complete one -- a plan that reads a wide table
/// through an operator carrying no <c>AvgRowSize</c> would otherwise look like a small query.
/// </para>
/// </summary>
public sealed record PlanDataVolumeSplit(
    IReadOnlyList<PlanObjectDataVolume> Objects,
    decimal TotalBytes,
    int OperatorsMeasured,
    int OperatorsMissingRowSize)
{
    public static readonly PlanDataVolumeSplit Empty = new([], 0m, 0, 0);

    /// <summary>
    /// False when no operator in the plan carried both a row count and a row size, so no volume can
    /// be claimed. This is "the plan did not say", not "this query moves no data".
    /// </summary>
    public bool HasVolume => OperatorsMeasured > 0;
}

/// <summary>
/// Estimates how much data one execution of a compiled plan moves, from the optimizer's own
/// per-operator <c>EstimateRows</c> and <c>AvgRowSize</c>.
///
/// <para>
/// Like <see cref="PlanCostAttribution"/> this is the optimizer's arithmetic rather than a
/// measurement, and everything downstream is obliged to label it as one. It is an estimate made
/// when the plan was compiled, against the statistics that existed then; a plan whose cardinality
/// estimate is wrong produces a volume figure that is wrong by the same factor. Query Store's
/// measured <c>logical_reads</c> is a genuine measurement of pages touched, but it counts a page
/// once per read -- a nested loop re-reading the same small table ten thousand times reports a huge
/// number for a query moving very little -- so it answers a different question than "how much data
/// is on this road".
/// </para>
///
/// <para>
/// Only operators that name an object contribute. This is deliberately unlike the cost split, which
/// pushes an unattributed operator's cost down onto the objects beneath it. Rows are counted where
/// they enter the plan: every operator above a scan re-emits rows that scan already produced, so
/// summing all operators would count the same bytes once per level and make a deep plan look like
/// it moves several times the data it does. A filter, a sort or a join moves no data <em>into</em>
/// the query; the tables underneath it do.
/// </para>
///
/// <para>
/// For the same reason nothing is apportioned or pushed down here and there is no "unattributed"
/// pool: an operator over no object has no bytes of its own to place.
/// </para>
/// </summary>
public static class PlanDataVolume
{
    /// <summary>
    /// Splits <paramref name="showplan"/>'s estimated per-execution data volume per object
    /// reference. Returns <see cref="PlanDataVolumeSplit.Empty"/> when no operator carried both a
    /// row count and a row size.
    /// </summary>
    public static PlanDataVolumeSplit Split(NormalizedShowplanV1 showplan)
    {
        ArgumentNullException.ThrowIfNull(showplan);

        var byObject = new Dictionary<ShowplanObjectV1, decimal>();
        var measured = 0;
        var missingRowSize = 0;

        foreach (var node in showplan.Nodes)
        {
            if (node.ObjectReference is not { } reference)
            {
                continue;
            }

            // A negative or absent row count is not a row count. Zero is legitimate -- the optimizer
            // expecting no rows from a branch is a real estimate -- and contributes zero bytes
            // without being counted as a gap in the plan's disclosure.
            if (node.EstimatedRows is not { } rows || rows < 0m)
            {
                missingRowSize++;
                continue;
            }

            if (node.EstimatedRowSizeBytes is not { } rowSize || rowSize <= 0m)
            {
                missingRowSize++;
                continue;
            }

            measured++;
            byObject[reference] = byObject.GetValueOrDefault(reference) + (rows * rowSize);
        }

        if (measured == 0)
        {
            // The missing-operator count is still worth reporting: "six operators named an object and
            // none stated a row size" is a different fact from "this plan reads nothing".
            return PlanDataVolumeSplit.Empty with { OperatorsMissingRowSize = missingRowSize };
        }

        // Dictionary enumeration order is not part of the contract, so the published order is fixed
        // here, matching PlanCostAttribution. A city that redraws itself differently on a second read
        // is a city nobody can trust.
        var objects = byObject
            .Select(entry => new PlanObjectDataVolume(entry.Key, entry.Value))
            .OrderBy(entry => entry.Reference.Database ?? string.Empty, StringComparer.Ordinal)
            .ThenBy(entry => entry.Reference.Schema ?? string.Empty, StringComparer.Ordinal)
            .ThenBy(entry => entry.Reference.Table ?? string.Empty, StringComparer.Ordinal)
            .ThenBy(entry => entry.Reference.Index ?? string.Empty, StringComparer.Ordinal)
            .ToArray();

        var total = 0m;
        foreach (var entry in objects)
        {
            total += entry.EstimatedBytes;
        }

        return new PlanDataVolumeSplit(objects, total, measured, missingRowSize);
    }
}
