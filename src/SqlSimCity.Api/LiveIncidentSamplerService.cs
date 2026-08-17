using Microsoft.AspNetCore.SignalR;
using SqlSimCity.Collection.Sampling;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Api;

/// <summary>
/// Owns the process-wide <see cref="LiveIncidentSampler"/>: starts/stops it with the ASP.NET Core
/// host lifecycle (<see cref="IHostedService"/>) and pushes exactly the latest
/// <see cref="LiveIncidentResponseV1"/> to every connected SignalR client whenever a new snapshot
/// completes -- one message per successful cycle, never an accumulating history, so a client that
/// misses a push simply gets the next one instead of a growing backlog (requirement 7). The same
/// snapshot is available synchronously via <see cref="GetCurrentResponse"/>, which
/// <c>/api/v1/live</c> and <see cref="CurrentSnapshotHub.GetCurrentLiveSnapshot"/> both read.
/// </summary>
public sealed class LiveIncidentSamplerService : IHostedService, IAsyncDisposable
{
    private const string LiveIncidentUpdatedMethod = "liveIncidentUpdated";

    private readonly LiveIncidentSampler _sampler;
    private readonly IHubContext<CurrentSnapshotHub> _hubContext;

    public LiveIncidentSamplerService(
        ILiveIncidentCollector collector,
        IHubContext<CurrentSnapshotHub> hubContext,
        LiveIncidentSamplerOptions? options = null,
        TimeProvider? timeProvider = null)
    {
        _hubContext = hubContext;
        _sampler = new LiveIncidentSampler(
            collector,
            options ?? new LiveIncidentSamplerOptions(),
            timeProvider,
            onSnapshot: OnSnapshot);
    }

    public LiveIncidentResponseV1 GetCurrentResponse() => new(_sampler.LatestSnapshot, _sampler.GetStatus());

    public Task StartAsync(CancellationToken cancellationToken) => _sampler.StartAsync(cancellationToken);

    public Task StopAsync(CancellationToken cancellationToken) => _sampler.StopAsync();

    public ValueTask DisposeAsync() => _sampler.DisposeAsync();

    private void OnSnapshot(LiveIncidentSnapshotV1 snapshot)
    {
        // Fire-and-forget: broadcasting must never block or slow the sampling loop itself, and a
        // client observes only the current response, never a queued replay of earlier ones.
        _ = _hubContext.Clients.All.SendAsync(LiveIncidentUpdatedMethod, GetCurrentResponse());
    }
}
