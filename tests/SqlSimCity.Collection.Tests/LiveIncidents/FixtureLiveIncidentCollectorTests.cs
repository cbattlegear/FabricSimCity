using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.LiveIncidents;

/// <summary>
/// Verifies <see cref="FixtureLiveIncidentCollector"/> correctly maps <c>fixtures/v1/live-cases.json</c>
/// into <see cref="LiveIncidentSnapshotV1"/> -- the default, no-credentials API path -- including its
/// chain/sentinel/parallel-wait/disappeared/plan-unavailable/waiting-grant cases (requirement 7).
/// </summary>
public class FixtureLiveIncidentCollectorTests
{
    [Fact]
    public async Task ProducesAnAvailableSnapshotWithNoLiveConnection()
    {
        var collector = new FixtureLiveIncidentCollector(TimeProvider.System);
        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        Assert.Equal(DataStatus.Available, snapshot.Status);
        Assert.Equal(6, snapshot.Requests.Count);
        Assert.Equal("1.0", snapshot.SchemaVersion);
    }

    [Fact]
    public async Task DisappearedFixtureRequestSurfacesAsDisappearedNotSilentlyOmitted()
    {
        var collector = new FixtureLiveIncidentCollector(TimeProvider.System);
        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        var gone = Assert.Single(snapshot.Requests, r => r.RequestId == "req:gone");
        Assert.Equal(SampleAvailability.Disappeared, gone.Availability);
        Assert.NotNull(gone.AvailabilityReason);
    }

    [Fact]
    public async Task PlanUnavailableFixtureRequestReportsUnavailablePlanNeverAFabricatedPlan()
    {
        var collector = new FixtureLiveIncidentCollector(TimeProvider.System);
        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        var planCase = Assert.Single(snapshot.Requests, r => r.RequestId == "req:plan-unavailable");
        Assert.Equal(PlanCollectionState.Unavailable, planCase.PlanState);
        Assert.NotNull(planCase.PlanReason);
    }

    [Fact]
    public async Task SentinelBlockingSessionIdMinusFiveIsPreservedNotCoercedToZeroOrNull()
    {
        var collector = new FixtureLiveIncidentCollector(TimeProvider.System);
        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        var sentinelCase = Assert.Single(snapshot.Requests, r => r.RequestId == "req:sentinel");
        Assert.Equal(-5, sentinelCase.Blocking.BlockingSessionId);
        Assert.Equal(BlockingSentinelKind.UntrackedLatchOwner, sentinelCase.Blocking.Sentinel);

        var sentinelNode = Assert.Single(snapshot.BlockingGraph.Nodes, n => n.Kind == BlockingNodeKind.Sentinel);
        Assert.Equal(BlockingSentinelKind.UntrackedLatchOwner, sentinelNode.Sentinel);
    }

    [Fact]
    public async Task BlockingChainFromTheFixtureResolvesToTheTrueRootSession()
    {
        var collector = new FixtureLiveIncidentCollector(TimeProvider.System);
        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        // req:81 (session 81) blocks on session 80; session 82 blocks on session 81. Root is 80.
        Assert.Contains("session:80", snapshot.BlockingGraph.RootNodeIds);
        var node80 = Assert.Single(snapshot.BlockingGraph.Nodes, n => n.SessionId == 80);
        Assert.True(node80.IsRoot);
    }

    [Fact]
    public async Task AllThreeParallelWaitingTasksForOneSessionAreExposedIndividually()
    {
        var collector = new FixtureLiveIncidentCollector(TimeProvider.System);
        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        var session81Waits = snapshot.WaitingTasks.Where(t => t.SessionId == 81).ToList();
        Assert.Equal(3, session81Waits.Count);
        Assert.Single(session81Waits, t => t.ExecutionContext == ExecutionContextKind.Coordinator);
        Assert.Equal(2, session81Waits.Count(t => t.ExecutionContext == ExecutionContextKind.Worker));
    }

    [Fact]
    public async Task MemoryGrantWithNullFixtureGrantTimeMapsToWaitingForGrant()
    {
        var collector = new FixtureLiveIncidentCollector(TimeProvider.System);
        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        var waiting = Assert.Single(snapshot.MemoryGrants, g => g.SessionId == 85);
        Assert.True(waiting.IsWaitingForGrant);
        Assert.Null(waiting.GrantTime);

        var granted = Assert.Single(snapshot.MemoryGrants, g => g.SessionId == 82);
        Assert.False(granted.IsWaitingForGrant);
    }

