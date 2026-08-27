using Microsoft.Extensions.Time.Testing;
using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.LiveIncidents;

/// <summary>
/// Guards the one thing this subsystem does that nothing else in the collector does: turn a
/// cumulative counter into an interval count.
/// <para>
/// Every failure mode here is silent in the product. A plan cache reports totals, so an arithmetic
/// mistake does not throw, does not degrade a <see cref="DataStatus"/>, and does not empty the feed
/// -- it produces a plausible-looking number that is wrong, and the only visible symptom is a city
/// that looks busier or quieter than the instance actually is. That is why these are asserted on
/// counts rather than on shape.
/// </para>
/// </summary>
public sealed class CompletedQueryCollectionTests
{
    private static readonly DateTimeOffset EngineStart = new(2026, 3, 1, 8, 0, 0, TimeSpan.Zero);

    private static CompletedQueryRow Row(
        string planKey,
        long executionCount,
        DateTimeOffset sampledAt,
        DateTimeOffset? creationTime = null,
        DateTimeOffset? lastExecution = null,
        int visiblePlanCount = 1) => new(
            planKey,
            sampledAt,
            creationTime ?? EngineStart,
            lastExecution ?? sampledAt,
            executionCount,
            TotalWorkerTimeUs: executionCount * 100,
            LastWorkerTimeUs: 100,
            TotalElapsedTimeUs: executionCount * 200,
            LastElapsedTimeUs: 200,
            TotalLogicalReads: executionCount * 8,
            LastLogicalReads: 8,
            TotalRows: executionCount,
            LastRows: 1,
            QueryHash: null,
            QueryPlanHash: null,
            DatabaseId: 5,
            DatabaseName: "AdventureWorks",
            VisiblePlanCount: visiblePlanCount,
            SelectionRank: 1,
            BatchTextLength: null,
            BatchText: null,
            StatementTextLength: null,
            StatementText: "SELECT 1");

    private static LiveIncidentCollector Collector(FakeLiveIncidentProbeExecutor probes, FakeTimeProvider time) =>
        new(probes, "target", "Target", time, configuredPlatform: EnginePlatform.SqlServerOnPremises);

    private static FakeLiveIncidentProbeExecutor Probes() => new()
    {
        ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
    };

    /// <summary>
    /// The first sight of a plan reports one execution, not its lifetime total.
    /// <para>
    /// The measured instance held a plan with <c>execution_count</c> of 71,787. Passing a cumulative
    /// total straight through claims all 71,787 happened in the last three seconds, which on the map
    /// is 71,787 vehicles for one query. One is the floor the evidence supports: the probe's
    /// watermark already established that this plan ran inside the interval.
    /// </para>
    /// </summary>
    [Fact]
    public async Task AFirstObservationReportsOneExecutionRatherThanTheLifetimeTotal()
    {
        var time = new FakeTimeProvider(EngineStart.AddHours(1));
        var probes = Probes();
        var sampledAt = EngineStart.AddHours(1);
        probes.CompletedQueries = (_, _, _, _, _) =>
            Task.FromResult<IReadOnlyList<CompletedQueryRow>>([Row("p1", 71_787, sampledAt)]);

        var snapshot = await Collector(probes, time).CollectAsync(1, CancellationToken.None);

        var query = Assert.Single(snapshot.CompletedQueries.Queries);
        Assert.Equal(1, query.Executions);
        Assert.True(query.FirstObservation);
        Assert.Equal(1, snapshot.CompletedQueries.TotalExecutions);
    }

    /// <summary>
    /// The second sample reports the difference, which is the whole point of holding state.
    /// </summary>
    [Fact]
    public async Task ASubsequentSampleReportsTheDeltaNotTheRunningTotal()
    {
        var time = new FakeTimeProvider(EngineStart.AddHours(1));
        var probes = Probes();
        var count = 71_787L;
        var sampledAt = EngineStart.AddHours(1);
        probes.CompletedQueries = (_, _, _, _, _) =>
            Task.FromResult<IReadOnlyList<CompletedQueryRow>>([Row("p1", count, sampledAt)]);

        var collector = Collector(probes, time);
        await collector.CollectAsync(1, CancellationToken.None);

        count = 71_791;
        sampledAt = sampledAt.AddSeconds(3);
        time.Advance(TimeSpan.FromSeconds(3));
        var second = await collector.CollectAsync(2, CancellationToken.None);

        var query = Assert.Single(second.CompletedQueries.Queries);
        Assert.Equal(4, query.Executions);
        Assert.False(query.FirstObservation);
    }

