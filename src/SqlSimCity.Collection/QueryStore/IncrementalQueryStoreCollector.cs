using System.Collections.Concurrent;
using System.Numerics;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.QueryStore;

public enum QueryStoreCollectionState { ReadWrite, ReadOnly, Off, Error, PermissionDenied, Unsupported }
public enum QueryStoreFactKind { Identity, Plan, Runtime, Wait, Variant, Replica }

public sealed record QueryStoreDatabaseState(
    string DatabaseId,
    QueryStoreCollectionState State,
    string ResetEpoch,
    DateTimeOffset? OldestIntervalStart,
    DateTimeOffset ObservedAt,
    string Reason,
    int EngineMajorVersion,
    int CompatibilityLevel,
    bool SupportsWaits,
    bool SupportsPlanVariants,
    bool SupportsReplicas,
    bool SupportsOppo,
    long? LatestIntervalId = null);

public sealed record QueryStoreWatermark(
    string DatabaseId,
    string ResetEpoch,
    DateTimeOffset Through,
    IReadOnlyDictionary<QueryStoreFactKind, string?> PageTokens,
    long? LatestIntervalId = null);

public abstract record QueryStoreCollectedFact;

public sealed record QueryIdentityFact(
    string QueryId,
    string QueryTextId,
    string ContextSettingsId,
    string QueryHash,
    DateTimeOffset LastExecutionAt,
    bool IsEncrypted,
    bool IsRestricted,
    string? SetOptions,
    string? Language,
    string? DateFormat,
    string? DateFirst) : QueryStoreCollectedFact;

public sealed record QueryPlanFact(
    string PlanId,
    string QueryId,
    string QueryPlanHash,
    QueryPlanType PlanType,
    string? PlanGroupId,
    bool IsForced,
    string? ForcingType,
    BigInteger ForceFailureCount,
    string? LastForceFailureReason,
    string EngineVersion,
    string CompatibilityLevel,
    DateTimeOffset LastExecutionAt) : QueryStoreCollectedFact;

public sealed record QueryRuntimeFact(RuntimeStatInput Value) : QueryStoreCollectedFact;

public sealed record QueryWaitFact(
    string PlanId,
    string IntervalId,
    QueryStoreExecutionType ExecutionType,
    string ReplicaGroupId,
    byte WaitCategoryId,
    string WaitCategory,
    BigInteger TotalWaitMilliseconds) : QueryStoreCollectedFact;

public sealed record QueryVariantFact(
    string VariantQueryId,
    string ParentQueryId,
    string DispatcherPlanId,
    QueryOptimizationKind Optimization) : QueryStoreCollectedFact;

public sealed record QueryReplicaFact(string ReplicaGroupId, string ReplicaName) : QueryStoreCollectedFact;

public sealed record QueryStoreFactPage(
    QueryStoreFactKind Kind,
    IReadOnlyList<QueryStoreCollectedFact> Facts,
    string? NextPageToken,
    bool ContainsActiveInterval);

public interface IQueryStoreIncrementalSource
{
    Task<IReadOnlyList<string>> DiscoverDatabasesAsync(CancellationToken cancellationToken);
    Task<QueryStoreDatabaseState> GetStateAsync(string databaseId, CancellationToken cancellationToken);
    Task<QueryStoreFactPage> ReadPageAsync(
        string databaseId,
        QueryStoreFactKind kind,
        DateTimeOffset startInclusive,
        DateTimeOffset endExclusive,
        string? pageToken,
        int pageSize,
        CancellationToken cancellationToken);
    Task<QueryTextPayload> ReadQueryTextAsync(
        string databaseId, string queryTextId, CancellationToken cancellationToken);
    Task<string?> ReadPlanXmlAsync(
        string databaseId, string planId, CancellationToken cancellationToken);
}

public sealed record QueryTextPayload(string? Text, bool IsEncrypted, bool IsRestricted);

public interface IQueryStoreHistorySink
{
    Task<QueryStoreWatermark?> GetWatermarkAsync(string databaseId, CancellationToken cancellationToken);
    Task BeginDatabaseCycleAsync(
        QueryStoreDatabaseState state, bool resetDetected, CancellationToken cancellationToken);
    Task StageFactsAsync(
        string databaseId, QueryStoreFactPage page, CancellationToken cancellationToken);
    Task StageRuntimeBucketsAsync(
        string databaseId,
        IReadOnlyList<AggregatedRuntimeBucket> buckets,
        bool activeInterval,
        CancellationToken cancellationToken);
    Task CommitDatabaseCycleAsync(
        QueryStoreDatabaseState state,
        QueryStoreWatermark watermark,
        CancellationToken cancellationToken);
    Task AbortDatabaseCycleAsync(string databaseId, CancellationToken cancellationToken);
    Task PublishAsync(QueryStoreCollectionResult result, CancellationToken cancellationToken);
}