    [Fact]
    public async Task TempdbFileIoSchedulerAndLogSpaceSectionsAreAllPopulatedFromTheFixture()
    {
        var collector = new FixtureLiveIncidentCollector(TimeProvider.System);
        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        Assert.Equal(DataStatus.Available, snapshot.Tempdb.Status);
        Assert.NotEmpty(snapshot.Tempdb.Files);
        Assert.Equal(DataStatus.Available, snapshot.FileIo.Status);
        Assert.Equal(2, snapshot.FileIo.Files.Count);
        Assert.Equal(DataStatus.Available, snapshot.Scheduler.Status);
        Assert.Equal(2, snapshot.Scheduler.Schedulers.Count);
        Assert.Equal(DataStatus.Available, snapshot.LogSpace.Status);
        Assert.NotNull(snapshot.LogSpace.UsedLogSpacePercent);
    }

    [Fact]
    public async Task FirstCollectionCycleForFileIoAndSchedulerCountersReportsFirstSampleNotAFabricatedRate()
    {
        var collector = new FixtureLiveIncidentCollector(TimeProvider.System);
        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        Assert.All(snapshot.FileIo.Files, f => Assert.Equal(CounterEpochState.FirstSample, f.ReadsDelta.State));
        Assert.All(snapshot.Scheduler.Schedulers, s => Assert.Equal(CounterEpochState.FirstSample, s.CpuUsageMsDelta.State));
    }

    [Fact]
    public async Task SecondCollectionCycleWithTheSameFixtureCountersProducesAZeroDeltaNotAnEpochReset()
    {
        // The static fixture returns identical cumulative counters every cycle; a second cycle
        // against the *same* collector instance (same epoch marker, no regression) must therefore
        // report an exact zero delta rather than treating "no change" as a reset.
        var collector = new FixtureLiveIncidentCollector(TimeProvider.System);
        await collector.CollectAsync(1, CancellationToken.None);
        var second = await collector.CollectAsync(2, CancellationToken.None);

        Assert.All(second.FileIo.Files, f => Assert.Equal(CounterEpochState.Delta, f.ReadsDelta.State));
        Assert.All(second.FileIo.Files, f => Assert.Equal("0", f.ReadsDelta.DeltaValue));
    }

    [Fact]
    public async Task ExactBigintStringsAreLosslessNotNarrowedNumbers()
    {
        var collector = new FixtureLiveIncidentCollector(TimeProvider.System);
        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        var withReads = Assert.Single(snapshot.Requests, r => r.RequestId == "req:81");
        Assert.NotNull(withReads.Reads);
        Assert.True(long.TryParse(withReads.Reads, out _), "Reads must be a parseable decimal string, not a JSON number.");
    }

    [Fact]
    public async Task ResolvesAKeyLockToItsObjectUsingTheFixtureResolutionTable()
    {
        var collector = new FixtureLiveIncidentCollector(TimeProvider.System);
        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        var blocked = Assert.Single(snapshot.Requests, r => r.SessionId == 82);
        var resource = blocked.LockResource;

        Assert.NotNull(resource);
        Assert.Equal(LockResourceKind.Key, resource!.Kind);
        Assert.Equal(LockResolutionStatus.Resolved, resource.Status);
        Assert.Equal(110, resource.ObjectId);
        Assert.Equal("dbo", resource.SchemaName);
        Assert.Equal("OrderHeader", resource.ObjectName);
        Assert.Contains("fixture", resource.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ReportsAnUnprefixedWaitResourceAsUnrecognizedRatherThanGuessingAnObject()
    {
        var collector = new FixtureLiveIncidentCollector(TimeProvider.System);
        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        var latch = Assert.Single(snapshot.Requests, r => r.SessionId == 83);

        Assert.NotNull(latch.LockResource);
        Assert.Equal(LockResolutionStatus.Unrecognized, latch.LockResource!.Status);
        Assert.Null(latch.LockResource.ObjectId);
    }

    [Fact]
    public async Task LeavesLockResourceNullWhenTheEngineReportedNoWaitResource()
    {
        var collector = new FixtureLiveIncidentCollector(TimeProvider.System);
        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        var noWait = Assert.Single(snapshot.Requests, r => r.SessionId == 85);

        Assert.Null(noWait.LockResource);
    }
}