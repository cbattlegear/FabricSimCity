using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Collection.Sampling;

/// <summary>A source of jitter fractions in <c>[0, 1)</c> for backoff randomization. Injectable so backoff timing is deterministic in tests (requirement 3).</summary>
public interface IJitterSource
{
    double NextFraction();
}

/// <summary>A <see cref="Random"/>-backed <see cref="IJitterSource"/>. Seeded explicitly so its sequence is reproducible, never <see cref="Random.Shared"/>.</summary>
public sealed class SeededJitterSource(int seed) : IJitterSource
{
    private readonly Random _random = new(seed);

    public double NextFraction() => _random.NextDouble();
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
}

/// <summary>
/// Drives one <see cref="ILiveIncidentCollector"/> on a safe, bounded cadence and publishes exactly
/// one immutable <see cref="LiveIncidentSnapshotV1"/> as "latest" per successful cycle (requirement
/// 3). Properties this type guarantees:
///
/// - Cycles never overlap: the loop always awaits the previous cycle (collection, plus any
///   subscriber notification) before scheduling the next one.
/// - Every cycle increments <see cref="Sequence"/> exactly once, whether it succeeds or fails.
/// - <see cref="Pause"/>/<see cref="Resume"/> stop and restart the cadence without losing sequence,
///   backoff, or missed/skipped counters.
/// - An unhandled exception from the collector (anything other than a normal
///   <c>LiveIncidentSnapshotV1</c> with a degraded <see cref="DataStatus"/> -- see
///   <c>ILiveIncidentCollector</c>'s own contract) triggers capped exponential backoff with
///   deterministic jitter before the next attempt; every cycle skipped while backing off increments
///   <see cref="MissedCycles"/>.
/// - <see cref="StopAsync"/> cancels the loop and awaits its completion for a clean shutdown; no
///   background work continues after it returns.
/// - The loop itself never reads wall-clock time directly: every delay goes through the injected
///   <see cref="TimeProvider"/>, so a test can drive it deterministically end-to-end.
/// </summary>
public sealed class LiveIncidentSampler : IAsyncDisposable
{
    private readonly ILiveIncidentCollector _collector;
    private readonly LiveIncidentSamplerOptions _options;
    private readonly TimeProvider _timeProvider;
    private readonly IJitterSource _jitter;
    private readonly Action<LiveIncidentSnapshotV1>? _onSnapshot;

    private readonly SemaphoreSlim _controlLock = new(1, 1);
    private CancellationTokenSource? _loopCancellation;
    private Task? _loopTask;
    private volatile bool _paused;
    private int _disposed;

    private long _sequence;
    private long _missedCycles;
    private long _skippedCycles;
    private long _consecutiveFailures;
    private LiveIncidentSnapshotV1? _latestSnapshot;
    private DateTimeOffset? _lastSuccessAt;
    private DateTimeOffset? _lastAttemptAt;
    private string? _lastErrorReason;
    private TimeSpan? _nextAttemptDelay;
    private SamplerRunState _state = SamplerRunState.Stopped;

    public LiveIncidentSampler(
        ILiveIncidentCollector collector,
        LiveIncidentSamplerOptions? options = null,
        TimeProvider? timeProvider = null,
        IJitterSource? jitterSource = null,
        Action<LiveIncidentSnapshotV1>? onSnapshot = null)
    {
        ArgumentNullException.ThrowIfNull(collector);
        _collector = collector;
        _options = options ?? new LiveIncidentSamplerOptions();
        _timeProvider = timeProvider ?? TimeProvider.System;
        _jitter = jitterSource ?? new SeededJitterSource(seed: 0);
        _onSnapshot = onSnapshot;
    }

    /// <summary>The most recently published snapshot, or <c>null</c> if no cycle has completed yet.</summary>
    public LiveIncidentSnapshotV1? LatestSnapshot => _latestSnapshot;

    public LiveCollectorStatusV1 GetStatus() => new(
        _state,
        Interlocked.Read(ref _sequence),
        _lastSuccessAt,
        _lastAttemptAt,
        Interlocked.Read(ref _consecutiveFailures),
        _nextAttemptDelay?.TotalMilliseconds,
        _lastErrorReason,
        Interlocked.Read(ref _missedCycles),
        Interlocked.Read(ref _skippedCycles));

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
            _state = SamplerRunState.Running;
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
        if (_state != SamplerRunState.Stopped)
        {
            _state = SamplerRunState.Paused;
        }
    }

    /// <summary>Resumes a paused sampler; the next cycle runs after the ordinary cadence delay.</summary>
    public void Resume()
    {
        _paused = false;
        if (_state == SamplerRunState.Paused)
        {
            _state = SamplerRunState.Running;
        }
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
            _state = SamplerRunState.Stopped;
        }
        finally
        {
            _controlLock.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync().ConfigureAwait(false);
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return; // Idempotent: a caller registered both as a concrete singleton and as
                     // IHostedService (the same instance under two DI descriptors) can otherwise be
                     // disposed twice by the container, which would double-dispose _controlLock.
        }

        await StopAsync().ConfigureAwait(false);
        _controlLock.Dispose();
    }

    private async Task RunLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            if (_paused)
            {
                Interlocked.Increment(ref _missedCycles);
                await DelayAsync(_options.Cadence, cancellationToken).ConfigureAwait(false);
                continue;
            }

            var sequence = Interlocked.Increment(ref _sequence);
            _lastAttemptAt = _timeProvider.GetUtcNow();
            try
            {
                var snapshot = await _collector.CollectAsync(sequence, cancellationToken).ConfigureAwait(false);
                _latestSnapshot = snapshot;
                _lastSuccessAt = _timeProvider.GetUtcNow();
                Interlocked.Exchange(ref _consecutiveFailures, 0);
                _nextAttemptDelay = null;
                _lastErrorReason = null;
                if (_state != SamplerRunState.Paused)
                {
                    _state = SamplerRunState.Running;
                }

                _onSnapshot?.Invoke(snapshot);
                await DelayAsync(_options.Cadence, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                Interlocked.Increment(ref _skippedCycles);
                var failures = Interlocked.Increment(ref _consecutiveFailures);
                _lastErrorReason = ex.Message;
                _state = SamplerRunState.Reconnecting;
                var backoff = ComputeBackoff(failures);
                _nextAttemptDelay = backoff;
                await DelayAsync(backoff, cancellationToken).ConfigureAwait(false);
            }
        }
    }

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
}
