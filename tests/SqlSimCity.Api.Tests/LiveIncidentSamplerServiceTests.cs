using Microsoft.Extensions.Time.Testing;
using SqlSimCity.Collection.Sampling;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Api.Tests;

/// <summary>
/// Requirement 13/17 lifecycle coverage for <see cref="LiveIncidentSamplerService"/>: broadcasts
/// go through the bounded <see cref="LatestValuePublisher{T}"/> for both successful snapshots and
/// sampler run-state transitions, <c>StopAsync</c> honors a caller-supplied cancellation token
/// rather than blocking on the sampler indefinitely, and <c>DisposeAsync</c> is safe to call more
/// than once (as ASP.NET Core's DI container can do for a type registered as both a concrete
/// singleton and an <see cref="IHostedService"/>).
/// </summary>
public sealed class LiveIncidentSamplerServiceTests
{
    [Fact]
    public async Task SuccessfulCycleBroadcastsExactlyOneLatestResponseToAllClients()
    {
        var time = new FakeTimeProvider();
        var hub = new RecordingHubContext();
        await using var service = new LiveIncidentSamplerService(
            new StubLiveIncidentCollector(), hub, new LiveIncidentSamplerOptions { Cadence = TimeSpan.FromSeconds(2) }, time);

        await service.StartAsync(CancellationToken.None);
        await WaitForAsync(() => hub.Sent.Any(s => ((LiveIncidentResponseV1)s.Args[0]!).Snapshot is not null));

        var (method, args) = hub.Sent.First(s => ((LiveIncidentResponseV1)s.Args[0]!).Snapshot is not null);
        Assert.Equal("liveIncidentUpdated", method);
        var payload = Assert.IsType<LiveIncidentResponseV1>(Assert.Single(args));
        Assert.NotNull(payload.Snapshot);

        await service.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task ARunStateTransitionBroadcastsEvenWithoutAFreshSuccessfulSnapshot()
    {
        var time = new FakeTimeProvider();
        var hub = new RecordingHubContext();
        var collector = new StubLiveIncidentCollector { OnCollect = (_, _) => throw new InvalidOperationException("boom") };
        await using var service = new LiveIncidentSamplerService(
            collector, hub, new LiveIncidentSamplerOptions { Cadence = TimeSpan.FromSeconds(2) }, time);

        await service.StartAsync(CancellationToken.None);

        // The very first cycle throws, transitioning the sampler into Reconnecting; requirement 13
        // says that transition itself must broadcast, not only a hypothetical later success.
        // The sampler also broadcasts its initial Running state, so waiting for "any broadcast"
        // raced that first payload and read Running on a slow machine; wait for the specific
        // transition under test instead.
        await WaitForAsync(() => hub.Sent.Any(IsReconnectingBroadcast));

        var (_, args) = hub.Sent.First(IsReconnectingBroadcast);
        var payload = Assert.IsType<LiveIncidentResponseV1>(Assert.Single(args));
        Assert.Equal(SamplerRunState.Reconnecting, payload.Collector.State);

        await service.StopAsync(CancellationToken.None);
    }

    private static bool IsReconnectingBroadcast((string Method, object?[] Args) sent) =>
        sent.Args is [LiveIncidentResponseV1 { Collector.State: SamplerRunState.Reconnecting }];

    [Fact]
    public async Task CurrentSnapshotDiagnosticsIncludeSamplerSkippedCycles()
    {
        var time = new FakeTimeProvider();
        var collector = new StubLiveIncidentCollector
        {
            OnCollect = (sequence, _) => sequence == 1
                ? Task.FromResult(StubLiveIncidentCollector.MinimalSnapshot(sequence))
                : throw new InvalidOperationException("boom"),
        };
        await using var service = new LiveIncidentSamplerService(
            collector, new RecordingHubContext(),
            new LiveIncidentSamplerOptions
            {
                Cadence = TimeSpan.FromSeconds(2),
                InitialBackoff = TimeSpan.FromSeconds(2),
                JitterFraction = 0,
            },
            time);

        await service.StartAsync(CancellationToken.None);
        await WaitForAsync(() => service.GetCurrentResponse().Snapshot is not null);
        time.Advance(TimeSpan.FromSeconds(2));
        await WaitForAsync(() => service.GetCurrentResponse().Collector.State == SamplerRunState.Reconnecting);

        var response = service.GetCurrentResponse();
        Assert.Equal(response.Collector.SkippedCycles, response.Snapshot!.Diagnostics.SkippedCycles);
        Assert.True(response.Snapshot.Diagnostics.SkippedCycles > 0);

        await service.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task StopAsyncHonorsAnAlreadyCancelledTokenInsteadOfBlockingOnAStuckCycle()
    {
        var time = new FakeTimeProvider();
        var hub = new RecordingHubContext();
        var stuck = new TaskCompletionSource<LiveIncidentSnapshotV1>();
        var collector = new StubLiveIncidentCollector { OnCollect = (_, _) => stuck.Task };
        var service = new LiveIncidentSamplerService(
            collector, hub, new LiveIncidentSamplerOptions { Cadence = TimeSpan.FromSeconds(2) }, time);

        await service.StartAsync(CancellationToken.None);
        await WaitForAsync(() => collector.CallCount > 0);

        using var alreadyCancelled = new CancellationTokenSource();
        await alreadyCancelled.CancelAsync();

        // A pre-cancelled token must make StopAsync return/throw promptly, never hang on the
        // in-flight, never-completing collection cycle (requirement 17).
        var stopTask = service.StopAsync(alreadyCancelled.Token);
        var completed = await Task.WhenAny(stopTask, Task.Delay(TimeSpan.FromSeconds(5)));
        Assert.Same(stopTask, completed);

        stuck.SetResult(StubLiveIncidentCollector.MinimalSnapshot(1)); // let the background loop finish so it doesn't leak
        await service.DisposeAsync();
    }

    [Fact]
    public async Task DisposeAsyncIsIdempotentWhenCalledConcurrentlyOrRepeatedly()
    {
        var time = new FakeTimeProvider();
        var hub = new RecordingHubContext();
        var service = new LiveIncidentSamplerService(
            new StubLiveIncidentCollector(), hub, new LiveIncidentSamplerOptions { Cadence = TimeSpan.FromSeconds(2) }, time);

        await service.StartAsync(CancellationToken.None);
        await WaitForAsync(() => hub.Sent.Count > 0);

        var first = service.DisposeAsync();
        var second = service.DisposeAsync();
        await first;
        await second; // must not throw, double-dispose the sampler, or double-complete the publisher channel

        await service.DisposeAsync(); // a third, later call must also be a safe no-op
    }

    [Fact]
    public async Task DisposeCancelsAStuckSignalRSend()
    {
        var sendStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var hub = new RecordingHubContext(async cancellationToken =>
        {
            sendStarted.SetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        });
        var service = new LiveIncidentSamplerService(
            new StubLiveIncidentCollector(), hub,
            new LiveIncidentSamplerOptions { Cadence = TimeSpan.FromSeconds(2) },
            new FakeTimeProvider());

        await service.StartAsync(CancellationToken.None);
        await sendStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

        var dispose = service.DisposeAsync().AsTask();
        await dispose.WaitAsync(TimeSpan.FromSeconds(5));
    }

    private static async Task WaitForAsync(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!condition())
        {
            timeout.Token.ThrowIfCancellationRequested();
            await Task.Delay(10, CancellationToken.None);
        }
    }
}

/// <summary>A stub <see cref="ILiveIncidentCollector"/> whose behavior a test fully controls.</summary>
internal sealed class StubLiveIncidentCollector : ILiveIncidentCollector
{
    public Func<long, CancellationToken, Task<LiveIncidentSnapshotV1>>? OnCollect { get; set; }
    public int CallCount { get; private set; }

