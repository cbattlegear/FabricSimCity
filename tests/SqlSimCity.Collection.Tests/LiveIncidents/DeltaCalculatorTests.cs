using SqlSimCity.Collection.Deltas;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.LiveIncidents;

/// <summary>Requirement 5 coverage: first sample, valid delta, engine-restart epoch reset, and counter-regression epoch reset.</summary>
public class DeltaCalculatorTests
{
    [Fact]
    public void FirstObservationYieldsFirstSampleStateWithNoRate()
    {
        var (delta, nextEpoch) = DeltaCalculator.Compute(null, new CounterObservation(100m, DateTimeOffset.UnixEpoch, 1), currentEpochId: 0);

        Assert.Equal(CounterEpochState.FirstSample, delta.State);
        Assert.Null(delta.DeltaValue);
        Assert.Null(delta.RatePerSecond);
        Assert.Equal(0, nextEpoch);
    }

    [Fact]
    public void TwoSamplesOfTheSameEpochYieldAnExactDeltaAndRate()
    {
        var t0 = DateTimeOffset.UnixEpoch;
        var previous = new CounterObservation(1_000m, t0, EpochMarkerTicks: 1);
        var current = new CounterObservation(3_000m, t0 + TimeSpan.FromSeconds(2), EpochMarkerTicks: 1);

        var (delta, nextEpoch) = DeltaCalculator.Compute(previous, current, currentEpochId: 0);

        Assert.Equal(CounterEpochState.Delta, delta.State);
        Assert.Equal("2000", delta.DeltaValue);
        Assert.Equal(1_000m, delta.RatePerSecond);
        Assert.Equal(0, nextEpoch);
    }

    [Fact]
    public void EpochMarkerChangeStartsANewEpochWithNoFabricatedRate()
    {
        var t0 = DateTimeOffset.UnixEpoch;
        var previous = new CounterObservation(5_000m, t0, EpochMarkerTicks: 1);
        var current = new CounterObservation(10m, t0 + TimeSpan.FromSeconds(1), EpochMarkerTicks: 2); // engine restarted

        var (delta, nextEpoch) = DeltaCalculator.Compute(previous, current, currentEpochId: 4);

        Assert.Equal(CounterEpochState.EpochReset, delta.State);
        Assert.Null(delta.DeltaValue);
        Assert.Null(delta.RatePerSecond);
        Assert.Equal(5, nextEpoch); // epoch id increments exactly once on a detected reset
        Assert.Contains("start time changed", delta.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void CounterRegressionWithoutAnEpochMarkerChangeStillResetsNeverYieldsNegativeRate()
    {
        var t0 = DateTimeOffset.UnixEpoch;
        var previous = new CounterObservation(9_000m, t0, EpochMarkerTicks: 1);
        var current = new CounterObservation(200m, t0 + TimeSpan.FromSeconds(1), EpochMarkerTicks: 1); // same epoch marker, lower value

        var (delta, nextEpoch) = DeltaCalculator.Compute(previous, current, currentEpochId: 0);

        Assert.Equal(CounterEpochState.EpochReset, delta.State);
        Assert.Null(delta.DeltaValue);
        Assert.Null(delta.RatePerSecond);
        Assert.Equal(1, nextEpoch);
    }

    [Fact]
    public void ZeroElapsedTimeYieldsAnExactDeltaButNoRate()
    {
        var t0 = DateTimeOffset.UnixEpoch;
        var previous = new CounterObservation(100m, t0, EpochMarkerTicks: 1);
        var current = new CounterObservation(150m, t0, EpochMarkerTicks: 1); // same instant

        var (delta, _) = DeltaCalculator.Compute(previous, current, currentEpochId: 0);

        Assert.Equal(CounterEpochState.Delta, delta.State);
        Assert.Equal("50", delta.DeltaValue);
        Assert.Null(delta.RatePerSecond);
    }

    [Fact]
    public void ParseCounterRoundTripsALosslessBigintBeyondDoublePrecision()
    {
        const string hugeBigint = "9223372036854775807"; // long.MaxValue
        var parsed = DeltaCalculator.ParseCounter(hugeBigint);
        Assert.Equal(9223372036854775807m, parsed);
    }
}

/// <summary>Verifies <see cref="CounterEpochTracker{TKey}"/> correctly remembers per-key state across calls and prunes stale keys.</summary>
public class CounterEpochTrackerTests
{
    [Fact]
    public void TracksIndependentEpochsPerKey()
    {
        var tracker = new CounterEpochTracker<int>();
        var t0 = DateTimeOffset.UnixEpoch;

        var first = tracker.Compute(1, new CounterObservation(10m, t0, 1));
        Assert.Equal(CounterEpochState.FirstSample, first.State);

        var second = tracker.Compute(1, new CounterObservation(30m, t0 + TimeSpan.FromSeconds(1), 1));
        Assert.Equal(CounterEpochState.Delta, second.State);
        Assert.Equal("20", second.DeltaValue);

        // A different key has never been observed and must start at FirstSample independently.
        var otherKeyFirst = tracker.Compute(2, new CounterObservation(999m, t0, 1));
        Assert.Equal(CounterEpochState.FirstSample, otherKeyFirst.State);
    }

    [Fact]
    public void PruneForgetsKeysNoLongerPresentSoADisappearedFileDoesNotLeakState()
    {
        var tracker = new CounterEpochTracker<int>();
        var t0 = DateTimeOffset.UnixEpoch;
        tracker.Compute(7, new CounterObservation(10m, t0, 1));

        tracker.Prune([]); // file/scheduler 7 no longer present this cycle

        var afterPrune = tracker.Compute(7, new CounterObservation(999m, t0 + TimeSpan.FromSeconds(1), 1));
        Assert.Equal(CounterEpochState.FirstSample, afterPrune.State); // forgotten, not a fabricated huge delta
    }
}
