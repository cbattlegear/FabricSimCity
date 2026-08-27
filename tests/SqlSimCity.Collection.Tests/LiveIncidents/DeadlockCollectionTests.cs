using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.LiveIncidents;

/// <summary>
/// Exercises the recorded-deadlock path through <see cref="LiveIncidentCollector"/>.
/// <para>
/// Deadlocks are unlike every other subsystem here: they are historical rather than live, they cost
/// roughly a second to read against a 2-5 second sampling cycle, and they come from a server-scoped
/// Extended Events session that does not exist everywhere. That combination produces the three
/// failure modes these tests exist to prevent -- reading the probe on every cycle, letting a cached
/// sample vouch for a snapshot that collected nothing, and reporting "not observed here" as "no
/// deadlocks occurred".
/// </para>
/// </summary>
public class DeadlockCollectionTests
{
    private static readonly DateTimeOffset EngineStart = new(2024, 1, 1, 0, 0, 0, TimeSpan.Zero);
    private const int AzureSqlDatabaseEngineEdition = 5;

    private const string Graph = """
        <deadlock>
          <victim-list><victimProcess id="p1" /></victim-list>
          <process-list>
            <process id="p1" spid="70" currentdb="6" currentdbname="AppDb" lockMode="X" />
            <process id="p2" spid="71" currentdb="6" currentdbname="AppDb" lockMode="X" />
          </process-list>
          <resource-list>
            <keylock hobtid="72057594045792256" dbid="6" objectname="AppDb.dbo.B" indexname="PK_B" mode="X" associatedObjectId="72057594045792256">
              <owner-list><owner id="p2" mode="X" /></owner-list>
              <waiter-list><waiter id="p1" mode="X" requestType="wait" /></waiter-list>
            </keylock>
          </resource-list>
        </deadlock>
        """;

    private static DeadlockGraphRow Row(string id, DateTimeOffset occurredAt, int visibleCount = 1, int rank = 1) =>
        new(id, occurredAt, ProcessCount: 2, ResourceCount: 1, VictimCount: 1, IncludesSqlText: false,
            DeadlockXml: Graph, DeadlockXmlLength: Graph.Length, VisibleDeadlockCount: visibleCount, SelectionRank: rank);