    /// <summary>
    /// A plan the probe returned but whose counter did not move contributes nothing.
    /// <para>
    /// This is the ordinary case, not an edge case: the watermark is a coarse prefilter, so a plan
    /// that last ran between the watermark and the previous read comes back on every sample until it
    /// ages out of the window. Emitting it would put a vehicle on the map for a query that did not
    /// run, every cycle, forever.
    /// </para>
    /// </summary>
    [Fact]
    public async Task APlanWhoseCounterDidNotMoveIsNotReportedAtAll()
    {
        var time = new FakeTimeProvider(EngineStart.AddHours(1));
        var probes = Probes();
        var sampledAt = EngineStart.AddHours(1);
        probes.CompletedQueries = (_, _, _, _, _) =>
            Task.FromResult<IReadOnlyList<CompletedQueryRow>>([Row("p1", 500, sampledAt)]);

        var collector = Collector(probes, time);
        await collector.CollectAsync(1, CancellationToken.None);

        sampledAt = sampledAt.AddSeconds(3);
        time.Advance(TimeSpan.FromSeconds(3));
        var second = await collector.CollectAsync(2, CancellationToken.None);

        Assert.Empty(second.CompletedQueries.Queries);
        Assert.Equal(0, second.CompletedQueries.TotalExecutions);
        Assert.Equal(DataStatus.Available, second.CompletedQueries.Status);
    }

