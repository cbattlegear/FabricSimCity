using Microsoft.AspNetCore.SignalR;
using SqlSimCity.Collection.Atlas;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Api;

public sealed class ConnectedAtlasSource(AtlasRefreshCoordinator coordinator)
    : IAtlasSnapshotSource, IAtlasCollectorStatusSource
{
    public AtlasSnapshotV1 GetCurrent() => coordinator.GetCurrent();
    public AtlasCollectorStatusV1 GetStatus() => coordinator.GetStatus();
}

public sealed class AtlasRefreshBackgroundService(
    AtlasRefreshCoordinator coordinator,
    AtlasCollectionOptions options,
    IHubContext<CurrentSnapshotHub> hub,
    TimeProvider timeProvider,
    ILogger<AtlasRefreshBackgroundService> logger) : BackgroundService
{
    private static readonly Action<ILogger, string, Exception?> LogCycleFailure =
        LoggerMessage.Define<string>(
            LogLevel.Error, new EventId(1, "AtlasCycleFailure"),
            "Atlas collection cycle failed unexpectedly ({ExceptionType}); no success was recorded.");
    private static readonly Action<ILogger, string, Exception?> LogNotificationFailure =
        LoggerMessage.Define<string>(
            LogLevel.Warning, new EventId(2, "AtlasNotificationFailure"),
            "Atlas snapshot notification failed ({ExceptionType}); collection remains available.");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await RunCycleAsync(stoppingToken).ConfigureAwait(false);
            var delay = CalculateDelay(coordinator.GetStatus(), options.RefreshInterval, timeProvider);
            try
            {
                await Task.Delay(delay, timeProvider, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

    internal async Task RunCycleAsync(CancellationToken cancellationToken)
    {
        bool refreshed;
        try
        {
            refreshed = await coordinator.TryRefreshAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            coordinator.RecordUnexpectedCycleFailure(
                "Collection cycle failed unexpectedly; no success was recorded.");
            LogCycleFailure(logger, ex.GetType().Name, null);
            return;
        }

        if (!refreshed)
            return;
        var publishedStatus = coordinator.GetStatus();
        if (publishedStatus.State is not (AtlasCollectorState.Ready or AtlasCollectorState.Degraded))
            return;
        try
        {
            await hub.Clients.All.SendAsync(
                "atlasSnapshotAvailable",
                new { publishedStatus.Sequence, SnapshotId = coordinator.GetCurrent().SnapshotId },
                cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            coordinator.RecordNotificationFailure();
            LogNotificationFailure(logger, ex.GetType().Name, null);
        }
    }

    internal static TimeSpan CalculateDelay(
        AtlasCollectorStatusV1 status,
        TimeSpan refreshInterval,
        TimeProvider timeProvider)
    {
        var now = timeProvider.GetUtcNow();
        return status.NextAttemptAt is { } retry && retry > now
            ? retry - now
            : refreshInterval;
    }
}
