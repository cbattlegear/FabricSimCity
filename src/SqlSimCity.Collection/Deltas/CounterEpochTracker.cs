using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Deltas;

/// <summary>
/// Per-key (for example, one <c>(database_id, file_id)</c> file, or one <c>scheduler_id</c>) prior-
/// sample memory for <see cref="DeltaCalculator"/>, so a collector can ask for a delta on every
/// cycle without hand-rolling its own dictionary of previous observations and epoch ids. Not
/// thread-safe by design: the sampler guarantees at most one collection cycle runs at a time (see
/// <c>SqlSimCity.Collection.Sampling.LiveIncidentSampler</c>), so this never needs to be.
/// </summary>
public sealed class CounterEpochTracker<TKey> where TKey : notnull
{
    private readonly Dictionary<TKey, CounterObservation> _lastObservation = new();
    private readonly Dictionary<TKey, long> _epochId = new();

    public CounterDeltaV1 Compute(TKey key, CounterObservation current)
    {
        var previous = _lastObservation.TryGetValue(key, out var found) ? found : (CounterObservation?)null;
        var epochId = _epochId.GetValueOrDefault(key, 0);
        var (delta, nextEpochId) = DeltaCalculator.Compute(previous, current, epochId);

        _lastObservation[key] = current;
        _epochId[key] = nextEpochId;

        return delta;
    }

    public long CurrentEpochId(TKey key) => _epochId.GetValueOrDefault(key, 0);

    /// <summary>Drops every remembered key not present in <paramref name="liveKeys"/>, so a file/scheduler that disappears does not leak memory across a long-running sampler.</summary>
    public void Prune(IReadOnlyCollection<TKey> liveKeys)
    {
        var liveSet = liveKeys as HashSet<TKey> ?? new HashSet<TKey>(liveKeys);
        foreach (var stale in _lastObservation.Keys.Where(k => !liveSet.Contains(k)).ToList())
        {
            _lastObservation.Remove(stale);
            _epochId.Remove(stale);
        }
    }
}