    /// <summary>
    /// A recompile restarts the counter, and the executions since the restart are what is reported.
    /// <para>
    /// This is the trap that motivated storing <c>creation_time</c> at all. Eviction, recompile,
    /// <c>DBCC FREEPROCCACHE</c> and an engine restart all reuse the plan key with the counter back
    /// near zero. Differencing gives a large negative number; clamping that to zero means the plan
    /// reports nothing until it climbs back past its old value, which for the 71,787-execution plan
    /// measured here is a very long silence in the middle of a busy instance.
    /// </para>
    /// </summary>
    [Fact]
    public async Task ARecompiledPlanCountsFromItsNewCompileRatherThanGoingSilent()
    {
        var time = new FakeTimeProvider(EngineStart.AddHours(1));
        var probes = Probes();
        var count = 71_787L;
        var creation = EngineStart;
        var sampledAt = EngineStart.AddHours(1);
        probes.CompletedQueries = (_, _, _, _, _) =>
            Task.FromResult<IReadOnlyList<CompletedQueryRow>>([Row("p1", count, sampledAt, creation)]);

        var collector = Collector(probes, time);
        await collector.CollectAsync(1, CancellationToken.None);

        // Recompiled: same plan key, new compile time, counter restarted at 3.
        count = 3;
        creation = EngineStart.AddHours(1);
        sampledAt = sampledAt.AddSeconds(3);
        time.Advance(TimeSpan.FromSeconds(3));
        var second = await collector.CollectAsync(2, CancellationToken.None);

        var query = Assert.Single(second.CompletedQueries.Queries);
        Assert.Equal(3, query.Executions);
        Assert.False(query.FirstObservation);
        Assert.Contains("recompiled", second.CompletedQueries.Reason, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// A failed read leaves the watermark where it was, so the next successful read covers the gap.
    /// <para>
    /// Advancing a watermark past an interval that was never read discards every execution in it
    /// permanently, and nothing downstream can tell that happened -- the feed simply has a hole. The
    /// counters make this safe: re-covering an interval cannot double-count, because the delta is
    /// computed against the last observation rather than against the watermark.
    /// </para>
    /// </summary>
    [Fact]
    public async Task AFailedReadKeepsTheWatermarkSoTheNextReadCoversTheMissedInterval()
    {
        var time = new FakeTimeProvider(EngineStart.AddHours(1));
        var probes = Probes();
        var sampledAt = EngineStart.AddHours(1);
        probes.CompletedQueries = (_, _, _, _, _) =>
            Task.FromResult<IReadOnlyList<CompletedQueryRow>>([Row("p1", 10, sampledAt)]);

        var collector = Collector(probes, time);
        await collector.CollectAsync(1, CancellationToken.None);

        probes.CompletedQueries = (_, _, _, _, _) =>
            throw new ProbeTimeoutException("The completed-query probe timed out.", null, null);
        time.Advance(TimeSpan.FromSeconds(3));
        var failed = await collector.CollectAsync(2, CancellationToken.None);

        // The failed cycle asked from where cycle 1 got to, which is the engine's clock and not this
        // process's -- the fake records the argument, so this is what the collector really requested.
        Assert.Equal(sampledAt, probes.LastCompletedQueryWatermark);
        Assert.NotEqual(DataStatus.Available, failed.CompletedQueries.Status);
        Assert.Empty(failed.CompletedQueries.Queries);
        Assert.Contains(
            failed.Diagnostics.UnavailableFields,
            field => field.Field == "completedQueries");

        // The third cycle must ask from the same point the last SUCCESSFUL read reached. If the
        // failure had advanced the watermark, this would be cycle 2's time and the four executions
        // below would be gone for good.
        probes.CompletedQueries = (_, _, _, _, _) =>
            Task.FromResult<IReadOnlyList<CompletedQueryRow>>([Row("p1", 14, sampledAt.AddSeconds(6))]);
        time.Advance(TimeSpan.FromSeconds(3));
        var recovered = await collector.CollectAsync(3, CancellationToken.None);

        Assert.Equal(sampledAt, probes.LastCompletedQueryWatermark);
        var query = Assert.Single(recovered.CompletedQueries.Queries);
        Assert.Equal(4, query.Executions);
    }

    /// <summary>
    /// A capped read says so, so a truncated view is never read as a quieter instance.
    /// </summary>
    [Fact]
    public async Task ACappedSampleDisclosesHowManyPlansWereDropped()
    {
        var time = new FakeTimeProvider(EngineStart.AddHours(1));
        var probes = Probes();
        var sampledAt = EngineStart.AddHours(1);
        probes.CompletedQueries = (_, _, _, _, _) =>
            Task.FromResult<IReadOnlyList<CompletedQueryRow>>([Row("p1", 10, sampledAt, visiblePlanCount: 400)]);

        var snapshot = await Collector(probes, time).CollectAsync(1, CancellationToken.None);

        Assert.Contains("400", snapshot.CompletedQueries.Reason);
        Assert.Contains("row cap", snapshot.CompletedQueries.Reason, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Plans that stop being reported stop being remembered, so the differencing state is bounded by
    /// the plan cache rather than by process uptime.
    /// </summary>
    [Fact]
    public async Task AVanishedPlanIsForgottenAndReadsAsAFirstObservationIfItReturns()
    {
        var time = new FakeTimeProvider(EngineStart.AddHours(1));
        var probes = Probes();
        var sampledAt = EngineStart.AddHours(1);
        probes.CompletedQueries = (_, _, _, _, _) =>
            Task.FromResult<IReadOnlyList<CompletedQueryRow>>([Row("p1", 10, sampledAt)]);

        var collector = Collector(probes, time);
        await collector.CollectAsync(1, CancellationToken.None);

        probes.CompletedQueries = (_, _, _, _, _) =>
            Task.FromResult<IReadOnlyList<CompletedQueryRow>>([]);
        time.Advance(TimeSpan.FromSeconds(3));
        await collector.CollectAsync(2, CancellationToken.None);

        probes.CompletedQueries = (_, _, _, _, _) =>
            Task.FromResult<IReadOnlyList<CompletedQueryRow>>([Row("p1", 99, sampledAt.AddSeconds(6))]);
        time.Advance(TimeSpan.FromSeconds(3));
        var third = await collector.CollectAsync(3, CancellationToken.None);

        var query = Assert.Single(third.CompletedQueries.Queries);
        Assert.True(query.FirstObservation);
        Assert.Equal(1, query.Executions);
    }

    /// <summary>
    /// Per-execution figures describe the execution that happened, never the plan's lifetime average.
    /// </summary>
    [Fact]
    public async Task ReportedTimingsAreTheLastExecutionsNotTheLifetimeAverage()
    {
        var time = new FakeTimeProvider(EngineStart.AddHours(1));
        var probes = Probes();
        var sampledAt = EngineStart.AddHours(1);
        probes.CompletedQueries = (_, _, _, _, _) =>
            Task.FromResult<IReadOnlyList<CompletedQueryRow>>([Row("p1", 1_000, sampledAt)]);

        var snapshot = await Collector(probes, time).CollectAsync(1, CancellationToken.None);

        var query = Assert.Single(snapshot.CompletedQueries.Queries);
        Assert.Equal(200, query.LastElapsedTimeUs);
        Assert.Equal(100, query.LastWorkerTimeUs);
        Assert.Equal(8, query.LastLogicalReads);
    }
}
