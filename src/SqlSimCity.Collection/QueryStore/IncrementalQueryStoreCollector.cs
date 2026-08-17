using System.Collections.Concurrent;

namespace SqlSimCity.Collection.QueryStore;

public enum QueryStoreCollectionState { ReadWrite, ReadOnly, Off, Error, PermissionDenied, Unsupported }

public sealed record QueryStoreDatabaseState(
    string DatabaseId,
    QueryStoreCollectionState State,
    string ResetEpoch,
    DateTimeOffset? OldestIntervalStart,
    DateTimeOffset ObservedAt,
    string Reason);

public sealed record QueryStoreWatermark(
    string DatabaseId,
    string ResetEpoch,
    DateTimeOffset Through,
    string? PageToken);

public sealed record QueryStorePage(
    IReadOnlyList<RuntimeStatInput> RuntimeRows,
    string? NextPageToken,
    bool IsActiveInterval);

public interface IQueryStoreIncrementalSource
{
    Task<QueryStoreDatabaseState> GetStateAsync(string databaseId, CancellationToken cancellationToken);
    Task<QueryStorePage> ReadRuntimePageAsync(
        string databaseId,
        DateTimeOffset startInclusive,
        DateTimeOffset endExclusive,
        string? pageToken,
        int pageSize,
        CancellationToken cancellationToken);
}

public interface IQueryStoreHistorySink
{
    Task<QueryStoreWatermark?> GetWatermarkAsync(string databaseId, CancellationToken cancellationToken);
    Task BeginResetEpochAsync(string databaseId, string resetEpoch, CancellationToken cancellationToken);
    Task ReplaceRuntimeBucketsAsync(
        string databaseId,
        IReadOnlyList<AggregatedRuntimeBucket> buckets,
        bool activeInterval,
        CancellationToken cancellationToken);
    Task PutWatermarkAsync(QueryStoreWatermark watermark, CancellationToken cancellationToken);
}

public sealed record QueryStoreCollectionOptions(
    int PageSize = 1_000,
    int DatabaseConcurrency = 4,
    TimeSpan? Overlap = null)
{
    public TimeSpan EffectiveOverlap => Overlap ?? TimeSpan.FromMinutes(5);

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
    Exception? Failure);

public sealed record QueryStoreCollectionResult(
    bool SkippedBecauseCycleActive,
    IReadOnlyList<QueryStoreDatabaseCollectionResult> Databases);

public sealed class IncrementalQueryStoreCollector : IDisposable
{
    private readonly IQueryStoreIncrementalSource _source;
    private readonly IQueryStoreHistorySink _sink;
    private readonly QueryStoreCollectionOptions _options;
    private readonly SemaphoreSlim _cycleGate = new(1, 1);

    public IncrementalQueryStoreCollector(
        IQueryStoreIncrementalSource source,
        IQueryStoreHistorySink sink,
        QueryStoreCollectionOptions options)
    {
        _source = source ?? throw new ArgumentNullException(nameof(source));
        _sink = sink ?? throw new ArgumentNullException(nameof(sink));
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _options.Validate();
    }

    public void Dispose() => _cycleGate.Dispose();

    public async Task<QueryStoreCollectionResult> CollectAsync(
        IEnumerable<string> databaseIds,
        DateTimeOffset throughExclusive,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(databaseIds);
        if (!await _cycleGate.WaitAsync(0, cancellationToken))
            return new QueryStoreCollectionResult(true, []);

        try
        {
            var results = new ConcurrentBag<QueryStoreDatabaseCollectionResult>();
            await Parallel.ForEachAsync(
                databaseIds.Distinct(StringComparer.Ordinal),
                new ParallelOptions
                {
                    MaxDegreeOfParallelism = _options.DatabaseConcurrency,
                    CancellationToken = cancellationToken,
                },
                async (databaseId, token) =>
                {
                    try
                    {
                        results.Add(await CollectDatabaseAsync(databaseId, throughExclusive, token));
                    }
                    catch (OperationCanceledException) when (token.IsCancellationRequested)
                    {
                        throw;
                    }
                    catch (Exception ex)
                    {
                        results.Add(new QueryStoreDatabaseCollectionResult(
                            databaseId, QueryStoreCollectionState.Error, 0, 0, false,
                            "Collection failed for this database; other database results remain valid.", ex));
                    }
                });
            return new QueryStoreCollectionResult(false, results.OrderBy(x => x.DatabaseId, StringComparer.Ordinal).ToArray());
        }
        finally
        {
            _cycleGate.Release();
        }
    }

    private async Task<QueryStoreDatabaseCollectionResult> CollectDatabaseAsync(
        string databaseId,
        DateTimeOffset throughExclusive,
        CancellationToken cancellationToken)
    {
        var state = await _source.GetStateAsync(databaseId, cancellationToken);
        if (state.State is QueryStoreCollectionState.Off or QueryStoreCollectionState.Error or
            QueryStoreCollectionState.PermissionDenied or QueryStoreCollectionState.Unsupported)
        {
            return new QueryStoreDatabaseCollectionResult(
                databaseId, state.State, 0, 0, false, state.Reason, null);
        }

        var watermark = await _sink.GetWatermarkAsync(databaseId, cancellationToken);
        var retentionGap = watermark is not null && state.OldestIntervalStart is not null &&
                           watermark.Through < state.OldestIntervalStart;
        var reset = watermark is not null &&
                    (!string.Equals(watermark.ResetEpoch, state.ResetEpoch, StringComparison.Ordinal) || retentionGap);
        if (reset)
        {
            await _sink.BeginResetEpochAsync(databaseId, state.ResetEpoch, cancellationToken);
            watermark = null;
        }

        var start = watermark is null
            ? state.OldestIntervalStart ?? throughExclusive - _options.EffectiveOverlap
            : watermark.Through - _options.EffectiveOverlap;
        string? pageToken = null;
        var pages = 0;
        var bucketCount = 0;
        do
        {
            var page = await _source.ReadRuntimePageAsync(
                databaseId, start, throughExclusive, pageToken, _options.PageSize, cancellationToken);
            var buckets = QueryStoreRuntimeAggregator.Aggregate(page.RuntimeRows);
            await _sink.ReplaceRuntimeBucketsAsync(databaseId, buckets, page.IsActiveInterval, cancellationToken);
            bucketCount += buckets.Count;
            pages++;
            pageToken = page.NextPageToken;
        }
        while (pageToken is not null);

        await _sink.PutWatermarkAsync(
            new QueryStoreWatermark(databaseId, state.ResetEpoch, throughExclusive, null), cancellationToken);
        return new QueryStoreDatabaseCollectionResult(
            databaseId, state.State, pages, bucketCount, reset,
            state.State == QueryStoreCollectionState.ReadOnly
                ? "Query Store is readable but capture is read-only; no missing interval is represented as zero."
                : state.Reason,
            null);
    }
}
