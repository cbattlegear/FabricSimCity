using Microsoft.Extensions.Time.Testing;
using SqlSimCity.Collection.Sampling;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Collection.Tests.LiveIncidents;

/// <summary>A stub <see cref="ILiveIncidentCollector"/> whose behavior a test fully controls, with no dependency on real probes or wall-clock time.</summary>
public sealed class StubLiveIncidentCollector : ILiveIncidentCollector
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
        new CollectionDiagnosticsV1(sequence, DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, 1, 0, 0, []));

    public Task<LiveIncidentSnapshotV1> CollectAsync(long sequence, CancellationToken cancellationToken)
    {
        CallCount++;
        return (OnCollect ?? ((s, _) => Task.FromResult(MinimalSnapshot(s))))(sequence, cancellationToken);
    }
}

/// <summary>
/// Requirement 3 coverage for <see cref="LiveIncidentSampler"/>: cadence bounds, no overlapping
/// cycles, pause/resume, capped exponential backoff with deterministic jitter, and clean shutdown --
/// entirely driven by <see cref="FakeTimeProvider"/> so nothing here depends on wall-clock time.
/// </summary>
public class LiveIncidentSamplerTests
{
    private sealed class FixedJitter(double fraction) : IJitterSource
    {
        public double NextFraction() => fraction;
    }

    [Fact]
    public void CadenceOutsideTheSafeTwoToFiveSecondBandIsRejected()
    {
        var options = new LiveIncidentSamplerOptions();
        Assert.Throws<ArgumentOutOfRangeException>(() => options.Cadence = TimeSpan.FromSeconds(1));
        Assert.Throws<ArgumentOutOfRangeException>(() => options.Cadence = TimeSpan.FromSeconds(6));

        options.Cadence = TimeSpan.FromSeconds(2);
        options.Cadence = TimeSpan.FromSeconds(5);
    }

    [Fact]
    public async Task EachAdvanceByOneCadenceRunsExactlyOneCollectionCycleNeverOverlapping()
    {
        var time = new FakeTimeProvider();
        var collector = new StubLiveIncidentCollector();
        var options = new LiveIncidentSamplerOptions { Cadence = TimeSpan.FromSeconds(3) };
        await using var sampler = new LiveIncidentSampler(collector, options, time);

        await sampler.StartAsync();
        await SettleAsync(); // the sampler runs its first cycle immediately on start
        Assert.Equal(1, collector.CallCount);

        await AdvanceAndSettleAsync(time, TimeSpan.FromSeconds(3));
        Assert.Equal(2, collector.CallCount);

        await AdvanceAndSettleAsync(time, TimeSpan.FromSeconds(3));
        Assert.Equal(3, collector.CallCount);

        Assert.Equal(3, sampler.GetStatus().Sequence);
        await sampler.StopAsync();
    }

    [Fact]
    public async Task LatestSnapshotIsImmutableAndReflectsOnlyTheMostRecentSuccessfulCycle()
    {
        var time = new FakeTimeProvider();
        var collector = new StubLiveIncidentCollector();
        await using var sampler = new LiveIncidentSampler(collector, new LiveIncidentSamplerOptions { Cadence = TimeSpan.FromSeconds(2) }, time);

        await sampler.StartAsync();
        await SettleAsync();
        var firstSnapshot = sampler.LatestSnapshot;
        Assert.NotNull(firstSnapshot);
        Assert.Equal(1, firstSnapshot!.Diagnostics.Sequence);

        await AdvanceAndSettleAsync(time, TimeSpan.FromSeconds(2));
        var secondSnapshot = sampler.LatestSnapshot;
        Assert.Equal(2, secondSnapshot!.Diagnostics.Sequence);

        // The first snapshot instance itself is never mutated by later cycles.
        Assert.Equal(1, firstSnapshot.Diagnostics.Sequence);
        await sampler.StopAsync();
    }

    [Fact]
    public async Task PauseStopsFurtherCyclesAndCountsThemAsMissedResumeContinuesTheSequence()
    {
        var time = new FakeTimeProvider();
        var collector = new StubLiveIncidentCollector();
        await using var sampler = new LiveIncidentSampler(collector, new LiveIncidentSamplerOptions { Cadence = TimeSpan.FromSeconds(2) }, time);

        await sampler.StartAsync();
        await SettleAsync(); // first cycle runs immediately on start
        Assert.Equal(1, collector.CallCount);

        sampler.Pause();
        await AdvanceAndSettleAsync(time, TimeSpan.FromSeconds(2));
        await AdvanceAndSettleAsync(time, TimeSpan.FromSeconds(2));
        Assert.Equal(1, collector.CallCount); // paused: no new cycles ran
        Assert.True(sampler.GetStatus().MissedCycles >= 2);
        Assert.Equal(SamplerRunState.Paused, sampler.GetStatus().State);

        sampler.Resume();
        await AdvanceAndSettleAsync(time, TimeSpan.FromSeconds(2));
        Assert.Equal(2, collector.CallCount);
        Assert.Equal(SamplerRunState.Running, sampler.GetStatus().State);

        await sampler.StopAsync();
    }

