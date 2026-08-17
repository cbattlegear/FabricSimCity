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
    IHubContext<CurrentSnapshotHub> hub) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var refreshed = await coordinator.TryRefreshAsync(stoppingToken).ConfigureAwait(false);
                if (refreshed)
                {
                    var publishedStatus = coordinator.GetStatus();
                    if (publishedStatus.State is AtlasCollectorState.Ready or AtlasCollectorState.Degraded)
                    {
                        await hub.Clients.All.SendAsync("atlasSnapshotAvailable",
                            new { publishedStatus.Sequence, SnapshotId = coordinator.GetCurrent().SnapshotId },
                            stoppingToken).ConfigureAwait(false);
                    }
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            var status = coordinator.GetStatus();
            var now = DateTimeOffset.UtcNow;
            var delay = status.NextAttemptAt is { } retry && retry > now
                ? retry - now
                : options.RefreshInterval;
            await Task.Delay(delay, stoppingToken).ConfigureAwait(false);
        }
    }
}
