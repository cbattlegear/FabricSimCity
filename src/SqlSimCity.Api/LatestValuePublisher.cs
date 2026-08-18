using System.Threading.Channels;
using Microsoft.Extensions.Logging;

namespace SqlSimCity.Api;

/// <summary>
/// A bounded, capacity-one "latest value wins" publisher. Writing a new value while an older one
/// is still queued for delivery silently drops the older one instead of growing an unbounded
/// backlog, and one background task drains the channel and awaits/observes every delivery so a
/// broadcast failure can never become an unobserved task exception or an unbounded fire-and-forget
/// queue (requirement 13). Disposal completes the channel and awaits the drain task, so no
/// broadcast is left running after the publisher (and, transitively, its owning host) shuts down.
/// </summary>
internal sealed class LatestValuePublisher<T> : IAsyncDisposable
{
    private readonly Channel<T> _channel;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly Task _drainTask;

    public LatestValuePublisher(Func<T, CancellationToken, Task> publishAsync, ILogger? logger = null)
    {
        ArgumentNullException.ThrowIfNull(publishAsync);
        _channel = Channel.CreateBounded<T>(new BoundedChannelOptions(1)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false,
        });
        _drainTask = DrainAsync(publishAsync, logger);
    }

    /// <summary>Enqueues a value for delivery, replacing any not-yet-delivered prior value. Never blocks and never throws.</summary>
    public bool TryPublish(T value) => _channel.Writer.TryWrite(value);

    private async Task DrainAsync(Func<T, CancellationToken, Task> publishAsync, ILogger? logger)
    {
        try
        {
            await foreach (var value in _channel.Reader.ReadAllAsync(_shutdown.Token).ConfigureAwait(false))
            {
                try
                {
                    await publishAsync(value, _shutdown.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception ex)
                {
                    // A delivery failure (e.g. no connected SignalR clients, a transport hiccup)
                    // must not crash the drain loop; the next value supersedes this one.
                    if (logger is not null)
                    {
                        LatestValuePublisherLog.BroadcastFailed(logger, typeof(T).Name, ex);
                    }
                }
            }
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
            // Host shutdown cancels an in-flight transport send and abandons pending values.
        }
    }

    public async ValueTask DisposeAsync()
    {
        _channel.Writer.TryComplete();
        await _shutdown.CancelAsync().ConfigureAwait(false);
        try
        {
            await _drainTask.ConfigureAwait(false);
        }
        catch
        {
            // Already logged inside DrainAsync; disposal must not throw for a delivery failure.
        }
        finally
        {
            _shutdown.Dispose();
        }
    }
}

internal static partial class LatestValuePublisherLog
{
    [LoggerMessage(Level = LogLevel.Warning, Message = "Live incident {PayloadType} broadcast failed.")]
    public static partial void BroadcastFailed(ILogger logger, string payloadType, Exception exception);
}
