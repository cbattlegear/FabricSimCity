using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Deltas;

/// <summary>
/// One prior cumulative-counter observation the delta calculator needs to keep across sampling
/// cycles: the counter's raw value (as a lossless decimal string, since these are SQL Server
/// <c>bigint</c> columns), the wall-clock time it was observed, and an opaque per-target epoch
/// marker (typically <c>sys.dm_os_sys_info.sqlserver_start_time</c>) used to detect an engine
/// restart independently of the counter value itself.
/// </summary>
public readonly record struct CounterObservation(decimal Value, DateTimeOffset ObservedAt, long EpochMarkerTicks);

/// <summary>
/// Computes a rate-of-change delta between two cumulative, monotonically-nondecreasing counter
/// samples (file I/O bytes/reads/writes, scheduler CPU/delay ms, and similar "since engine start"
/// DMV counters), per requirement 5:
///
/// - The very first observation for a target has nothing to compare against:
///   <see cref="CounterEpochState.FirstSample"/>, no delta, no rate.
/// - An engine restart or failover resets every such counter to zero. This is detected either by
///   the epoch marker changing (the reliable signal -- see
///   <c>sys.dm_os_sys_info.sqlserver_start_time</c>, or io/file_io_stats.sql's own discussion of why
///   <c>sample_ms</c> alone cannot be trusted) or, when no epoch marker is available, by the counter
///   itself reading lower than the previous sample (a nondecreasing counter cannot naturally
///   regress). Either signal starts a new epoch with
///   <see cref="CounterEpochState.EpochReset"/> and yields no fabricated negative or zero rate.
/// - Otherwise: <see cref="CounterEpochState.Delta"/>, with an exact decimal delta and a rate
///   computed over the wall-clock time between the two observations.
/// </summary>
public static class DeltaCalculator
{
    /// <summary>
    /// Computes one counter's delta. <paramref name="epochId"/> is the caller's current epoch
    /// counter for this target/counter pair (starts at 0/1 depending on caller convention); this
    /// method returns the epoch id that should be stored going forward -- incremented exactly when
    /// it detects a reset.
    /// </summary>
    public static (CounterDeltaV1 Delta, long NextEpochId) Compute(
        CounterObservation? previous,
        CounterObservation current,
        long currentEpochId)
    {
        if (previous is null)
        {
            return (new CounterDeltaV1(CounterEpochState.FirstSample, null, null,
                "No prior sample exists yet for this counter; a rate requires two samples."), currentEpochId);
        }

        var prior = previous.Value;
        var restarted = current.EpochMarkerTicks != prior.EpochMarkerTicks || current.Value < prior.Value;
        if (restarted)
        {
            var reason = current.EpochMarkerTicks != prior.EpochMarkerTicks
                ? "The engine's start time changed since the previous sample; this counter reset with the restart."
                : "This counter read lower than the previous sample despite no observed engine restart; " +
                  "treating it as a reset rather than reporting a fabricated negative rate.";
            return (new CounterDeltaV1(CounterEpochState.EpochReset, null, null, reason), currentEpochId + 1);
        }

        var elapsed = current.ObservedAt - prior.ObservedAt;
        var deltaValue = current.Value - prior.Value;
        decimal? rate = elapsed > TimeSpan.Zero
            ? deltaValue / (decimal)elapsed.TotalSeconds
            : null;
        var rateReason = rate is null
            ? "Elapsed wall-clock time between samples was zero or negative; a rate could not be computed."
            : "Computed across two consecutive samples of the same, still-running engine instance.";

        return (new CounterDeltaV1(
            CounterEpochState.Delta,
            deltaValue.ToString("F0", System.Globalization.CultureInfo.InvariantCulture),
            rate,
            rateReason), currentEpochId);
    }

    /// <summary>Parses a lossless bigint decimal string (as produced by the SQL client) into a <see cref="decimal"/> for delta arithmetic.</summary>
    public static decimal ParseCounter(string value) =>
        decimal.Parse(value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture);
}
