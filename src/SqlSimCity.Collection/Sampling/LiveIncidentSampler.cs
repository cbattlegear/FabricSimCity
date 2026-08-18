using Microsoft.Extensions.Logging;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Collection.Sampling;

/// <summary>A source of jitter fractions in <c>[0, 1)</c> for backoff randomization. Injectable so backoff timing is deterministic in tests (requirement 3).</summary>
public interface IJitterSource
{
    double NextFraction();
}

/// <summary>A <see cref="Random"/>-backed <see cref="IJitterSource"/>. Seeded explicitly so its sequence is reproducible -- for deterministic test injection only, never used as the production default.</summary>
public sealed class SeededJitterSource(int seed) : IJitterSource
{
    private readonly Random _random = new(seed);

    public double NextFraction() => _random.NextDouble();
}

/// <summary>
/// The production default <see cref="IJitterSource"/>: backed by the process-wide, thread-safe
/// <see cref="Random.Shared"/> generator. Every sampler instance gets its own unpredictable
/// sequence, so many concurrently-started samplers (multiple targets, multiple app instances)
/// never retry in lockstep after a shared outage -- unlike a fixed seed, which would make every
/// instance compute the identical "random" jitter on every attempt. Tests inject
/// <see cref="SeededJitterSource"/> or an equivalent stub instead, for reproducibility.
/// </summary>
public sealed class SharedRandomJitterSource : IJitterSource
{
    public double NextFraction() => Random.Shared.NextDouble();
}

/// <summary>Configuration for <see cref="LiveIncidentSampler"/>. Cadence is clamped to a safe band (requirement 3): too fast risks server load, too slow misses short-lived incidents.</summary>
public sealed class LiveIncidentSamplerOptions
{
    public static readonly TimeSpan MinCadence = TimeSpan.FromSeconds(2);
    public static readonly TimeSpan MaxCadence = TimeSpan.FromSeconds(5);

    private TimeSpan _cadence = TimeSpan.FromSeconds(3);

    /// <summary>How often a new sample is collected while running. Must be within [2s, 5s].</summary>
    public TimeSpan Cadence
    {
        get => _cadence;
        set
        {
            if (value < MinCadence || value > MaxCadence)
            {
                throw new ArgumentOutOfRangeException(nameof(value), value,
                    $"Cadence must be between {MinCadence} and {MaxCadence} inclusive.");
            }

            _cadence = value;
        }
    }

    /// <summary>The initial reconnect backoff delay after a collection cycle throws unexpectedly.</summary>
    public TimeSpan InitialBackoff { get; set; } = TimeSpan.FromSeconds(1);

    /// <summary>The backoff ceiling; exponential growth never exceeds this.</summary>
    public TimeSpan MaxBackoff { get; set; } = TimeSpan.FromSeconds(60);

    /// <summary>The exponential growth factor applied to the backoff delay after each consecutive failure.</summary>
    public double BackoffMultiplier { get; set; } = 2.0;

    /// <summary>The fraction of the computed backoff delay randomized by jitter, so many sampler instances do not retry in lockstep.</summary>
    public double JitterFraction { get; set; } = 0.2;

    /// <summary>
    /// Validates every cross-field invariant this options object must hold before a sampler can
    /// safely use it: positive initial/max backoff, a ceiling no smaller than the initial delay, a
    /// multiplier that never shrinks the delay, and a jitter fraction that stays within [0, 1] so
    /// it can never widen the delay past the ceiling or invert it negative. Deliberately validated
    /// once, as a whole, rather than per-property-setter, so object-initializer syntax that sets
    /// these in an arbitrary order is never rejected because of a transient, self-consistent
    /// intermediate state.
    /// </summary>
    public void Validate()
    {
        if (InitialBackoff <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(InitialBackoff), InitialBackoff, "InitialBackoff must be positive.");
        }

        if (MaxBackoff <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(MaxBackoff), MaxBackoff, "MaxBackoff must be positive.");
        }

        if (MaxBackoff < InitialBackoff)
        {
            throw new ArgumentOutOfRangeException(nameof(MaxBackoff), MaxBackoff, "MaxBackoff must be greater than or equal to InitialBackoff.");
        }

        if (BackoffMultiplier < 1.0)
        {
            throw new ArgumentOutOfRangeException(nameof(BackoffMultiplier), BackoffMultiplier, "BackoffMultiplier must be at least 1.0 (backoff must never shrink after a failure).");
        }

        if (JitterFraction is < 0.0 or > 1.0)
        {
            throw new ArgumentOutOfRangeException(nameof(JitterFraction), JitterFraction, "JitterFraction must be within [0, 1].");
        }
    }
}