    public static LiveIncidentSnapshotV1 MinimalSnapshot(long sequence) => new(
        "1.0",
        new LiveIncidentTargetV1("t", "Test", "SqlServerOnPremises", "Server", null),
        DateTimeOffset.UnixEpoch,
        DateTimeOffset.UnixEpoch,
        DateTimeOffset.UnixEpoch,
        DataStatus.Available,
        "ok",
        [],
        [],
        new BlockingGraphV1([], [], [], [], new BlockingGraphSummaryV1(0, 0, 0, 0, 0, "note")),
        [],
        new TempdbUsageV1([], [], [], DataStatus.Available, "ok"),
        new FileIoSampleV1([], DataStatus.Available, "ok"),
        new SchedulerPressureV1([], DataStatus.Available, "ok"),
        new LogSpaceUsageV1(1, 1, 1, DataStatus.Available, "ok"),
        new DeadlockSampleV1([], 0, DateTimeOffset.UnixEpoch, DataStatus.Available, "ok"),
        new CollectionDiagnosticsV1(sequence, DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, 1, 0, 0, []));

    public Task<LiveIncidentSnapshotV1> CollectAsync(long sequence, CancellationToken cancellationToken)
    {
        CallCount++;
        return (OnCollect ?? ((s, _) => Task.FromResult(MinimalSnapshot(s))))(sequence, cancellationToken);
    }
}
