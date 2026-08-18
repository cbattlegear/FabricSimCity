using SqlSimCity.Edge.Envelope;

namespace SqlSimCity.Edge.Ingestion;

/// <summary>An immutable, published view of one section's most recently accepted evidence for a target.</summary>
public sealed record SectionGeneration(
    ObservationSection Section,
    long Sequence,
    string EpochId,
    string BootId,
    DateTimeOffset CapturedAt,
    ObservationFreshnessV1 Freshness,
    long Generation,
    byte[] Content);

/// <summary>A generic, non-secret status summary for one monitored target, for the source/status panel.</summary>
public sealed record EdgeTargetStatus(
    string TargetId,
    string ConnectorId,
    long LastSequence,
    string EpochId,
    DateTimeOffset LastCapturedAt,
    IReadOnlyList<ObservationSection> Sections,
    bool Fresh);

/// <summary>
/// Holds the immutable observation generations assembled from accepted connector batches, keyed by
/// target and section. Chunks of a section may arrive across several batches (paged Query Store, or a
/// 413 split); the store buffers a group's chunks and publishes the section only when the group is
/// complete, so a partial generation is never visible. Ingestion is atomic per batch: idempotency,
/// epoch, and sequence conflicts are resolved before any chunk is buffered, so a rejected batch
/// leaves no trace. Edge targets live in their own namespace and can never replace a fixture or
/// connected source; multiple connectors and targets coexist without mixing ids.
/// </summary>
public sealed class EdgeObservationStore
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, TargetState> _targets = new(StringComparer.Ordinal);
    private readonly HashSet<string> _acceptedIdempotencyKeys = new(StringComparer.Ordinal);
    private readonly Queue<string> _idempotencyOrder = new();
    private readonly Dictionary<string, string> _batchIdToKey = new(StringComparer.Ordinal);
    private readonly int _idempotencyHistoryLimit;
    private readonly int _maxSectionBytes;
    private readonly TimeProvider _timeProvider;
    private long _generation;

    public EdgeObservationStore(TimeProvider? timeProvider = null, int idempotencyHistoryLimit = 8192, int maxSectionBytes = 32 * 1024 * 1024)
    {
        _timeProvider = timeProvider ?? TimeProvider.System;
        _idempotencyHistoryLimit = idempotencyHistoryLimit;
        _maxSectionBytes = maxSectionBytes;
    }

    /// <summary>
    /// Commits an already structurally validated batch. Applies idempotency, epoch, and sequence
    /// rules atomically, then buffers chunks and publishes any section whose group completed.
    /// </summary>
    public IngestionResult Ingest(ObservationBatchV1 batch, IReadOnlyList<ValidatedChunk> chunks)
    {
        ArgumentNullException.ThrowIfNull(batch);
        ArgumentNullException.ThrowIfNull(chunks);

        lock (_gate)
        {
            if (_acceptedIdempotencyKeys.Contains(batch.IdempotencyKey))
                return IngestionResult.Duplicate;

            if (_batchIdToKey.TryGetValue(batch.BatchId, out var priorKey) &&
                !string.Equals(priorKey, batch.IdempotencyKey, StringComparison.Ordinal))
            {
                return IngestionResult.Conflict("Batch id was reused with different content.");
            }

            // Validate ownership, epoch, sequence, and cumulative section size for every chunk before
            // mutating any state, so a rejected batch leaves no trace (all-or-nothing).
            var projectedGroupBytes = new Dictionary<string, long>(StringComparer.Ordinal);
            foreach (var chunk in chunks)
            {
                var state = GetOrCreateState(chunk.TargetId, batch.ConnectorId);
                if (!string.Equals(state.ConnectorId, batch.ConnectorId, StringComparison.Ordinal))
                    return IngestionResult.Conflict("Target is already owned by a different connector.");

                var admission = state.Evaluate(chunk);
                if (admission != AdmissionDecision.Admit)
                {
                    return admission == AdmissionDecision.RetiredEpoch
                        ? IngestionResult.Conflict("Chunk references a retired epoch.")
                        : IngestionResult.Conflict("Chunk sequence rolls back published state.");
                }

                // Bound the total bytes an in-progress cross-batch group may accumulate.
                var budgetKey = $"{chunk.TargetId}\u0001{chunk.Section}\u0001{chunk.EpochId}\u0001{chunk.Sequence}\u0001{chunk.ChunkGroupId}";
                if (!projectedGroupBytes.TryGetValue(budgetKey, out var running))
                    running = state.PendingBytes(chunk.Section, chunk.EpochId, chunk.Sequence, chunk.ChunkGroupId);
                running += chunk.Content.LongLength;
                if (running > _maxSectionBytes)
                    return IngestionResult.Rejected("Section exceeds the maximum reassembled size.");
                projectedGroupBytes[budgetKey] = running;
            }

            // Commit: apply epoch transitions, buffer chunks, and publish completed groups.
            foreach (var chunk in chunks)
            {
                var state = _targets[chunk.TargetId];
                state.Admit(chunk, () => ++_generation, _timeProvider.GetUtcNow());
            }

            RecordIdempotency(batch.BatchId, batch.IdempotencyKey);
            return IngestionResult.Accepted;
        }
    }

    /// <summary>Returns the latest published generation for one section of a target, or <c>null</c>.</summary>
    public SectionGeneration? GetSection(string targetId, ObservationSection section)
    {
        lock (_gate)
        {
            return _targets.TryGetValue(targetId, out var state) ? state.GetSection(section) : null;
        }
    }

    /// <summary>Returns a status summary for every known target.</summary>
    public IReadOnlyList<EdgeTargetStatus> GetTargets()
    {
        lock (_gate)
        {
            var now = _timeProvider.GetUtcNow();
            return _targets.Values.Select(state => state.ToStatus(now)).ToArray();
        }
    }

    private TargetState GetOrCreateState(string targetId, string connectorId)
    {
        if (!_targets.TryGetValue(targetId, out var state))
        {
            state = new TargetState(targetId, connectorId);
            _targets[targetId] = state;
        }

        return state;
    }

    private void RecordIdempotency(string batchId, string key)
    {
        if (_acceptedIdempotencyKeys.Add(key))
        {
            _idempotencyOrder.Enqueue(key);
            _batchIdToKey[batchId] = key;
            while (_idempotencyOrder.Count > _idempotencyHistoryLimit)
            {
                var evicted = _idempotencyOrder.Dequeue();
                _acceptedIdempotencyKeys.Remove(evicted);
            }
        }
    }

    private enum AdmissionDecision { Admit, RetiredEpoch, Rollback }

    private sealed class TargetState(string targetId, string connectorId)
    {
        private readonly Dictionary<ObservationSection, SectionSlot> _slots = new();
        private readonly HashSet<string> _retiredEpochs = new(StringComparer.Ordinal);

        public string ConnectorId { get; } = connectorId;
        public string EpochId { get; private set; } = string.Empty;
        public long LastSequence { get; private set; } = -1;
        public DateTimeOffset LastCapturedAt { get; private set; }

        public AdmissionDecision Evaluate(ValidatedChunk chunk)
        {
            if (!string.Equals(chunk.EpochId, EpochId, StringComparison.Ordinal))
                return _retiredEpochs.Contains(chunk.EpochId) ? AdmissionDecision.RetiredEpoch : AdmissionDecision.Admit;

            // Same epoch: never accept a sequence that regresses a section already published at a
            // higher sequence. Equal or higher is allowed (equal supports multi-batch group assembly).
            var slot = GetSlot(chunk.Section);
            return chunk.Sequence >= slot.PublishedSequence ? AdmissionDecision.Admit : AdmissionDecision.Rollback;
        }

        public void Admit(ValidatedChunk chunk, Func<long> nextGeneration, DateTimeOffset now)
        {
            if (!string.Equals(chunk.EpochId, EpochId, StringComparison.Ordinal))
            {
                if (!string.IsNullOrEmpty(EpochId))
                    _retiredEpochs.Add(EpochId);
                EpochId = chunk.EpochId;
                LastSequence = -1;
                foreach (var slot in _slots.Values)
                    slot.ResetForNewEpoch();
            }

            LastSequence = Math.Max(LastSequence, chunk.Sequence);
            if (chunk.CapturedAt > LastCapturedAt)
                LastCapturedAt = chunk.CapturedAt;

            var target = GetSlot(chunk.Section);
            target.Buffer(chunk, nextGeneration);
        }

        public SectionGeneration? GetSection(ObservationSection section)
            => _slots.TryGetValue(section, out var slot) ? slot.Published : null;

        public long PendingBytes(ObservationSection section, string epochId, long sequence, string groupId)
        {
            // A group buffered under a since-retired/replaced epoch contributes nothing.
            if (!string.Equals(epochId, EpochId, StringComparison.Ordinal))
                return 0;
            return _slots.TryGetValue(section, out var slot) ? slot.PendingBytes(epochId, sequence, groupId) : 0;
        }

        public EdgeTargetStatus ToStatus(DateTimeOffset now)
        {
            var published = _slots.Where(pair => pair.Value.Published is not null).ToArray();
            var fresh = published.Any(pair =>
                pair.Value.Published!.Freshness.FreshUntil is null || pair.Value.Published!.Freshness.FreshUntil >= now);
            return new EdgeTargetStatus(
                targetId, ConnectorId, LastSequence, EpochId, LastCapturedAt,
                published.Select(pair => pair.Key).OrderBy(k => k).ToArray(), fresh);
        }

        private SectionSlot GetSlot(ObservationSection section)
        {
            if (!_slots.TryGetValue(section, out var slot))
            {
                slot = new SectionSlot(section);
                _slots[section] = slot;
            }

            return slot;
        }
    }

    private sealed class SectionSlot(ObservationSection section)
    {
        private readonly Dictionary<string, PartialGroup> _pending = new(StringComparer.Ordinal);

        public long PublishedSequence { get; private set; } = -1;
        public SectionGeneration? Published { get; private set; }

        public void ResetForNewEpoch()
        {
            _pending.Clear();
            PublishedSequence = -1;
        }

        public long PendingBytes(string epochId, long sequence, string groupId)
        {
            var groupKey = $"{epochId}\u0001{sequence}\u0001{groupId}";
            return _pending.TryGetValue(groupKey, out var group) ? group.BufferedBytes : 0;
        }

        public void Buffer(ValidatedChunk chunk, Func<long> nextGeneration)
        {
            var groupKey = $"{chunk.EpochId}\u0001{chunk.Sequence}\u0001{chunk.ChunkGroupId}";
            if (!_pending.TryGetValue(groupKey, out var group))
            {
                group = new PartialGroup(chunk.ChunkCount);
                _pending[groupKey] = group;
            }

            group.Add(chunk);
            if (!group.IsComplete)
                return;

            _pending.Remove(groupKey);
            if (chunk.Sequence <= PublishedSequence)
                return; // A newer generation already won; drop the late group.

            Published = new SectionGeneration(
                section, chunk.Sequence, chunk.EpochId, chunk.BootId, chunk.CapturedAt,
                chunk.Freshness, nextGeneration(), group.Reassemble());
            PublishedSequence = chunk.Sequence;

            // Any still-pending group at or below the just-published sequence is now stale.
            foreach (var stale in _pending
                         .Where(pair => ParseSequence(pair.Key) <= PublishedSequence)
                         .Select(pair => pair.Key).ToArray())
            {
                _pending.Remove(stale);
            }
        }

        private static long ParseSequence(string groupKey)
        {
            var parts = groupKey.Split('\u0001');
            return long.Parse(parts[1], System.Globalization.CultureInfo.InvariantCulture);
        }
    }

    private sealed class PartialGroup(int chunkCount)
    {
        private readonly Dictionary<int, byte[]> _chunks = new();

        public bool IsComplete => _chunks.Count == chunkCount;

        public long BufferedBytes { get; private set; }

        public void Add(ValidatedChunk chunk)
        {
            if (chunk.ChunkCount != chunkCount)
                return; // Inconsistent count for the group; ignore the odd chunk.
            if (_chunks.TryAdd(chunk.ChunkIndex, chunk.Content))
                BufferedBytes += chunk.Content.LongLength;
        }

        public byte[] Reassemble()
        {
            long total = 0;
            for (var i = 0; i < chunkCount; i++)
                total += _chunks[i].Length;

            var buffer = new byte[total];
            var offset = 0;
            for (var i = 0; i < chunkCount; i++)
            {
                var chunk = _chunks[i];
                Array.Copy(chunk, 0, buffer, offset, chunk.Length);
                offset += chunk.Length;
            }

            return buffer;
        }
    }
}