/// <summary>
/// Drives one <see cref="ILiveIncidentCollector"/> on a safe, bounded cadence and publishes exactly
/// one immutable <see cref="LiveIncidentSnapshotV1"/> as "latest" per successful cycle (requirement
/// 3). Properties this type guarantees:
///
/// - Cycles never overlap: the loop always awaits the previous cycle (collection, plus any
///   subscriber notification) before scheduling the next one.
/// - Every cycle increments <see cref="LiveCollectorStatusV1.Sequence"/> exactly once, whether it
///   succeeds or fails.
/// - <see cref="Pause"/>/<see cref="Resume"/> stop and restart the cadence without losing sequence,
///   backoff, or missed/skipped counters.
/// - An unhandled exception from the collector (anything other than a normal
///   <c>LiveIncidentSnapshotV1</c> with a degraded <see cref="DataStatus"/> -- see
///   <c>ILiveIncidentCollector</c>'s own contract) triggers capped exponential backoff with
///   deterministic-in-tests jitter before the next attempt. The whole backoff wait is accounted for
///   in <see cref="LiveCollectorStatusV1.SkippedCycles"/> as however many ordinary cadence slots it
///   actually consumed, not a flat one increment regardless of how long the backoff ran
///   (requirement 12).
/// - <see cref="StopAsync()"/> cancels the loop and awaits its completion for a clean shutdown; no
///   background work continues after it returns.
/// - The loop itself never reads wall-clock time directly: every delay goes through the injected
///   <see cref="TimeProvider"/>, so a test can drive it deterministically end-to-end.
/// - All status fields (<see cref="GetStatus"/>) and <see cref="LatestSnapshot"/> are published as
///   one immutable object per update, guarded by a lock on the writer side and read via
///   <see cref="Volatile"/> reads on the reader side, so a concurrent API request can never observe
///   a torn mix of fields from two different cycles (requirement 10).
/// - Never leaks a raw exception message: an unexpected failure's type and stack trace are logged
///   internally only, and <see cref="LiveCollectorStatusV1.LastErrorReason"/> always holds a fixed,
///   curated, non-secret sentence (requirement 11).
/// </summary>
public sealed partial class LiveIncidentSampler : IAsyncDisposable
{
    private const string UnexpectedFailureReason =
        "An unexpected internal error interrupted this sampling cycle; see the server-side log for detail.";

    private sealed record SamplerState(
        SamplerRunState RunState,
        long Sequence,
        DateTimeOffset? LastSuccessAt,
        DateTimeOffset? LastAttemptAt,
        long ConsecutiveFailures,
        TimeSpan? NextAttemptDelay,
        string? LastErrorReason,
        long MissedCycles,
        long SkippedCycles)
    {
        public static readonly SamplerState Initial = new(SamplerRunState.Stopped, 0, null, null, 0, null, null, 0, 0);
    }

    private readonly ILiveIncidentCollector _collector;
    private readonly LiveIncidentSamplerOptions _options;
    private readonly TimeProvider _timeProvider;
    private readonly IJitterSource _jitter;
    private readonly Action<LiveIncidentSnapshotV1>? _onSnapshot;
    private readonly Action<LiveCollectorStatusV1>? _onStatusChanged;
    private readonly ILogger<LiveIncidentSampler>? _logger;

    private readonly SemaphoreSlim _controlLock = new(1, 1);
    private readonly Lock _stateGate = new();
    private CancellationTokenSource? _loopCancellation;
    private Task? _loopTask;
    private volatile bool _paused;
    private int _disposed;

    private SamplerState _state = SamplerState.Initial;
    private LiveIncidentSnapshotV1? _latestSnapshot;

    public LiveIncidentSampler(
        ILiveIncidentCollector collector,
        LiveIncidentSamplerOptions? options = null,
        TimeProvider? timeProvider = null,
        IJitterSource? jitterSource = null,
        Action<LiveIncidentSnapshotV1>? onSnapshot = null,
        Action<LiveCollectorStatusV1>? onStatusChanged = null,
        ILogger<LiveIncidentSampler>? logger = null)
    {
        ArgumentNullException.ThrowIfNull(collector);
        _collector = collector;
        _options = options ?? new LiveIncidentSamplerOptions();
        _options.Validate();
        _timeProvider = timeProvider ?? TimeProvider.System;
        _jitter = jitterSource ?? new SharedRandomJitterSource();
        _onSnapshot = onSnapshot;
        _onStatusChanged = onStatusChanged;
        _logger = logger;
    }

    /// <summary>The most recently published snapshot, or <c>null</c> if no cycle has completed yet.</summary>
    public LiveIncidentSnapshotV1? LatestSnapshot => Volatile.Read(ref _latestSnapshot);

    public LiveCollectorStatusV1 GetStatus() => ToStatus(ReadState());