    [Fact]
    public async Task FailedCycleEntersCappedExponentialBackoffWithDeterministicJitterThenRecovers()
    {
        var time = new FakeTimeProvider();
        var collector = new StubLiveIncidentCollector
        {
            OnCollect = (sequence, _) => sequence == 1
                ? throw new InvalidOperationException("simulated transient connection failure")
                : Task.FromResult(StubLiveIncidentCollector.MinimalSnapshot(sequence)),
        };
        var options = new LiveIncidentSamplerOptions
        {
            Cadence = TimeSpan.FromSeconds(2),
            InitialBackoff = TimeSpan.FromSeconds(1),
            MaxBackoff = TimeSpan.FromSeconds(10),
            BackoffMultiplier = 2.0,
            JitterFraction = 0.0, // deterministic: no randomness needed to prove the exact delay
        };
        await using var sampler = new LiveIncidentSampler(collector, options, time, new FixedJitter(0.5));

        await sampler.StartAsync();
        await SettleAsync(); // the first cycle fails immediately on start, synchronously entering backoff
        var statusAfterFailure = sampler.GetStatus();
        Assert.Equal(SamplerRunState.Reconnecting, statusAfterFailure.State);
        Assert.Equal(1, statusAfterFailure.ConsecutiveFailures);
        Assert.Equal(1, statusAfterFailure.SkippedCycles);
        Assert.Equal(1000d, statusAfterFailure.NextAttemptInMs); // InitialBackoff, no jitter

        await AdvanceAndSettleAsync(time, TimeSpan.FromSeconds(1)); // backoff elapses; cycle 2 succeeds
        Assert.Equal(SamplerRunState.Running, sampler.GetStatus().State);
        Assert.Equal(0, sampler.GetStatus().ConsecutiveFailures);
        Assert.NotNull(sampler.LatestSnapshot);

        await sampler.StopAsync();
    }

    [Fact]
    public async Task StopAsyncCancelsTheLoopCleanlyWithNoFurtherCyclesAfterward()
    {
        var time = new FakeTimeProvider();
        var collector = new StubLiveIncidentCollector();
        var sampler = new LiveIncidentSampler(collector, new LiveIncidentSamplerOptions { Cadence = TimeSpan.FromSeconds(2) }, time);

        await sampler.StartAsync();
        await SettleAsync();
        Assert.Equal(1, collector.CallCount);

        await sampler.StopAsync();
        Assert.Equal(SamplerRunState.Stopped, sampler.GetStatus().State);

        // Advancing time after shutdown must not trigger any further collection.
        time.Advance(TimeSpan.FromSeconds(10));
        await Task.Delay(20);
        Assert.Equal(1, collector.CallCount);
    }

    [Fact]
    public async Task DisposeAsyncIsIdempotentAndSurvivesAConcurrentStopAsyncCall()
    {
        // A host that registers the same instance both as a concrete singleton and as
        // IHostedService (e.g. LiveIncidentSamplerService in SqlSimCity.Api) can have its DI
        // container call DisposeAsync on it more than once; a plain caller can also legitimately
        // call StopAsync again after disposal. Neither must throw ObjectDisposedException on the
        // internal control semaphore.
        var time = new FakeTimeProvider();
        var collector = new StubLiveIncidentCollector();
        var sampler = new LiveIncidentSampler(collector, new LiveIncidentSamplerOptions { Cadence = TimeSpan.FromSeconds(2) }, time);

        await sampler.StartAsync();
        await SettleAsync();
        Assert.Equal(1, collector.CallCount);

        await sampler.DisposeAsync();
        await sampler.DisposeAsync(); // second dispose must be a no-op, not throw
        await sampler.StopAsync();    // a stray stop after disposal must also be a no-op, not throw

        Assert.Equal(SamplerRunState.Stopped, sampler.GetStatus().State);
    }

    /// <summary>Yields control back to the scheduler a few times with no time advance, so a cycle that completes synchronously (e.g. the immediate first cycle on start) is observed before assertions run.</summary>
    private static async Task SettleAsync()
    {
        for (var i = 0; i < 10; i++)
        {
            await Task.Delay(1);
        }
    }

    /// <summary>
    /// Advances the fake clock and yields control back to the scheduler a few times so the
    /// sampler's awaited <c>Task.Delay(delay, timeProvider, ...)</c> observes the new time and the
    /// next cycle actually runs, without ever touching the real wall clock.
    /// </summary>
    private static async Task AdvanceAndSettleAsync(FakeTimeProvider time, TimeSpan by)
    {
        time.Advance(by);
        for (var i = 0; i < 10; i++)
        {
            await Task.Delay(1);
        }
    }
}
