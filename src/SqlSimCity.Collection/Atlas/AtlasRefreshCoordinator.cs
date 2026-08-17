using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Atlas;

public interface IReconnectJitter
{
    double NextUnit();
}

public sealed class RandomReconnectJitter : IReconnectJitter
{
    public double NextUnit() => Random.Shared.NextDouble();
}

public interface IReconnectBackoff
{
    TimeSpan GetDelay(int consecutiveFailures);
}

public sealed class ExponentialReconnectBackoff(
    TimeSpan initial,
    TimeSpan maximum,
    IReconnectJitter jitter) : IReconnectBackoff
{
    public TimeSpan GetDelay(int consecutiveFailures)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(consecutiveFailures, 1);
        if (initial <= TimeSpan.Zero || maximum < initial) throw new InvalidOperationException("Invalid reconnect backoff bounds.");
        var exponent = Math.Min(consecutiveFailures - 1, 30);
        var uncappedTicks = initial.Ticks * Math.Pow(2, exponent);
        var cappedTicks = Math.Min(maximum.Ticks, uncappedTicks);
        var jitterMultiplier = 0.8 + (Math.Clamp(jitter.NextUnit(), 0, 1) * 0.4);
        return TimeSpan.FromTicks((long)(cappedTicks * jitterMultiplier));
    }
}

public sealed class AtlasRefreshCoordinator : IDisposable
{
    private readonly AtlasCollector _collector;
    private readonly AtlasCollectionOptions _options;
    private readonly IReconnectBackoff _backoff;
    private readonly TimeProvider _timeProvider;
    private readonly SemaphoreSlim _cycle = new(1, 1);
    private readonly object _gate = new();
    private AtlasSnapshotV1? _snapshot;
    private AtlasCollectorStatusV1 _status;
    private long _sequence;
    private bool _paused;

    public AtlasRefreshCoordinator(
        AtlasCollector collector,
        AtlasCollectionOptions options,
        IReconnectBackoff backoff,
        TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(collector);
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(backoff);
        options.Validate();
        _collector = collector;
        _options = options;
        _backoff = backoff;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _status = new AtlasCollectorStatusV1(
            AtlasCollectorMode.Connected, AtlasCollectorState.Disconnected, 0, null, null, null,
            true, 0, 0, 0, 0, 0, null, "Connected collection has not completed its first cycle.");
    }

    public event Action<AtlasSnapshotV1>? SnapshotPublished;

    public bool IsPaused
    {
        get { lock (_gate) return _paused; }
    }

    public void Pause()
    {
        lock (_gate)
        {
            _paused = true;
            _status = _status with { State = AtlasCollectorState.Paused, Reason = "Collection is paused." };
        }
    }

    public void Resume()
    {
        lock (_gate)
        {
            _paused = false;
            _status = _status with
            {
                State = _snapshot?.Collection?.State ?? AtlasCollectorState.Disconnected,
                Reason = "Collection resumed.",
                NextAttemptAt = null,
            };
        }
    }

    public async Task<bool> TryRefreshAsync(CancellationToken cancellationToken)
    {
        if (IsPaused || !await _cycle.WaitAsync(0, cancellationToken).ConfigureAwait(false))
            return false;
        try
        {
            lock (_gate)
                _status = _status with { State = AtlasCollectorState.Collecting, Reason = "Collection cycle is running." };
            var sequence = Interlocked.Increment(ref _sequence);
            var result = await _collector.CollectAsync(sequence, cancellationToken).ConfigureAwait(false);
            AtlasSnapshotV1? published = null;
            lock (_gate)
            {
                if (result.ConnectionFailure)
                {
                    var failures = _status.ConsecutiveFailures + 1;
                    var delay = _backoff.GetDelay(failures);
                    _status = _status with
                    {
                        State = AtlasCollectorState.BackingOff,
                        Sequence = result.Status.Sequence,
                        FailureCount = result.Status.FailureCount,
                        LastDurationMilliseconds = result.Status.LastDurationMilliseconds,
                        ConsecutiveFailures = failures,
                        NextAttemptAt = _timeProvider.GetUtcNow() + delay,
                        Reason = result.Status.Reason,
                    };
                }
                else
                {
                    _snapshot = result.Snapshot;
                    _status = result.Status with { ConsecutiveFailures = 0, NextAttemptAt = null };
                    published = _snapshot;
                }
            }
            if (published is not null)
                SnapshotPublished?.Invoke(published);
            return true;
        }
        finally
        {
            _cycle.Release();
        }
    }

    public AtlasSnapshotV1 GetCurrent()
    {
        lock (_gate)
        {
            if (_snapshot is null)
            {
                return new AtlasSnapshotV1(
                    "1.0", $"{_options.TargetId}/pending", new AtlasTargetV1(_options.TargetId, _options.DisplayName, "Connected"),
                    _timeProvider.GetUtcNow(), [], [])
                {
                    Collection = Metadata(_status),
                };
            }

            var stale = IsStale(_status);
            return _snapshot with
            {
                Collection = _snapshot.Collection is null
                    ? Metadata(_status)
                    : _snapshot.Collection with { IsStale = stale, State = stale ? AtlasCollectorState.Degraded : _status.State },
            };
        }
    }

    public AtlasCollectorStatusV1 GetStatus()
    {
        lock (_gate)
        {
            var stale = IsStale(_status);
            return _status with
            {
                IsStale = stale,
                State = stale && _status.State == AtlasCollectorState.Ready
                    ? AtlasCollectorState.Degraded
                    : _status.State,
            };
        }
    }

    private bool IsStale(AtlasCollectorStatusV1 status) =>
        status.StaleAfter is null || _timeProvider.GetUtcNow() > status.StaleAfter;

    private static AtlasCollectionMetadataV1 Metadata(AtlasCollectorStatusV1 status) => new(
        status.Mode, status.State, status.Sequence, status.LastCollectedAt ?? DateTimeOffset.MinValue,
        status.SourceTimestamp ?? DateTimeOffset.MinValue, status.StaleAfter, status.IsStale,
        status.DatabaseCount, status.FailureCount, status.SkipCount, status.LastDurationMilliseconds, status.Reason)
    {
        RowCount = status.RowCount,
    };

    public void Dispose() => _cycle.Dispose();
}
