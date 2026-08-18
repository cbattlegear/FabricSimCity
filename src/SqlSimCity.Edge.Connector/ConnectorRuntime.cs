using SqlSimCity.Edge.Delivery;
using SqlSimCity.Edge.Spool;

namespace SqlSimCity.Edge.Connector;

/// <summary>
/// Coordinates the connector's two bounded, non-overlapping loops: a collection loop that builds one
/// batch per cadence and durably spools it (applying backpressure), and a delivery loop that drains
/// the spool oldest-first, honoring 429/Retry-After, splitting 413 at chunk boundaries, and stopping
/// on auth failure instead of retry-storming. Neither loop keeps unbounded in-memory state — the
/// backlog lives in the bounded spool. On shutdown the delivery loop performs one final, time-bounded
/// drain so queued evidence has a chance to flush before the process exits.
/// </summary>
public sealed class ConnectorRuntime(
    ConnectorOptions options,
    StructuredLog log,
    ConnectorObservationCollector collector,
    DeliveryPump pump,
    EncryptedSpool spool,
    TimeProvider timeProvider)
{
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        log.Info("connector.start", new Dictionary<string, object?>
        {
            ["connectorId"] = options.ConnectorId,
            ["targetId"] = options.TargetId,
            ["endpoint"] = options.IngestEndpoint.GetLeftPart(UriPartial.Path),
        });

        var collection = CollectionLoopAsync(cancellationToken);
        var delivery = DeliveryLoopAsync(cancellationToken);
        await Task.WhenAll(collection, delivery).ConfigureAwait(false);

        await FinalDrainAsync().ConfigureAwait(false);
        log.Info("connector.stopped", Status());
    }

    private async Task CollectionLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var batch = collector.CollectBatch(timeProvider.GetUtcNow());
                if (batch is not null)
                {
                    var outcome = pump.Submit(batch);
                    if (outcome == SpoolEnqueueOutcome.RejectedBackpressure)
                    {
                        log.Warn("connector.backpressure", Status());
                    }
                    else
                    {
                        log.Info("connector.collected", new Dictionary<string, object?>
                        {
                            ["batchId"] = batch.BatchId,
                            ["chunks"] = batch.Envelopes.Count,
                        });
                    }
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.Error("connector.collect_failed", new Dictionary<string, object?> { ["error"] = ex.GetType().Name });
            }

            if (!await DelayAsync(options.CollectInterval, cancellationToken).ConfigureAwait(false))
                break;
        }
    }

    private async Task DeliveryLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            TimeSpan delay;
            try
            {
                spool.PruneExpired();
                if (pump.AuthFaulted)
                {
                    log.Warn("connector.auth_faulted", Status());
                    delay = options.DeliverInterval;
                }
                else
                {
                    var summary = await pump.DrainOnceAsync(cancellationToken).ConfigureAwait(false);
                    if (summary.Delivered > 0 || summary.Dropped > 0 || summary.Split > 0)
                        log.Info("connector.delivered", DrainFields(summary));
                    if (summary.AuthFaulted)
                        log.Warn("connector.auth_faulted", Status());
                    delay = summary.SuggestedDelay ?? options.DeliverInterval;
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                log.Error("connector.deliver_failed", new Dictionary<string, object?> { ["error"] = ex.GetType().Name });
                delay = options.DeliverInterval;
            }

            if (!await DelayAsync(delay, cancellationToken).ConfigureAwait(false))
                break;
        }
    }

    private async Task FinalDrainAsync()
    {
        if (pump.AuthFaulted)
            return;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        try
        {
            await pump.DrainOnceAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Bounded drain window elapsed; remaining batches stay safely spooled for the next run.
        }
        catch (Exception ex)
        {
            log.Warn("connector.final_drain_failed", new Dictionary<string, object?> { ["error"] = ex.GetType().Name });
        }
    }

    private async Task<bool> DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(delay, timeProvider, cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    private Dictionary<string, object?> DrainFields(DrainSummary summary)
    {
        var fields = Status();
        fields["delivered"] = summary.Delivered;
        fields["dropped"] = summary.Dropped;
        fields["split"] = summary.Split;
        return fields;
    }

    private Dictionary<string, object?> Status()
    {
        var status = spool.GetStatus();
        return new Dictionary<string, object?>
        {
            ["spoolItems"] = status.ItemCount,
            ["spoolBytes"] = status.ByteCount,
            ["paused"] = status.Paused,
            ["droppedByAge"] = status.DroppedByAge,
            ["authFaulted"] = pump.AuthFaulted,
        };
    }
}
