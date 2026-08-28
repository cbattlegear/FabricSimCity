using Microsoft.AspNetCore.SignalR;
using SqlSimCity.Collection.DatabaseCity;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.Storage;

namespace SqlSimCity.Api;

public sealed record QueryStoreHistoryHostOptions(
    IReadOnlyList<string> KnownDatabases,
    TimeSpan RefreshInterval,
    TimeSpan MaximumBackoff);

/// <summary>
/// Settings for the city view itself, as distinct from how much history is collected behind it.
/// </summary>
public static class DatabaseCityConfiguration
{
    /// <summary>
    /// How far back street colour is graded from. Deliberately separate from retention: retention
    /// decides which streets exist at all, and this decides what colour they are. An operator
    /// watching a quiet instance widens this to see anything; one watching a busy instance narrows
    /// it so a spike stops colouring the map long after it ended.
    /// </summary>
    public static TimeSpan BuildTrafficWindow(IConfiguration configuration)
    {
        var minutes = configuration.GetSection("DatabaseCity").GetValue<int?>("TrafficWindowMinutes");
        if (minutes is null) return QueryStoreCityAttribution.DefaultTrafficWindow;
        var window = TimeSpan.FromMinutes(minutes.Value);
        if (window < QueryStoreCityAttribution.MinimumTrafficWindow ||
            window > QueryStoreCityAttribution.MaximumTrafficWindow)
        {
            // Named for the setting rather than a parameter, because the setting is what an
            // operator has to go and change.
            throw new InvalidOperationException(
                $"DatabaseCity:TrafficWindowMinutes is {minutes.Value}; it must be between " +
                $"{QueryStoreCityAttribution.MinimumTrafficWindow.TotalMinutes:0} and " +
                $"{QueryStoreCityAttribution.MaximumTrafficWindow.TotalMinutes:0} minutes.");
        }

        return window;
    }
}

public static class QueryStoreHistoryConfiguration
{
    /// <summary>
    /// Connected Query Store history runs when it is asked for explicitly, or
    /// when a connection string is supplying the connected profile.
    ///
    /// The second case exists because a connection string already turns on
    /// connected Atlas and live incidents. Leaving Query Store history behind
    /// made connecting a real server actively worse than fixture mode -- the
    /// query views fell back to <c>UnavailableQueryStoreHistorySource</c> and
    /// returned nothing, silently, which is the opposite of why anyone connects
    /// a database to this tool. <c>Mode=Disabled</c> remains an explicit opt-out
    /// and always wins.
    /// </summary>
    public static bool IsConnected(IConfiguration configuration) =>
        !IsDisabled(configuration)
        && (IsExplicitlyConnected(configuration)
            || AtlasConfiguration.ResolveConnectionString(configuration) is not null);

    private static bool IsExplicitlyConnected(IConfiguration configuration) =>
        configuration.GetValue<string>("QueryStoreHistory:Mode")
            ?.Equals("Connected", StringComparison.OrdinalIgnoreCase) == true;

    public static bool IsDisabled(IConfiguration configuration) =>
        configuration.GetValue<string>("QueryStoreHistory:Mode")
            ?.Equals("Disabled", StringComparison.OrdinalIgnoreCase) == true;

    /// <summary>
    /// Settings whose unit changed when the collector stopped archiving and started following
    /// current traffic. Honouring them would be wrong -- <c>BackfillHorizonDays: 3</c> and
    /// <c>BackfillHorizonHours: 3</c> differ by a factor of 24 -- and ignoring them would drop a
    /// setting the operator is still relying on, silently. So each one is refused by name.
    /// </summary>
    private static readonly (string Retired, string Replacement)[] RetiredSettings =
    [
        ("RetentionDays", "RetentionHours"),
        ("DetailRetentionDays", "DetailRetentionHours"),
        ("InitialLookbackDays", "InitialLookbackMinutes"),
        ("BackfillIncrementHours", "BackfillIncrementMinutes"),
        ("BackfillHorizonDays", "BackfillHorizonHours"),
    ];

    /// <summary>
    /// Refuses a configuration that still carries a retired key. A unit change is the one kind of
    /// rename that cannot fail loudly on its own: the old name simply stops being read, and the
    /// deployment keeps running against a horizon nobody chose.
    /// </summary>
    private static void RequireRetiredSettingsAbsent(IConfigurationSection section)
    {
        foreach (var (retired, replacement) in RetiredSettings)
        {
            if (section.GetSection(retired).Value is null) continue;
            throw new InvalidOperationException(
                $"QueryStoreHistory:{retired} is no longer read; use QueryStoreHistory:{replacement} " +
                "instead. The unit changed, so the old value cannot be carried across: retention and " +
                "backfill now describe a live traffic picture in hours and minutes rather than an " +
                "archive in days.");
        }
    }

    /// <summary>
    /// How much history this deployment keeps. Both the sink's prune and the collector's lookback
    /// caps read this one value, so lowering it lowers what is read and what is stored together.
    /// </summary>
    public static QueryStoreRetentionOptions BuildRetentionOptions(IConfiguration configuration)
    {
        var section = configuration.GetSection("QueryStoreHistory");
        RequireRetiredSettingsAbsent(section);
        var options = new QueryStoreRetentionOptions(
            section.GetValue<int?>("RetentionHours") is { } hours
                ? TimeSpan.FromHours(hours)
                : null,
            section.GetValue<int?>("DetailRetentionHours") is { } detailHours
                ? TimeSpan.FromHours(detailHours)
                : null);
        options.Validate();
        return options;
    }

