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
        await foreach (var value in _channel.Reader.ReadAllAsync().ConfigureAwait(false))
        {
            try
            {
                await publishAsync(value, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                // A delivery failure (e.g. no connected SignalR clients, a transport hiccup) must
                // never crash the drain loop or escape as an unobserved task exception -- the next
                // published value simply supersedes this one.
                if (logger is not null)
                {
                    LatestValuePublisherLog.BroadcastFailed(logger, typeof(T).Name, ex);
                }
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        _channel.Writer.TryComplete();
        try
        {
            await _drainTask.ConfigureAwait(false);
        }
        catch
        {
            // Already logged inside DrainAsync; disposal must not throw for a delivery failure.
        }
    }
}

internal static partial class LatestValuePublisherLog
{
    [LoggerMessage(Level = LogLevel.Warning, Message = "Live incident {PayloadType} broadcast failed.")]
    public static partial void BroadcastFailed(ILogger logger, string payloadType, Exception exception);
}