public sealed record QueryStoreCollectionOptions(
    int PageSize = 1_000,
    int DatabaseConcurrency = 4,
    TimeSpan? Overlap = null)
{
    public TimeSpan EffectiveOverlap => Overlap ?? TimeSpan.FromMinutes(65);

    public void Validate()
    {
        if (PageSize is < 1 or > 10_000) throw new ArgumentOutOfRangeException(nameof(PageSize));
        if (DatabaseConcurrency is < 1 or > 16) throw new ArgumentOutOfRangeException(nameof(DatabaseConcurrency));
        if (EffectiveOverlap < TimeSpan.Zero || EffectiveOverlap > TimeSpan.FromHours(24))
            throw new ArgumentOutOfRangeException(nameof(Overlap));
    }
}

public sealed record QueryStoreDatabaseCollectionResult(
    string DatabaseId,
    QueryStoreCollectionState State,
    int PageCount,
    int BucketCount,
    bool ResetDetected,
    string Reason,
    string? FailureType);

public sealed record QueryStoreCollectionResult(
    bool SkippedBecauseCycleActive,
    DateTimeOffset StartedAt,
    DateTimeOffset CompletedAt,
    IReadOnlyList<QueryStoreDatabaseCollectionResult> Databases);

public sealed class IncrementalQueryStoreCollector : IDisposable
{
    private readonly IQueryStoreIncrementalSource _source;
    private readonly IQueryStoreHistorySink _sink;
    private readonly QueryStoreCollectionOptions _options;
    private readonly TimeProvider _timeProvider;
    private readonly SemaphoreSlim _cycleGate = new(1, 1);

    public IncrementalQueryStoreCollector(
        IQueryStoreIncrementalSource source,
        IQueryStoreHistorySink sink,
        QueryStoreCollectionOptions options,
        TimeProvider? timeProvider = null)
    {
        _source = source ?? throw new ArgumentNullException(nameof(source));
        _sink = sink ?? throw new ArgumentNullException(nameof(sink));
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _timeProvider = timeProvider ?? TimeProvider.System;
        _options.Validate();
    }

    public void Dispose() => _cycleGate.Dispose();

    public async Task<QueryStoreCollectionResult> CollectAsync(
        IEnumerable<string>? databaseIds,
        DateTimeOffset throughExclusive,
        CancellationToken cancellationToken = default)
    {
        if (!await _cycleGate.WaitAsync(0, cancellationToken).ConfigureAwait(false))
            return new QueryStoreCollectionResult(true, _timeProvider.GetUtcNow(), _timeProvider.GetUtcNow(), []);

        var startedAt = _timeProvider.GetUtcNow();
        try
        {
            var databases = databaseIds?.Distinct(StringComparer.Ordinal).ToArray();
            if (databases is null || databases.Length == 0)
                databases = [.. await _source.DiscoverDatabasesAsync(cancellationToken).ConfigureAwait(false)];
            var results = new ConcurrentBag<QueryStoreDatabaseCollectionResult>();
            await Parallel.ForEachAsync(
                databases,
                new ParallelOptions
                {
                    MaxDegreeOfParallelism = _options.DatabaseConcurrency,
                    CancellationToken = cancellationToken,
                },
                async (databaseId, token) =>
                {
                    results.Add(await CollectDatabaseGuardedAsync(databaseId, throughExclusive, token)
                        .ConfigureAwait(false));
                }).ConfigureAwait(false);
            var result = new QueryStoreCollectionResult(
                false, startedAt, _timeProvider.GetUtcNow(),
                results.OrderBy(item => item.DatabaseId, StringComparer.Ordinal).ToArray());
            await _sink.PublishAsync(result, cancellationToken).ConfigureAwait(false);
            return result;
        }
        finally
        {
            _cycleGate.Release();
        }
    }