    private static LiveCollectorStatusV1 ToStatus(SamplerState s) => new(
        s.RunState,
        s.Sequence,
        s.LastSuccessAt,
        s.LastAttemptAt,
        s.ConsecutiveFailures,
        s.NextAttemptDelay?.TotalMilliseconds,
        s.LastErrorReason,
        s.MissedCycles,
        s.SkippedCycles);

    /// <summary>Starts the sampling loop. Safe to call once; a second call is a no-op while already running.</summary>
    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        await _controlLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_loopTask is not null)
            {
                return;
            }

            _loopCancellation = new CancellationTokenSource();
            _paused = false;
            UpdateState(s => s with { RunState = SamplerRunState.Running });
            _loopTask = RunLoopAsync(_loopCancellation.Token);
        }
        finally
        {
            _controlLock.Release();
        }
    }

    /// <summary>Pauses the cadence after any in-flight cycle finishes. The loop keeps running but performs no further collection until <see cref="Resume"/>.</summary>
    public void Pause()
    {
        _paused = true;
        UpdateState(s => s.RunState == SamplerRunState.Stopped ? s : s with { RunState = SamplerRunState.Paused });
    }

    /// <summary>Resumes a paused sampler; the next cycle runs after the ordinary cadence delay.</summary>
    public void Resume()
    {
        _paused = false;
        UpdateState(s => s.RunState == SamplerRunState.Paused ? s with { RunState = SamplerRunState.Running } : s);
    }

    /// <summary>Cancels the loop and awaits its completion for a clean shutdown; no cycle runs after this returns.</summary>
    public async Task StopAsync()
    {
        if (Volatile.Read(ref _disposed) != 0)
        {
            return; // already torn down by DisposeAsync; a second caller (e.g. a host's own
                     // IHostedService.StopAsync racing container disposal) must be a safe no-op.
        }

        await _controlLock.WaitAsync().ConfigureAwait(false);
        Task? loopTask;
        try
        {
            if (_loopCancellation is null)
            {
                return;
            }

            _loopCancellation.Cancel();
            loopTask = _loopTask;
        }
        finally
        {
            _controlLock.Release();
        }

        if (loopTask is not null)
        {
            try
            {
                await loopTask.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Expected: the loop observes cancellation via Task.Delay and returns.
            }
        }

        await _controlLock.WaitAsync().ConfigureAwait(false);
        try
        {
            _loopCancellation?.Dispose();
            _loopCancellation = null;
            _loopTask = null;
            UpdateState(s => s with { RunState = SamplerRunState.Stopped });
        }
        finally
        {
            _controlLock.Release();
        }
    }

    /// <summary>
    /// Honors <paramref name="timeout"/> as an upper bound on how long shutdown waits for the loop
    /// to observe cancellation and return, so a host's own bounded stop window (e.g.
    /// <c>IHostedService.StopAsync(CancellationToken)</c>) can never be blocked indefinitely by a
    /// stuck cycle. The loop is still asked to cancel either way; this only bounds how long the
    /// caller waits for that to finish, and it never disposes anything twice even if the timeout
    /// elapses while the underlying <see cref="StopAsync()"/> is still tearing the loop down.
    /// </summary>
    public async Task StopAsync(TimeSpan timeout)
    {
        var stopTask = StopAsync();
        var winner = await Task.WhenAny(stopTask, Task.Delay(timeout, _timeProvider)).ConfigureAwait(false);
        if (winner == stopTask)
        {
            await stopTask.ConfigureAwait(false); // observe any exception
        }

        // If the timeout elapsed first, StopAsync keeps running to completion in the background
        // and will still finish tearing the loop down and marking it Stopped; the caller is simply
        // no longer blocked waiting for that to happen.
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync().ConfigureAwait(false);
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return; // Idempotent: a caller registered both as a concrete singleton and as
                     // IHostedService (the same instance under two DI descriptors) can otherwise be
                     // disposed twice by the container.
        }

        await StopAsync().ConfigureAwait(false);

        // _controlLock is deliberately NOT disposed. The _disposed check at the top of StopAsync is
        // a check-then-act: a caller can pass it and then be preempted before reaching
        // _controlLock.WaitAsync(). Host shutdown makes exactly that interleaving routine, because
        // IHostedService.StopAsync and container disposal run back to back, and StopAsync(TimeSpan)
        // can abandon a still-running stop task that resumes later. Disposing the semaphore under
        // any of those races throws ObjectDisposedException out of an unrelated caller. A
        // SemaphoreSlim that never had its AvailableWaitHandle touched (this one never does) holds
        // no unmanaged resource, so leaving it to the GC is both safe and cheaper than the
        // synchronization it would take to prove no one is about to wait on it.
    }

    private async Task RunLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            if (_paused)
            {
                UpdateState(s => s with { MissedCycles = s.MissedCycles + 1 });
                await DelayAsync(_options.Cadence, cancellationToken).ConfigureAwait(false);
                continue;
            }

            var sequence = ReadState().Sequence + 1;
            var attemptAt = _timeProvider.GetUtcNow();
            UpdateState(s => s with { Sequence = sequence, LastAttemptAt = attemptAt });
            try
            {
                var snapshot = await _collector.CollectAsync(sequence, cancellationToken).ConfigureAwait(false);
                Volatile.Write(ref _latestSnapshot, snapshot);
                var successAt = _timeProvider.GetUtcNow();
                UpdateState(s => s with
                {
                    LastSuccessAt = successAt,
                    ConsecutiveFailures = 0,
                    NextAttemptDelay = null,
                    LastErrorReason = null,
                    RunState = s.RunState == SamplerRunState.Paused ? s.RunState : SamplerRunState.Running,
                });

                _onSnapshot?.Invoke(snapshot);
                await DelayAsync(_options.Cadence, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                var reason = ClassifyUnexpectedFailure(ex);
                if (_logger is not null)
                {
                    Log.CycleFailedUnexpectedly(_logger, sequence, ex.GetType().FullName ?? ex.GetType().Name, ex);
                }

                TimeSpan backoff = default;
                UpdateState(s =>
                {
                    var failures = s.ConsecutiveFailures + 1;
                    backoff = ComputeBackoff(failures);
                    // A long backoff silently consumes several ordinary cadence slots; account for
                    // all of them, not a flat single increment regardless of how long the wait is
                    // (requirement 12).
                    var missedSlots = Math.Max(1L, (long)Math.Ceiling(backoff.TotalMilliseconds / _options.Cadence.TotalMilliseconds));
                    return s with
                    {
                        SkippedCycles = s.SkippedCycles + missedSlots,
                        ConsecutiveFailures = failures,
                        LastErrorReason = reason,
                        RunState = SamplerRunState.Reconnecting,
                        NextAttemptDelay = backoff,
                    };
                });

                await DelayAsync(backoff, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// Never surfaces <see cref="Exception.Message"/> directly. A <c>ProbeExecutionException</c> is
    /// already curated safe by its own subclass (see its doc comment), so its <c>Reason</c> is
    /// reused verbatim. Any other exception type reaching here is, by definition, unclassified/
    /// unexpected (a bug, a not-yet-modeled failure mode), so only a fixed generic sentence is
    /// exposed publicly; the real type and stack trace go to the log only.
    /// </summary>
    private static string ClassifyUnexpectedFailure(Exception ex) => ex switch
    {
        SqlSimCity.Collection.Probes.ProbeExecutionException probeEx => probeEx.Reason,
        _ => UnexpectedFailureReason,
    };

    private TimeSpan ComputeBackoff(long consecutiveFailures)
    {
        var exponent = Math.Min(consecutiveFailures - 1, 20); // guards against overflow in Math.Pow
        var scaledTicks = _options.InitialBackoff.Ticks * Math.Pow(_options.BackoffMultiplier, exponent);
        var cappedTicks = Math.Min(scaledTicks, _options.MaxBackoff.Ticks);
        var baseDelay = TimeSpan.FromTicks((long)cappedTicks);

        var jitterRange = baseDelay.Ticks * _options.JitterFraction;
        var jitterTicks = (long)((_jitter.NextFraction() * 2 - 1) * jitterRange); // +/- JitterFraction of the base delay
        var jitteredTicks = Math.Clamp(baseDelay.Ticks + jitterTicks, 0, _options.MaxBackoff.Ticks);
        return TimeSpan.FromTicks(jitteredTicks);
    }

    private Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken) =>
        delay > TimeSpan.Zero ? Task.Delay(delay, _timeProvider, cancellationToken) : Task.CompletedTask;

    private SamplerState ReadState() => Volatile.Read(ref _state);

    private void UpdateState(Func<SamplerState, SamplerState> mutate)
    {
        SamplerState previous;
        SamplerState next;
        lock (_stateGate)
        {
            previous = _state;
            next = mutate(previous);
            Volatile.Write(ref _state, next);
        }

        // Invoked outside the lock so a subscriber calling back into this sampler (e.g. GetStatus)
        // can never deadlock against it. Fired only on an actual run-state transition (Running ->
        // Reconnecting/Paused/Stopped and back), not on every field-level update within the same
        // state (e.g. a routine sequence increment), so a broadcast subscriber sees state changes,
        // not per-cycle noise -- ordinary successful cycles are already covered by onSnapshot.
        if (_onStatusChanged is not null && previous.RunState != next.RunState)
        {
            _onStatusChanged(ToStatus(next));
        }
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Error, Message = "Live incident sampling cycle {Sequence} failed unexpectedly: {ExceptionType}")]
        public static partial void CycleFailedUnexpectedly(ILogger logger, long sequence, string exceptionType, Exception exception);
    }
}
