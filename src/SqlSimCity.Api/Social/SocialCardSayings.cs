namespace SqlSimCity.Api.Social;

/// <summary>
/// What the share card says it is doing, borrowed verbatim from the city loading screen.
/// </summary>
/// <remarks>
/// <para>
/// A mirror, not a source. The list belongs to <c>web/src/cityLoadingSayings.ts</c>, and
/// <c>SocialCardSayingsTests</c> reads that file as source text and fails if the two disagree, so a
/// saying added to the loading screen cannot quietly go missing from the card.
/// </para>
/// <para>
/// A mirror is needed because the container build never puts the two in the same place: the web
/// stage copies <c>web/</c> and the API stage copies only <c>src/</c>, <c>sql/</c>, <c>fixtures/</c>
/// and the built <c>web/dist</c>. There is no path from this assembly to that file at build time,
/// and reading it at run time would make the card depend on a source tree the image does not ship.
/// </para>
/// <para>
/// These are decoration and nothing here reports a real stage of anything, which is the same
/// contract the loading screen keeps. The card's measured claims are the numbers drawn on it.
/// </para>
/// </remarks>
public static class SocialCardSayings
{
    public static readonly IReadOnlyList<string> All =
    [
        "Reticulating splines",
        "Surveying the tablespace",
        "Zoning the dbo district",
        "Pouring foundations for wide tables",
        "Negotiating with the query optimiser",
        "Issuing building permits to new tables",
        "Painting crosswalks between foreign keys",
        "Persuading the cardinality estimator",
        "Timing traffic lights to the checkpoint interval",
        "Draining the transaction log",
        "Sweeping up orphaned pages",
        "Widening arterials for parallel scans",
        "Rehousing displaced row versions",
        "Assessing property tax on heap tables",
        "Naming streets after their busiest column",
        "Installing streetlights along the critical path",
        "Filing a variance for a missing index",
        "Escalating a residential lock to the whole block",
        "Convincing the plan cache to stay warm",
        "Counting 8-KiB pages by hand",
        "Grading terrain to the fill factor",
        "Dispatching inspectors to the fragmentation site",
        "Towing abandoned temp tables",
        "Posting speed limits by estimated row count",
        "Consulting the statistics histogram",
        "Auditing the buffer pool for vacancies",
        "Composting expired statistics",
        "Bribing the lazy writer",
        "Laying kerbstones along the covering index",
        "Simulating rush hour on the primary key",
        "Rebuilding the bridge over the join",
        "Distributing waits proportionally to cost",
        "Chalking parking spaces for row locks",
        "Interviewing the wait statistics",
        "Repainting lane markings on the hot path",
        "Petitioning the planner for a wider road",
        "Enumerating civic facilities",
        "Extrapolating commuter patterns from Query Store",
        "Waking the checkpoint crew",
        "Aligning the skyline to reserved pages",
        "Handing out addresses to unnamed objects",
        "Cordoning off a blocked intersection",
        "Approving the annexation of a new schema",
        "Calibrating the traffic cameras",
        "Ageing facades to match their first write",
        "Rounding up stray cursors",
        "Filing the tempdb spill report",
        "Dredging the log reuse channel",
        "Planting street trees at ninety percent fill factor",
        "Synchronising the town clock with UTC",
        "Evicting squatters from the buffer cache",
        "Counting cars at the nested loop",
        "Surveying the floodplain for tempdb",
        "Lobbying for a covering index",
        "Recycling condemned execution plans",
        "Snapping buildings to their block frontage",
        "Warming the pavement for the first query",
        "Numbering lots in catalogue order",
        "Reconciling the census with sys.objects",
        "Teaching drivers to avoid the table scan",
        "Testing the fire hydrants near the log",
        "Sorting residents by CPU consumed",
        "Inflating property values on hot tables",
        "Scheduling maintenance on the clustered index",
        "Unrolling the ribbon between two districts",
        "Measuring the queue at the lock office",
    ];

    /// <summary>
    /// Picks a saying from <paramref name="seed"/>, so the same request produces the same line.
    /// </summary>
    /// <remarks>
    /// Deterministic on purpose. A crawler fetches the page more than once -- a preview, then a
    /// refresh, then whatever the next reader's client does -- and a line that changed between two
    /// fetches of the same URL would make the card look unstable rather than playful. Varying by
    /// seed instead means two different links differ, and one link is itself.
    /// </remarks>
    public static string Pick(long seed)
    {
        // Non-negative before the modulus: long.MinValue has no positive counterpart, so Math.Abs
        // throws on it rather than wrapping, and a remainder can otherwise be negative.
        var index = (int)((ulong)seed % (ulong)All.Count);
        return All[index];
    }
}
