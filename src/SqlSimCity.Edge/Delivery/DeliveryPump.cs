using SqlSimCity.Edge.Envelope;
using SqlSimCity.Edge.Spool;

namespace SqlSimCity.Edge.Delivery;

/// <summary>Cadence and backoff bounds for the delivery pump.</summary>
public sealed record DeliveryPumpOptions
{
    /// <summary>Base delay for the first transient retry.</summary>
    public TimeSpan BaseRetryDelay { get; init; } = TimeSpan.FromSeconds(2);

    /// <summary>Ceiling on the exponential retry delay.</summary>
    public TimeSpan MaxRetryDelay { get; init; } = TimeSpan.FromMinutes(2);

    /// <summary>Maximum batches to attempt in one drain pass, bounding a single cycle's work.</summary>
    public int MaxBatchesPerDrain { get; init; } = 64;
}

/// <summary>What a drain pass concluded and how long the caller should wait before the next one.</summary>
public sealed record DrainSummary(
    int Delivered,
    int Dropped,
    int Split,
    bool AuthFaulted,
    TimeSpan? SuggestedDelay);

/// <summary>
/// Drives durable, ordered delivery of spooled batches. Every submitted batch is spooled first, so a
/// crash or offline window never loses evidence; the pump then drains the spool oldest-first. It:
/// <list type="bullet">
/// <item>acknowledges (deletes) only the exact batch the server accepted;</item>
/// <item>splits a 413 batch at existing chunk boundaries and re-spools the halves — never re-cuts a chunk;</item>
/// <item>honors 429 <c>Retry-After</c>;</item>
/// <item>stops delivering on an authentication failure rather than retry-storming;</item>
/// <item>drops (with accounting) only a batch the server permanently rejected or an unsplittable 413;</item>
/// <item>backs off transient failures with exponential delay plus deterministic jitter.</item>
/// </list>
/// The pump keeps no unbounded in-memory queue: its backlog lives in the bounded spool.
/// </summary>
public sealed class DeliveryPump
{
    private readonly EncryptedSpool _spool;
    private readonly IDeliveryTransport _transport;
    private readonly DeliveryPumpOptions _options;
    private readonly TimeProvider _timeProvider;
    private readonly Func<double> _jitter;
    private int _consecutiveTransientFailures;

    /// <summary>True once an auth failure has halted delivery; the host must resolve credentials to clear it.</summary>
    public bool AuthFaulted { get; private set; }

    public DeliveryPump(
        EncryptedSpool spool,
        IDeliveryTransport transport,
        DeliveryPumpOptions? options = null,
        TimeProvider? timeProvider = null,
        Func<double>? jitter = null)
    {
        _spool = spool ?? throw new ArgumentNullException(nameof(spool));
        _transport = transport ?? throw new ArgumentNullException(nameof(transport));
        _options = options ?? new DeliveryPumpOptions();
        _timeProvider = timeProvider ?? TimeProvider.System;
        _jitter = jitter ?? Random.Shared.NextDouble;
    }

    /// <summary>Durably enqueues a batch for delivery, applying spool backpressure.</summary>
    public SpoolEnqueueOutcome Submit(ObservationBatchV1 batch) => _spool.Enqueue(batch);