    public static QueryStoreCollectionOptions BuildCollectionOptions(IConfiguration configuration)
    {
        var section = configuration.GetSection("QueryStoreHistory");
        RequireRetiredSettingsAbsent(section);
        var retention = BuildRetentionOptions(configuration);
        var options = new QueryStoreCollectionOptions(
            section.GetValue<int?>("PageSize") ?? 1_000,
            section.GetValue<int?>("DatabaseConcurrency") ?? 4,
            TimeSpan.FromMinutes(section.GetValue<int?>("OverlapMinutes") ?? 65),
            // Absent means "one backfill increment, floored at the overlap". Pinning a number here
            // instead would make lowering RetentionHours fail validation against a default the
            // operator never set.
            section.GetValue<int?>("InitialLookbackMinutes") is { } lookbackMinutes
                ? TimeSpan.FromMinutes(lookbackMinutes)
                : null,
            // Absent means the default increment: the progressive backfill is on unless an operator
            // widens or narrows the step, because reaching a whole horizon in one cold-start cycle
            // is what leaves a fresh deployment with nothing published.
            section.GetValue<int?>("BackfillIncrementMinutes") is { } incrementMinutes
                ? TimeSpan.FromMinutes(incrementMinutes)
                : null,
            section.GetValue<int?>("BackfillHorizonHours") is { } horizonHours
                ? TimeSpan.FromHours(horizonHours)
                : null,
            retention);
        options.Validate();
        return options;
    }

    public static QueryStorePlanCacheOptions BuildPlanCacheOptions(IConfiguration configuration)
    {
        var options = new QueryStorePlanCacheOptions(
            configuration.GetSection("QueryStoreHistory").GetValue<long?>("PlanCacheQuotaBytes")
            ?? QueryStorePlanCacheOptions.DefaultQuotaBytes);
        options.Validate();
        return options;
    }

    public static QueryStoreHistoryHostOptions BuildHostOptions(IConfiguration configuration)
    {
        var section = configuration.GetSection("QueryStoreHistory");
        var options = new QueryStoreHistoryHostOptions(
            configuration.GetSection("Atlas:KnownDatabases").Get<string[]>() ?? [],
            TimeSpan.FromSeconds(section.GetValue<int?>("RefreshIntervalSeconds") ?? 120),
            TimeSpan.FromMinutes(section.GetValue<int?>("MaximumBackoffMinutes") ?? 15));
        if (options.KnownDatabases.Any(string.IsNullOrWhiteSpace) ||
            options.KnownDatabases.Distinct(StringComparer.Ordinal).Count() != options.KnownDatabases.Count)
            throw new InvalidOperationException("Atlas:KnownDatabases must contain unique, non-empty names.");
        if (options.RefreshInterval < TimeSpan.FromSeconds(5) ||
            options.RefreshInterval > TimeSpan.FromHours(1))
            throw new InvalidOperationException("Query Store refresh interval must be between 5 seconds and 1 hour.");
        if (options.MaximumBackoff < options.RefreshInterval || options.MaximumBackoff > TimeSpan.FromHours(24))
            throw new InvalidOperationException("Query Store maximum backoff must be at least the refresh interval and at most 24 hours.");
        return options;
    }
}

public sealed class QueryStoreHistoryBackgroundService(
    IncrementalQueryStoreCollector collector,
    QueryStoreHistoryHostOptions options,
    IHubContext<CurrentSnapshotHub> hub,
    QueryStoreCollectionStatusTracker statusTracker,
    ProtectedQueryStoreRepository repository,
    IProtectedRecordStore protectedStore,
    QueryStoreStorageTelemetry storageTelemetry,
    TimeProvider timeProvider,
    ILogger<QueryStoreHistoryBackgroundService> logger) : BackgroundService
{
    private static readonly Action<ILogger, string, Exception?> LogFailure =
        LoggerMessage.Define<string>(
            LogLevel.Error, new EventId(20, "QueryStoreHistoryCycleFailure"),
            "Query Store history cycle failed ({ExceptionType}); prior published history remains current.");
    private static readonly Action<ILogger, Exception?> LogNotificationFailure =
        LoggerMessage.Define(
            LogLevel.Warning, new EventId(21, "QueryStoreHistoryNotificationFailure"),
            "Query Store history published, but the bounded client notification failed.");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (statusTracker.Current is null &&
            await repository.ReadPublishedSnapshotHeaderAsync(stoppingToken).ConfigureAwait(false) is { } persisted)
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
                    try
                    {
                        await NotifyAsync(
                            hub,
                            "queryStoreSnapshotAvailable",
                            new { result.CompletedAt, DatabaseCount = result.Databases.Count },
                            TimeSpan.FromSeconds(5),
                            stoppingToken).ConfigureAwait(false);
                    }
                    catch (Exception) when (!stoppingToken.IsCancellationRequested)
                    {
                        LogNotificationFailure(logger, null);
                    }
                    var pruned = await protectedStore.PruneExpiredAsync(stoppingToken).ConfigureAwait(false);
                    await storageTelemetry.ReportAsync(pruned, stoppingToken).ConfigureAwait(false);
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

    internal static async Task NotifyAsync(
        IHubContext<CurrentSnapshotHub> hubContext,
        string method,
        object payload,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        using var notificationCancellation =
            CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        notificationCancellation.CancelAfter(timeout);
        await hubContext.Clients.All.SendAsync(
            method, payload, notificationCancellation.Token).ConfigureAwait(false);
    }
}