    private static FakeLiveIncidentProbeExecutor Probes(int engineEdition = 2) => new()
    {
        ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart, engineEdition)),
    };

    private static LiveIncidentCollector Collector(
        FakeLiveIncidentProbeExecutor probes,
        TimeProvider time,
        TimeSpan? refreshInterval = null,
        int? maxGraphs = 25,
        bool includeSqlText = false) =>
        new(probes, "target-1", "Test Server", time,
            deadlockRefreshInterval: refreshInterval ?? TimeSpan.FromSeconds(60),
            maxDeadlockGraphs: maxGraphs,
            includeDeadlockSqlText: includeSqlText);

    [Fact]
    public async Task ReadsARecordedDeadlockAndKeepsTheTimeItHappenedNotTheTimeItWasRead()
    {
        // A deadlock is always historical. Dating it to when the snapshot was assembled would put a
        // crash pin on the map claiming something just happened when it may be hours old.
        var occurredAt = new DateTimeOffset(2026, 3, 1, 9, 15, 0, TimeSpan.Zero);
        var time = new FakeTimeProvider(occurredAt.AddMinutes(40));
        var probes = Probes();
        probes.DeadlockGraphs = (_, _, _, _, _) =>
            Task.FromResult<IReadOnlyList<DeadlockGraphRow>>([Row("d1", occurredAt)]);

        var snapshot = await Collector(probes, time).CollectAsync(1, CancellationToken.None);

        Assert.Equal(DataStatus.Available, snapshot.Deadlocks.Status);
        var graph = Assert.Single(snapshot.Deadlocks.Graphs);
        Assert.Equal("d1", graph.Id);
        Assert.Equal(occurredAt, graph.OccurredAt);
        Assert.Equal(occurredAt.AddMinutes(40), snapshot.Deadlocks.CollectedAt);
        Assert.Equal("AppDb.dbo.B", Assert.Single(graph.Resources).ObjectName);
    }

    [Fact]
    public async Task ReusesOneSampleAcrossCyclesUntilTheRefreshIntervalElapses()
    {
        // The probe scans the system_health event files, measured at ~0.7-1.1s against a 2-5s
        // sampling cycle. Reading it every cycle would spend most of the budget on data that changes
        // only when a deadlock occurs.
        var start = new DateTimeOffset(2026, 3, 1, 9, 0, 0, TimeSpan.Zero);
        var time = new FakeTimeProvider(start);
        var probes = Probes();
        probes.DeadlockGraphs = (_, _, _, _, _) =>
            Task.FromResult<IReadOnlyList<DeadlockGraphRow>>([Row("d1", start.AddMinutes(-5))]);
        var collector = Collector(probes, time, TimeSpan.FromSeconds(60));

        await collector.CollectAsync(1, CancellationToken.None);
        Assert.Equal(1, probes.DeadlockGraphsCallCount);

        time.Advance(TimeSpan.FromSeconds(30));
        var reused = await collector.CollectAsync(2, CancellationToken.None);
        Assert.Equal(1, probes.DeadlockGraphsCallCount);

        // Crucially, the reused sample keeps its own collection time rather than adopting the
        // snapshot's, so a consumer can tell how old the deadlock evidence is.
        Assert.Equal(start, reused.Deadlocks.CollectedAt);
        Assert.NotEqual(reused.CollectedAt, reused.Deadlocks.CollectedAt);

        time.Advance(TimeSpan.FromSeconds(31));
        var refreshed = await collector.CollectAsync(3, CancellationToken.None);
        Assert.Equal(2, probes.DeadlockGraphsCallCount);
        Assert.Equal(start.AddSeconds(61), refreshed.Deadlocks.CollectedAt);
    }

    [Fact]
    public async Task ACachedSampleDoesNotMakeAnOtherwiseDisconnectedSnapshotAvailable()
    {
        // This is the subtle one. Every other subsystem reports what it read this cycle, so an
        // all-failing cycle is Disconnected. A cached deadlock sample is the only thing in the
        // snapshot that can be Available without anything having been read, and letting it vouch for
        // the cycle would report a server that cannot be reached as healthy.
        var start = new DateTimeOffset(2026, 3, 1, 9, 0, 0, TimeSpan.Zero);
        var time = new FakeTimeProvider(start);
        var probes = Probes();
        probes.DeadlockGraphs = (_, _, _, _, _) =>
            Task.FromResult<IReadOnlyList<DeadlockGraphRow>>([Row("d1", start.AddMinutes(-5))]);

        var collector = Collector(probes, time, TimeSpan.FromSeconds(60));
        var healthy = await collector.CollectAsync(1, CancellationToken.None);
        Assert.Equal(DataStatus.Available, healthy.Deadlocks.Status);

        // Everything operational now fails, but the deadlock sample is still inside its interval and
        // is returned from cache without the probe being called at all.
        probes.ServerIdentity = _ => throw new ProbeTimeoutException("The identity probe timed out.", null, null);
        probes.ActiveRequests = _ => throw new ProbeTimeoutException("The requests probe timed out.", null, null);
        probes.WaitingTasks = _ => throw new ProbeTimeoutException("The waits probe timed out.", null, null);
        probes.BlockingInputs = _ => throw new ProbeTimeoutException("The blocking probe timed out.", null, null);
        probes.MemoryGrants = _ => throw new ProbeTimeoutException("The grants probe timed out.", null, null);
        probes.TempdbUsage = (_, _) => throw new ProbeTimeoutException("The tempdb probe timed out.", null, null);
        probes.FileIoStats = (_, _) => throw new ProbeTimeoutException("The file I/O probe timed out.", null, null);
        probes.SchedulerPressure = (_, _) => throw new ProbeTimeoutException("The scheduler probe timed out.", null, null);
        probes.LogSpaceUsage = _ => throw new ProbeTimeoutException("The log-space probe timed out.", null, null);

        time.Advance(TimeSpan.FromSeconds(10));
        var disconnected = await collector.CollectAsync(2, CancellationToken.None);

        Assert.Equal(1, probes.DeadlockGraphsCallCount);
        Assert.Equal(DataStatus.Available, disconnected.Deadlocks.Status);
        Assert.Single(disconnected.Deadlocks.Graphs);
        Assert.Equal(DataStatus.Disconnected, disconnected.Status);
    }

    [Fact]
    public async Task AFailedRefreshKeepsThePreviousDeadlocksWithTheirOriginalTimestampAndSaysWhy()
    {
        // A deadlock that was read half an hour ago still happened. Blanking the list on a transient
        // permission or timeout blip would erase recorded history from the map and read as an
        // instance that had recovered.
        var start = new DateTimeOffset(2026, 3, 1, 9, 0, 0, TimeSpan.Zero);
        var time = new FakeTimeProvider(start);
        var probes = Probes();
        probes.DeadlockGraphs = (_, _, _, _, _) =>
            Task.FromResult<IReadOnlyList<DeadlockGraphRow>>([Row("d1", start.AddMinutes(-5))]);
        var collector = Collector(probes, time, TimeSpan.FromSeconds(60));

        var first = await collector.CollectAsync(1, CancellationToken.None);
        var originalReason = first.Deadlocks.Reason;

        probes.DeadlockGraphs = (_, _, _, _, _) =>
            throw new ProbeTimeoutException("The deadlock probe timed out.", null, null);
        time.Advance(TimeSpan.FromSeconds(61));
        var stale = await collector.CollectAsync(2, CancellationToken.None);

        Assert.Equal(DataStatus.Available, stale.Deadlocks.Status);
        Assert.Equal("d1", Assert.Single(stale.Deadlocks.Graphs).Id);
        Assert.Equal(start, stale.Deadlocks.CollectedAt);
        Assert.StartsWith(originalReason, stale.Deadlocks.Reason, StringComparison.Ordinal);
        Assert.Contains("not refreshed", stale.Deadlocks.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task AFailureWithNothingPreviouslyReadIsReportedAsAFailureNotAsAQuietInstance()
    {
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 3, 1, 9, 0, 0, TimeSpan.Zero));
        var probes = Probes();
        probes.DeadlockGraphs = (_, _, _, _, _) => throw new ProbePermissionDeniedException(
            "The login lacks VIEW SERVER STATE permission required to read the system_health session.", 300, 14);

        var snapshot = await Collector(probes, time).CollectAsync(1, CancellationToken.None);

        Assert.Equal(DataStatus.PermissionDenied, snapshot.Deadlocks.Status);
        Assert.Empty(snapshot.Deadlocks.Graphs);
        Assert.Null(snapshot.Deadlocks.CollectedAt);
        Assert.NotEmpty(snapshot.Deadlocks.Reason);
    }

    [Fact]
    public async Task AzureSqlDatabaseIsUnsupportedRatherThanAnEmptyAvailableList()
    {
        // The single largest correctness risk in this subsystem: Azure SQL Database has no
        // system_health session, so an empty Available list there would assert "no deadlocks have
        // occurred" on an instance where deadlocks are simply never observed.
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 3, 1, 9, 0, 0, TimeSpan.Zero));
        var probes = Probes(AzureSqlDatabaseEngineEdition);

        var snapshot = await Collector(probes, time).CollectAsync(1, CancellationToken.None);

        Assert.Equal(DataStatus.Unsupported, snapshot.Deadlocks.Status);
        Assert.Empty(snapshot.Deadlocks.Graphs);
        Assert.Equal(0, probes.DeadlockGraphsCallCount);
        Assert.Contains("system_health", snapshot.Deadlocks.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnUnknownPlatformIsUnknownRatherThanProbedOnAGuess()
    {
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 3, 1, 9, 0, 0, TimeSpan.Zero));
        var probes = Probes();
        probes.ServerIdentity = _ => throw new ProbeTimeoutException("The identity probe timed out.", null, null);

        var snapshot = await Collector(probes, time).CollectAsync(1, CancellationToken.None);

        Assert.Equal(DataStatus.Unknown, snapshot.Deadlocks.Status);
        Assert.Equal(0, probes.DeadlockGraphsCallCount);
    }

    [Fact]
    public async Task LosingPlatformDetectionAfterTheIntervalElapsesKeepsWhatWasAlreadyRead()
    {
        // Not being able to determine the platform is a reason a refresh did not happen, not a
        // reason the deadlocks already read stopped having happened. Treating it differently from a
        // probe timeout would make recorded history depend on which probe blinked.
        var start = new DateTimeOffset(2026, 3, 1, 9, 0, 0, TimeSpan.Zero);
        var time = new FakeTimeProvider(start);
        var probes = Probes();
        probes.DeadlockGraphs = (_, _, _, _, _) =>
            Task.FromResult<IReadOnlyList<DeadlockGraphRow>>([Row("d1", start.AddMinutes(-5))]);
        var collector = Collector(probes, time, TimeSpan.FromSeconds(60));

        await collector.CollectAsync(1, CancellationToken.None);

        probes.ServerIdentity = _ => throw new ProbeTimeoutException("The identity probe timed out.", null, null);
        time.Advance(TimeSpan.FromSeconds(61));
        var stale = await collector.CollectAsync(2, CancellationToken.None);

        Assert.Equal(DataStatus.Available, stale.Deadlocks.Status);
        Assert.Equal("d1", Assert.Single(stale.Deadlocks.Graphs).Id);
        Assert.Equal(start, stale.Deadlocks.CollectedAt);
        Assert.Contains("not refreshed", stale.Deadlocks.Reason, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(1, probes.DeadlockGraphsCallCount);
    }

    [Fact]
    public async Task ARefreshIntervalOfZeroDisablesTheProbeAndSaysItWasALocalChoice()
    {
        // An operator capping this to nothing must not be mistaken for an instance with no
        // deadlocks, so the reason has to name the setting that produced the silence.
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 3, 1, 9, 0, 0, TimeSpan.Zero));
        var probes = Probes();
        probes.DeadlockGraphs = (_, _, _, _, _) =>
            Task.FromResult<IReadOnlyList<DeadlockGraphRow>>([Row("d1", DateTimeOffset.UnixEpoch)]);

        var snapshot = await Collector(probes, time, TimeSpan.Zero).CollectAsync(1, CancellationToken.None);

        Assert.Equal(DataStatus.Unsupported, snapshot.Deadlocks.Status);
        Assert.Empty(snapshot.Deadlocks.Graphs);
        Assert.Equal(0, probes.DeadlockGraphsCallCount);
        Assert.Contains("DeadlockRefreshSeconds", snapshot.Deadlocks.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DoesNotRequestStatementTextByDefaultAndPassesTheConfiguredCapThrough()
    {
        // A deadlock graph carries a whole submitted batch per participant for an event that already
        // finished, so statement text is opt-in here even though active_requests defaults the other
        // way. If this flips, every deadlock silently starts exporting query text.
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 3, 1, 9, 0, 0, TimeSpan.Zero));
        var probes = Probes();
        bool? sawIncludeSqlText = null;
        int? sawMaxGraphs = null;
        bool? sawAzureScoped = null;
        probes.DeadlockGraphs = (azureScoped, _, maxGraphs, includeSqlText, _) =>
        {
            sawAzureScoped = azureScoped;
            sawMaxGraphs = maxGraphs;
            sawIncludeSqlText = includeSqlText;
            return Task.FromResult<IReadOnlyList<DeadlockGraphRow>>([]);
        };

        await Collector(probes, time, maxGraphs: 7).CollectAsync(1, CancellationToken.None);

        Assert.False(sawIncludeSqlText);
        Assert.Equal(7, sawMaxGraphs);
        Assert.False(sawAzureScoped);
    }

    [Fact]
    public async Task RequestsStatementTextOnlyWhenTheOperatorOptedIn()
    {
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 3, 1, 9, 0, 0, TimeSpan.Zero));
        var probes = Probes();
        bool? sawIncludeSqlText = null;
        probes.DeadlockGraphs = (_, _, _, includeSqlText, _) =>
        {
            sawIncludeSqlText = includeSqlText;
            return Task.FromResult<IReadOnlyList<DeadlockGraphRow>>([]);
        };

        await Collector(probes, time, includeSqlText: true).CollectAsync(1, CancellationToken.None);

        Assert.True(sawIncludeSqlText);
    }

    [Fact]
    public async Task AnEmptyResultIsAvailableAndDescribedAsAnObservationWindow()
    {
        // system_health rolls its event files over, so "nothing retained" is a statement about the
        // window that was read, not about the instance's history.
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 3, 1, 9, 0, 0, TimeSpan.Zero));
        var probes = Probes();

        var snapshot = await Collector(probes, time).CollectAsync(1, CancellationToken.None);

        Assert.Equal(DataStatus.Available, snapshot.Deadlocks.Status);
        Assert.Empty(snapshot.Deadlocks.Graphs);
        Assert.Equal(0, snapshot.Deadlocks.TotalRetainedCount);
        Assert.Contains("rolls", snapshot.Deadlocks.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ACappedResultDisclosesHowManyWereRetainedBeforeTheCap()
    {
        // Two returned out of nine retained must not read as a calmer instance than it is.
        var occurredAt = new DateTimeOffset(2026, 3, 1, 9, 0, 0, TimeSpan.Zero);
        var time = new FakeTimeProvider(occurredAt);
        var probes = Probes();
        probes.DeadlockGraphs = (_, _, _, _, _) => Task.FromResult<IReadOnlyList<DeadlockGraphRow>>(
            [Row("d1", occurredAt, visibleCount: 9, rank: 1), Row("d2", occurredAt.AddMinutes(-1), visibleCount: 9, rank: 2)]);

        var snapshot = await Collector(probes, time, maxGraphs: 2).CollectAsync(1, CancellationToken.None);

        Assert.Equal(2, snapshot.Deadlocks.Graphs.Count);
        Assert.Equal(9, snapshot.Deadlocks.TotalRetainedCount);
        Assert.Contains("2 of 9", snapshot.Deadlocks.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AMalformedGraphIsCountedAndDisclosedRatherThanShorteningTheListSilently()
    {
        var occurredAt = new DateTimeOffset(2026, 3, 1, 9, 0, 0, TimeSpan.Zero);
        var time = new FakeTimeProvider(occurredAt);
        var probes = Probes();
        var broken = Row("d2", occurredAt.AddMinutes(-1), visibleCount: 2, rank: 2) with
        {
            DeadlockXml = "<deadlock><process-list>",
        };
        probes.DeadlockGraphs = (_, _, _, _, _) => Task.FromResult<IReadOnlyList<DeadlockGraphRow>>(
            [Row("d1", occurredAt, visibleCount: 2, rank: 1), broken]);

        var snapshot = await Collector(probes, time).CollectAsync(1, CancellationToken.None);

        // The graph that parsed is still reported; the one that did not is named as omitted.
        Assert.Equal("d1", Assert.Single(snapshot.Deadlocks.Graphs).Id);
        Assert.Equal(2, snapshot.Deadlocks.TotalRetainedCount);
        Assert.Contains("could not be parsed", snapshot.Deadlocks.Reason, StringComparison.Ordinal);
    }

    /// <summary>
    /// A manually advanced clock. The refresh-interval behaviour is defined in terms of elapsed
    /// time, and asserting it against the wall clock would either sleep for a minute or be flaky.
    /// </summary>
    private sealed class FakeTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan by) => _now = _now.Add(by);
    }
}
