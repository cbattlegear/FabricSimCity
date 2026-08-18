using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Findings.Tests;

/// <summary>Deterministic builders for live-incident snapshots used by the live findings rules.</summary>
internal static class LiveTestData
{
    private static readonly DateTimeOffset Now = FindingsTestData.Now;

    internal static LiveIncidentSnapshotV1 Snapshot(
        BlockingGraphV1? blocking = null,
        IReadOnlyList<MemoryGrantV1>? memoryGrants = null,
        LogSpaceUsageV1? logSpace = null,
        FileIoSampleV1? fileIo = null,
        DataStatus status = DataStatus.Available) =>
        new("1.0",
            new LiveIncidentTargetV1("target-1", "Test target", "SqlServerOnPremises", "Server", null),
            Now.AddSeconds(-2), Now, Now.AddSeconds(30), status, "Test live sample.",
            [], [],
            blocking ?? EmptyGraph(),
            memoryGrants ?? [],
            new TempdbUsageV1([], [], [], DataStatus.Unknown, "Not sampled in test."),
            fileIo ?? new FileIoSampleV1([], DataStatus.Unknown, "Not sampled in test."),
            new SchedulerPressureV1([], DataStatus.Unknown, "Not sampled in test."),
            logSpace ?? new LogSpaceUsageV1(null, null, null, DataStatus.Unknown, "Not sampled in test."),
            new CollectionDiagnosticsV1(1, Now, Now.AddSeconds(-2), 5, 0, 0, []));

    internal static BlockingGraphV1 EmptyGraph() =>
        new([], [], [], [], new BlockingGraphSummaryV1(0, 0, 0, 0, 0, "No blocking."));

    /// <summary>Session 80 blocks 81, 81 blocks 82; separately a -5 untracked-latch sentinel "blocks" 83.</summary>
    internal static BlockingGraphV1 ChainWithSentinelRoot()
    {
        var node80 = new BlockingNodeV1("s80", BlockingNodeKind.Session, 80, BlockingSentinelKind.None, true, false, false, 1);
        var node81 = new BlockingNodeV1("s81", BlockingNodeKind.Session, 81, BlockingSentinelKind.None, false, false, false, 1);
        var node82 = new BlockingNodeV1("s82", BlockingNodeKind.Session, 82, BlockingSentinelKind.None, false, false, false, 0);
        var node83 = new BlockingNodeV1("s83", BlockingNodeKind.Session, 83, BlockingSentinelKind.None, false, false, false, 0);
        var sentinel = new BlockingNodeV1("sentinel-5", BlockingNodeKind.Sentinel, null, BlockingSentinelKind.UntrackedLatchOwner, true, false, false, 1);

        var edges = new[]
        {
            new BlockingEdgeV1("e1", "s81", "s80", "LCK_M_S", "1000", ExecutionContextKind.Coordinator, 0),
            new BlockingEdgeV1("e2", "s82", "s81", "LCK_M_S", "900", ExecutionContextKind.Coordinator, 0),
            new BlockingEdgeV1("e3", "s83", "sentinel-5", "PAGELATCH_SH", "10", ExecutionContextKind.Coordinator, 0),
        };
        return new BlockingGraphV1(
            [node80, node81, node82, node83, sentinel],
            edges,
            ["s80", "sentinel-5"],
            [],
            new BlockingGraphSummaryV1(3, 1, 1, 0, 0, "One real root, one sentinel root."));
    }

    internal static MemoryGrantV1 WaitingGrant(int sessionId, string? requestedKb) =>
        new(sessionId, 1, 2, 4, Now.AddSeconds(-5), null, true, requestedKb, null, requestedKb, null, null, null, 1.0m, 25, "3000", null);

    internal static MemoryGrantV1 GrantedGrant(int sessionId) =>
        new(sessionId, 1, 2, 4, Now.AddSeconds(-5), Now.AddSeconds(-4), false, "1024", "1024", "1024", "512", "800", "900", 1.0m, 25, null, null);

    internal static LogSpaceUsageV1 LogSpace(decimal percent) =>
        new(4096m, 4096m * percent / 100m, percent, DataStatus.Available, "Test log space.");

    internal static FileIoSampleV1 FileIoWithStall(decimal stallRatePerSecond)
    {
        var delta = new CounterDeltaV1(CounterEpochState.Delta, "5000", stallRatePerSecond, "Valid two-sample delta.");
        var zero = new CounterDeltaV1(CounterEpochState.Delta, "0", 0m, "No change.");
        var file = new FileIoDeltaV1(5, "sales", 1, "ROWS", 1, 1000m, zero, zero, delta, zero, zero, zero);
        return new FileIoSampleV1([file], DataStatus.Available, "Test file I/O.");
    }

    internal static FileIoSampleV1 FileIoFirstSample()
    {
        var first = new CounterDeltaV1(CounterEpochState.FirstSample, null, null, "First sample; no rate.");
        var file = new FileIoDeltaV1(5, "sales", 1, "ROWS", 1, null, first, first, first, first, first, first);
        return new FileIoSampleV1([file], DataStatus.Available, "Test file I/O first sample.");
    }
}
