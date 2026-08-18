using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using SqlSimCity.Collection.Sampling;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Api;

/// <summary>
/// Owns the process-wide <see cref="LiveIncidentSampler"/>: starts/stops it with the ASP.NET Core
/// host lifecycle (<see cref="IHostedService"/>) and pushes exactly the latest
/// <see cref="LiveIncidentResponseV1"/> to every connected SignalR client whenever a new snapshot
/// completes or the sampler's run state transitions (e.g. Reconnecting/Paused/Stopped) -- through a
/// bounded, capacity-one <see cref="LatestValuePublisher{T}"/> so a slow or disconnected transport
/// can never build an unbounded backlog or leave an unobserved faulted task (requirement 13). The
/// same snapshot is available synchronously via <see cref="GetCurrentResponse"/>, which
/// <c>/api/v1/live</c> and <see cref="CurrentSnapshotHub.GetCurrentLiveSnapshot"/> both read.
/// </summary>
public sealed class LiveIncidentSamplerService : IHostedService, IAsyncDisposable
{
    private const string LiveIncidentUpdatedMethod = "liveIncidentUpdated";

    private readonly LiveIncidentSampler _sampler;
    private readonly IHubContext<CurrentSnapshotHub> _hubContext;
    private readonly LatestValuePublisher<LiveIncidentResponseV1> _publisher;
    private int _disposed;

    public LiveIncidentSamplerService(
        ILiveIncidentCollector collector,
        IHubContext<CurrentSnapshotHub> hubContext,
        LiveIncidentSamplerOptions? options = null,
        TimeProvider? timeProvider = null,
        ILogger<LiveIncidentSampler>? samplerLogger = null,
        ILogger<LiveIncidentSamplerService>? logger = null)
    {
        _hubContext = hubContext;
        _publisher = new LatestValuePublisher<LiveIncidentResponseV1>(BroadcastAsync, logger);
        _sampler = new LiveIncidentSampler(
            collector,
            options ?? new LiveIncidentSamplerOptions(),
            timeProvider,
            onSnapshot: _ => PublishCurrentResponse(),
            onStatusChanged: _ => PublishCurrentResponse(),
            logger: samplerLogger);
    }

    public LiveIncidentResponseV1 GetCurrentResponse()
    {
        var status = _sampler.GetStatus();
        var snapshot = _sampler.LatestSnapshot;
        if (snapshot is not null)
        {
            snapshot = snapshot with
            {
                Diagnostics = snapshot.Diagnostics with
                {
                    MissedCycles = status.MissedCycles,
                    SkippedCycles = status.SkippedCycles,
                },
            };
        }

        return new(snapshot, status);
    }

    public Task StartAsync(CancellationToken cancellationToken) => _sampler.StartAsync(cancellationToken);

    /// <summary>
    /// Honors the host's shutdown time bound (requirement 17): races the sampler's own graceful
    /// stop against <paramref name="cancellationToken"/> so a slow or stuck collection cycle can
    /// never make host shutdown hang past the time budget ASP.NET Core grants every
    /// <see cref="IHostedService"/>.
    /// </summary>
    public Task StopAsync(CancellationToken cancellationToken) => _sampler.StopAsync().WaitAsync(cancellationToken);

    public async ValueTask DisposeAsync()
    {
        // Both the sampler and DI container can legitimately call DisposeAsync on this instance
        // more than once (this type is registered both as a concrete singleton and as the
        // IHostedService); guard so the publisher is completed/awaited exactly once.
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        await _sampler.DisposeAsync().ConfigureAwait(false);
        await _publisher.DisposeAsync().ConfigureAwait(false);
    }

    private void PublishCurrentResponse() => _publisher.TryPublish(GetCurrentResponse());

    private Task BroadcastAsync(LiveIncidentResponseV1 response, CancellationToken cancellationToken) =>
        _hubContext.Clients.All.SendAsync(LiveIncidentUpdatedMethod, response, cancellationToken);
}