    private async Task<QueryStoreDatabaseCollectionResult> CollectDatabaseGuardedAsync(
        string databaseId,
        DateTimeOffset throughExclusive,
        CancellationToken cancellationToken)
    {
        try
        {
            return await CollectDatabaseAsync(databaseId, throughExclusive, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            await _sink.AbortDatabaseCycleAsync(databaseId, CancellationToken.None).ConfigureAwait(false);
            throw;
        }
        catch (Exception ex)
        {
            await _sink.AbortDatabaseCycleAsync(databaseId, cancellationToken).ConfigureAwait(false);
            return new QueryStoreDatabaseCollectionResult(
                databaseId, QueryStoreCollectionState.Error, 0, 0, false,
                "Collection failed for this database; its prior published history remains current.",
                ex.GetType().Name);
        }
    }

    private async Task<QueryStoreDatabaseCollectionResult> CollectDatabaseAsync(
        string databaseId,
        DateTimeOffset throughExclusive,
        CancellationToken cancellationToken)
    {
        var state = await _source.GetStateAsync(databaseId, cancellationToken).ConfigureAwait(false);
        if (state.State is QueryStoreCollectionState.Off or QueryStoreCollectionState.Error or
            QueryStoreCollectionState.PermissionDenied or QueryStoreCollectionState.Unsupported)
            return new QueryStoreDatabaseCollectionResult(
                databaseId, state.State, 0, 0, false, state.Reason, null);

        var watermark = await _sink.GetWatermarkAsync(databaseId, cancellationToken).ConfigureAwait(false);
        var retentionGap = watermark is not null && state.OldestIntervalStart is not null &&
                           watermark.Through < state.OldestIntervalStart;
        var reset = watermark is not null &&
                    (!string.Equals(watermark.ResetEpoch, state.ResetEpoch, StringComparison.Ordinal) ||
                     retentionGap ||
                     state.LatestIntervalId is { } latest &&
                     watermark.LatestIntervalId is { } priorLatest &&
                     latest < priorLatest);
        await _sink.BeginDatabaseCycleAsync(state, reset, cancellationToken).ConfigureAwait(false);
        var start = watermark is null || reset
            ? state.OldestIntervalStart ?? throughExclusive - _options.EffectiveOverlap
            : watermark.Through - _options.EffectiveOverlap;

        var pageCount = 0;
        var bucketCount = 0;
        var kinds = KindsFor(state);
        foreach (var kind in kinds)
        {
            string? token = null;
            do
            {
                var page = await _source.ReadPageAsync(
                    databaseId, kind, start, throughExclusive, token,
                    _options.PageSize, cancellationToken).ConfigureAwait(false);
                await _sink.StageFactsAsync(databaseId, page, cancellationToken).ConfigureAwait(false);
                if (kind == QueryStoreFactKind.Runtime)
                {
                    var rows = page.Facts.Cast<QueryRuntimeFact>().Select(fact => fact.Value);
                    var buckets = QueryStoreRuntimeAggregator.Aggregate(rows);
                    var active = buckets.Where(bucket => bucket.Key.IntervalEnd >= throughExclusive).ToArray();
                    var closed = buckets.Where(bucket => bucket.Key.IntervalEnd < throughExclusive).ToArray();
                    if (closed.Length > 0)
                        await _sink.StageRuntimeBucketsAsync(
                            databaseId, closed, false, cancellationToken).ConfigureAwait(false);
                    if (active.Length > 0)
                        await _sink.StageRuntimeBucketsAsync(
                            databaseId, active, true, cancellationToken).ConfigureAwait(false);
                    bucketCount += buckets.Count;
                }
                pageCount++;
                token = page.NextPageToken;
            }
            while (token is not null);
        }

        var newWatermark = new QueryStoreWatermark(
            databaseId, state.ResetEpoch, throughExclusive,
            kinds.ToDictionary(kind => kind, _ => (string?)null),
            state.LatestIntervalId ?? watermark?.LatestIntervalId);
        await _sink.CommitDatabaseCycleAsync(state, newWatermark, cancellationToken).ConfigureAwait(false);
        return new QueryStoreDatabaseCollectionResult(
            databaseId, state.State, pageCount, bucketCount, reset, state.Reason, null);
    }

    private static QueryStoreFactKind[] KindsFor(QueryStoreDatabaseState state)
    {
        var kinds = new List<QueryStoreFactKind>
        {
            QueryStoreFactKind.Identity, QueryStoreFactKind.Plan, QueryStoreFactKind.Runtime,
        };
        if (state.SupportsWaits) kinds.Add(QueryStoreFactKind.Wait);
        if (state.SupportsPlanVariants) kinds.Add(QueryStoreFactKind.Variant);
        if (state.SupportsReplicas) kinds.Add(QueryStoreFactKind.Replica);
        return [.. kinds];
    }
}