    /// <summary>
    /// Attempts to deliver spooled batches oldest-first until the spool empties, a wait is required,
    /// the per-pass budget is spent, an auth fault occurs, or cancellation is requested.
    /// </summary>
    public async Task<DrainSummary> DrainOnceAsync(CancellationToken cancellationToken)
    {
        if (AuthFaulted)
            return new DrainSummary(0, 0, 0, true, null);

        int delivered = 0, dropped = 0, split = 0;
        for (var attempt = 0; attempt < _options.MaxBatchesPerDrain; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var spooled = _spool.PeekOldest();
            if (spooled is null)
            {
                _consecutiveTransientFailures = 0;
                return new DrainSummary(delivered, dropped, split, false, null);
            }

            var response = await _transport.SendAsync(spooled.Batch, cancellationToken).ConfigureAwait(false);
            switch (response.Outcome)
            {
                case DeliveryOutcome.Accepted:
                    _spool.Acknowledge(spooled.FileName);
                    delivered++;
                    _consecutiveTransientFailures = 0;
                    break;

                case DeliveryOutcome.Conflict:
                case DeliveryOutcome.PermanentReject:
                    // Cannot be retried unchanged; drop with accounting rather than loop forever.
                    _spool.Acknowledge(spooled.FileName);
                    dropped++;
                    break;

                case DeliveryOutcome.PayloadTooLarge:
                    switch (TrySplitAndRespool(spooled))
                    {
                        case SplitResult.Split:
                            split++;
                            break; // Re-drain from the (now smaller) head next iteration.
                        case SplitResult.Unsplittable:
                            // A single chunk the server won't accept cannot be split; drop with accounting.
                            _spool.Acknowledge(spooled.FileName);
                            dropped++;
                            break;
                        case SplitResult.Backpressure:
                        default:
                            // No room to spool the halves right now; retain the original and retry later.
                            return new DrainSummary(delivered, dropped, split, false, NextBackoff());
                    }

                    break;

                case DeliveryOutcome.RateLimited:
                    return new DrainSummary(delivered, dropped, split, false,
                        response.RetryAfter ?? NextBackoff());

                case DeliveryOutcome.AuthRejected:
                    AuthFaulted = true;
                    return new DrainSummary(delivered, dropped, split, true, null);

                case DeliveryOutcome.Transient:
                default:
                    return new DrainSummary(delivered, dropped, split, false, NextBackoff());
            }
        }

        return new DrainSummary(delivered, dropped, split, false, TimeSpan.Zero);
    }

    /// <summary>Clears an auth fault after credentials are known to have been refreshed/rotated.</summary>
    public void ClearAuthFault() => AuthFaulted = false;

    private enum SplitResult { Split, Unsplittable, Backpressure }

    private SplitResult TrySplitAndRespool(SpooledBatch spooled)
    {
        var envelopes = spooled.Batch.Envelopes;
        if (envelopes.Count < 2)
            return SplitResult.Unsplittable;

        var mid = envelopes.Count / 2;
        var now = _timeProvider.GetUtcNow();
        var first = BuildHalf(spooled.Batch, envelopes.Take(mid).ToArray(), now);
        var second = BuildHalf(spooled.Batch, envelopes.Skip(mid).ToArray(), now);

        // Spool both halves before removing the original so a crash mid-split cannot lose evidence.
        // If the second half hits backpressure, roll back the first so we neither duplicate nor lose.
        if (_spool.Enqueue(first, out var firstName) != SpoolEnqueueOutcome.Accepted)
            return SplitResult.Backpressure;
        if (_spool.Enqueue(second) != SpoolEnqueueOutcome.Accepted)
        {
            if (firstName is not null)
                _spool.Acknowledge(firstName);
            return SplitResult.Backpressure;
        }

        _spool.Acknowledge(spooled.FileName);
        return SplitResult.Split;
    }

    private static ObservationBatchV1 BuildHalf(
        ObservationBatchV1 original, ObservationEnvelopeV1[] envelopes, DateTimeOffset now)
    {
        var batchId = $"{original.BatchId}-{envelopes[0].ChunkIndex}-{envelopes.Length}";
        return new ObservationBatchV1(
            SchemaVersion: original.SchemaVersion,
            ConnectorId: original.ConnectorId,
            BatchId: batchId,
            IdempotencyKey: ObservationBatchBuilder.DeriveIdempotencyKey(original.ConnectorId, envelopes),
            CreatedAt: original.CreatedAt,
            PublishedAt: now,
            Envelopes: envelopes);
    }

    private TimeSpan NextBackoff()
    {
        var exponent = Math.Min(_consecutiveTransientFailures, 16);
        _consecutiveTransientFailures++;
        var scaled = _options.BaseRetryDelay.TotalMilliseconds * Math.Pow(2, exponent);
        var capped = Math.Min(scaled, _options.MaxRetryDelay.TotalMilliseconds);
        // Full jitter in [capped/2, capped] to avoid synchronized retries across connectors.
        var jittered = capped * (0.5 + (0.5 * _jitter()));
        return TimeSpan.FromMilliseconds(jittered);
    }
}
