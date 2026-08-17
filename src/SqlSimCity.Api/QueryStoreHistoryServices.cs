using Microsoft.AspNetCore.SignalR;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.Storage;

namespace SqlSimCity.Api;

public sealed record QueryStoreHistoryHostOptions(
    IReadOnlyList<string> KnownDatabases,
    TimeSpan RefreshInterval,
    TimeSpan MaximumBackoff);

public static class QueryStoreHistoryConfiguration
{
    public static bool IsConnected(IConfiguration configuration) =>
        configuration.GetValue<string>("QueryStoreHistory:Mode")
            ?.Equals("Connected", StringComparison.OrdinalIgnoreCase) == true;

    public static bool IsDisabled(IConfiguration configuration) =>
        configuration.GetValue<string>("QueryStoreHistory:Mode")
            ?.Equals("Disabled", StringComparison.OrdinalIgnoreCase) == true;

    public static QueryStoreCollectionOptions BuildCollectionOptions(IConfiguration configuration)
    {
        var section = configuration.GetSection("QueryStoreHistory");
        return new QueryStoreCollectionOptions(
            section.GetValue<int?>("PageSize") ?? 1_000,
            section.GetValue<int?>("DatabaseConcurrency") ?? 4,
            TimeSpan.FromMinutes(section.GetValue<int?>("OverlapMinutes") ?? 65));
    }

    public static QueryStoreHistoryHostOptions BuildHostOptions(IConfiguration configuration)
    {
        var section = configuration.GetSection("QueryStoreHistory");
        return new QueryStoreHistoryHostOptions(
            configuration.GetSection("Atlas:KnownDatabases").Get<string[]>() ?? [],
            TimeSpan.FromSeconds(section.GetValue<int?>("RefreshIntervalSeconds") ?? 120),
            TimeSpan.FromMinutes(section.GetValue<int?>("MaximumBackoffMinutes") ?? 15));
    }
}

public sealed class QueryStoreHistoryBackgroundService(
    IncrementalQueryStoreCollector collector,
    QueryStoreHistoryHostOptions options,
    IHubContext<CurrentSnapshotHub> hub,
    QueryStoreCollectionStatusTracker statusTracker,
    ProtectedQueryStoreRepository repository,
    IProtectedRecordStore protectedStore,
    TimeProvider timeProvider,
    ILogger<QueryStoreHistoryBackgroundService> logger) : BackgroundService
{
    private static readonly Action<ILogger, string, Exception?> LogFailure =
        LoggerMessage.Define<string>(
            LogLevel.Error, new EventId(20, "QueryStoreHistoryCycleFailure"),
            "Query Store history cycle failed ({ExceptionType}); prior published history remains current.");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (statusTracker.Current is null &&
            await repository.ReadPublishedSnapshotAsync(stoppingToken).ConfigureAwait(false) is { } persisted)
            statusTracker.Set(persisted.Status);
        var failures = 0;
        while (!stoppingToken.IsCancellationRequested)
        {
            var before = statusTracker.Current;
            statusTracker.Set(new QueryStoreCollectorStatusV1(
                "1.0", QueryStoreCollectorState.Collecting, before?.Sequence ?? 0,
                timeProvider.GetUtcNow(), before?.LastPublishedAt, null,
                before?.Databases ?? [], "Connected Query Store history collection is running."));
            try
            {
                var result = await collector.CollectAsync(
                    options.KnownDatabases, timeProvider.GetUtcNow(), stoppingToken).ConfigureAwait(false);
                failures = result.Databases.Any(database => database.FailureType is not null)
                    ? Math.Min(failures + 1, 10) : 0;
                if (!result.SkippedBecauseCycleActive)
                {
                    await hub.Clients.All.SendAsync(
                        "queryStoreSnapshotAvailable",
                        new { result.CompletedAt, DatabaseCount = result.Databases.Count },
                        stoppingToken).ConfigureAwait(false);
                    await protectedStore.PruneExpiredAsync(stoppingToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                failures = Math.Min(failures + 1, 10);
                LogFailure(logger, ex.GetType().Name, null);
            }

            var multiplier = Math.Pow(2, failures);
            var delay = TimeSpan.FromMilliseconds(Math.Min(
                options.RefreshInterval.TotalMilliseconds * multiplier,
                options.MaximumBackoff.TotalMilliseconds));
            if (failures > 0)
            {
                var current = statusTracker.Current;
                statusTracker.Set(new QueryStoreCollectorStatusV1(
                    "1.0", QueryStoreCollectorState.BackingOff, current?.Sequence ?? 0,
                    current?.LastStartedAt, current?.LastPublishedAt,
                    timeProvider.GetUtcNow().Add(delay), current?.Databases ?? [],
                    "One or more connected Query Store collections failed; prior published history remains current."));
            }
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
}
