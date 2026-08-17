using System.Diagnostics;
using System.Globalization;
using System.Numerics;
using SqlSimCity.Collection.Negotiation;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Atlas;

public sealed class AtlasCollector
{
    private readonly IAtlasProbeExecutor _executor;
    private readonly ILiveAtlasActivitySource _activity;
    private readonly AtlasCollectionOptions _options;
    private readonly TimeProvider _timeProvider;
    private readonly object _ioGate = new();
    private Dictionary<string, PreviousIoSample> _previousIo = [];

    public AtlasCollector(
        IAtlasProbeExecutor executor,
        ILiveAtlasActivitySource activity,
        AtlasCollectionOptions options,
        TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(executor);
        ArgumentNullException.ThrowIfNull(activity);
        ArgumentNullException.ThrowIfNull(options);
        options.Validate();
        _executor = executor;
        _activity = activity;
        _options = options;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public async Task<AtlasCollectionResult> CollectAsync(long sequence, CancellationToken cancellationToken)
    {
        var started = _timeProvider.GetTimestamp();
        var collectedAt = _timeProvider.GetUtcNow();
        AtlasTargetIdentity target;
        IReadOnlyList<AtlasDatabaseIdentity> databases;
        try
        {
            target = await _executor.GetTargetIdentityAsync(cancellationToken).ConfigureAwait(false);
            databases = await SelectDatabasesAsync(target, cancellationToken).ConfigureAwait(false);
            if (databases.Count == 0)
                return Failed(sequence, collectedAt, started,
                    "Database discovery returned no visible databases; collection did not report empty success.");
        }
        catch (ProbeExecutionException ex)
        {
            return Failed(sequence, collectedAt, started, ex.Reason);
        }

        var selection = SelectProbes(target);
        using var concurrency = new SemaphoreSlim(_options.DatabaseConcurrency);
        var tasks = databases.Select((database, index) =>
            CollectOneBoundedAsync(database, index, target, selection, collectedAt, concurrency, cancellationToken)).ToArray();
        var results = await Task.WhenAll(tasks).ConfigureAwait(false);
        Array.Sort(results, static (left, right) => left.Index.CompareTo(right.Index));

        var items = results.Select(result => result.Item).ToArray();
        var failures = results.Count(result => result.Failed);
        var skips = results.Count(result => result.Skipped);
        var duration = (long)_timeProvider.GetElapsedTime(started).TotalMilliseconds;
        var state = failures > 0 ? AtlasCollectorState.Degraded : AtlasCollectorState.Ready;
        var reason = failures > 0
            ? $"{failures} database collection(s) failed; successful databases remain available."
            : "Connected atlas collection completed.";
        var staleAfter = collectedAt + _options.StaleAfter;
        var rowCount = results.Sum(result => (long)result.RowCount) + 1L +
                       (target.Platform == EnginePlatform.AzureSqlDatabase ? 0L : databases.Count);
        var metadata = new AtlasCollectionMetadataV1(
            AtlasCollectorMode.Connected, state, sequence, collectedAt, target.SourceTimestamp,
            staleAfter, false, items.Length, failures, skips, duration, reason)
        {
            RowCount = rowCount,
        };
        var snapshot = new AtlasSnapshotV1(
            "1.0",
            $"{_options.TargetId}/snapshot/{sequence.ToString(CultureInfo.InvariantCulture)}",
            new AtlasTargetV1(_options.TargetId, _options.DisplayName, PlatformName(target.Platform)),
            collectedAt,
            Array.AsReadOnly(items),
            [])
        {
            Collection = metadata,
        };
        var status = new AtlasCollectorStatusV1(
            AtlasCollectorMode.Connected, state, sequence, collectedAt, target.SourceTimestamp,
            staleAfter, false, items.Length, failures, skips, duration, 0, null, reason)
        {
            RowCount = rowCount,
        };
        return new AtlasCollectionResult(snapshot, status, false);
    }

    private async Task<IReadOnlyList<AtlasDatabaseIdentity>> SelectDatabasesAsync(
        AtlasTargetIdentity target,
        CancellationToken cancellationToken)
    {
        if (target.Platform == EnginePlatform.AzureSqlDatabase)
        {
            if (_options.KnownDatabases.Count == 0)
                throw new ProbeNotProbedException(
                    "Azure SQL Database requires an explicit known-database list; logical-server enumeration was not assumed.");

            return _options.KnownDatabases
                .Take(AtlasCollectionOptions.MaximumDatabases)
                .Select(name => new AtlasDatabaseIdentity(name, "UNKNOWN", 0, false))
                .ToArray();
        }

        return (await _executor.DiscoverDatabasesAsync(cancellationToken).ConfigureAwait(false))
            .Where(database => !string.IsNullOrWhiteSpace(database.Name))
            .Take(AtlasCollectionOptions.MaximumDatabases)
            .ToArray();
    }

    private async Task<IndexedResult> CollectOneBoundedAsync(
        AtlasDatabaseIdentity discovered,
        int index,
        AtlasTargetIdentity target,
        AtlasProbeSelection selection,
        DateTimeOffset collectedAt,
        SemaphoreSlim concurrency,
        CancellationToken cancellationToken)
    {
        await concurrency.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var result = await _executor.CollectDatabaseAsync(
                discovered.Name,
                selection,
                collectedAt - _options.QueryStoreWindow,
                collectedAt,
                cancellationToken).ConfigureAwait(false);
            var identity = result.Identity;
            var databaseId = StableDatabaseId(identity);
            var activity = await _activity.GetActivityAsync(
                databaseId, identity.Name, collectedAt, cancellationToken).ConfigureAwait(false);
            return new IndexedResult(index, Project(databaseId, result, target, activity, collectedAt), false, false, result.RowCount);
        }
        catch (ProbeNotProbedException ex)
        {
            return new IndexedResult(index, Unavailable(discovered, collectedAt, ex.Reason, DataStatus.Unsupported), false, true, 0);
        }
        catch (ProbeExecutionException ex)
        {
            var status = ex switch
            {
                ProbePermissionDeniedException => DataStatus.PermissionDenied,
                ProbeTransientConnectionException or ProbeDatabaseUnavailableException => DataStatus.Disconnected,
                _ => DataStatus.Unknown,
            };
            return new IndexedResult(index, Unavailable(discovered, collectedAt, ex.Reason, status), true, false, 0);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new IndexedResult(index, Unavailable(discovered, collectedAt,
                "The database probe timed out.", DataStatus.Unknown), true, false, 0);
        }
        finally
        {
            concurrency.Release();
        }
    }

    private DatabaseAtlasItemV1 Project(
        string databaseId,
        AtlasDatabaseProbeResult result,
        AtlasTargetIdentity target,
        LiveActivityV1 activity,
        DateTimeOffset collectedAt)
    {
        var source = result.SourceTimestamp;
        var evidence = new EvidenceV1(
            EvidenceSource.LiveDmvSample, DataStatus.Available, source,
            collectedAt + _options.StaleAfter, "Exact bytes collected from database-scoped catalog and DMV probes.");
        var queryStore = ProjectQueryStore(result.QueryStore, collectedAt);
        return new DatabaseAtlasItemV1(
            databaseId,
            result.Identity.Name,
            KnownBytes(result.Space.DataAllocatedBytes, evidence),
            KnownBytes(result.Space.DataUsedBytes, evidence),
            activity,
            queryStore)
        {
            State = result.Identity.State,
            CompatibilityLevel = result.Identity.CompatibilityLevel,
            LogAllocated = KnownBytes(result.Space.LogAllocatedBytes, evidence),
            LogUsed = KnownBytes(result.Space.LogUsedBytes, evidence),
            FileIo = ProjectIo(databaseId, result.FileIo, target.SqlServerStartTime, source, collectedAt),
        };
    }

    private QueryStoreHistoryV1 ProjectQueryStore(AtlasQueryStoreResult value, DateTimeOffset collectedAt)
    {
        var state = value.ActualState.ToUpperInvariant();
        var (capability, health, status, reason) = state switch
        {
            "ON" or "READ_WRITE" => (QueryStoreCapability.Available, QueryStoreHealth.Healthy, DataStatus.Available,
                "Query Store is readable and collecting."),
            "READ_ONLY" => (QueryStoreCapability.Available, QueryStoreHealth.ReadOnly, DataStatus.Available,
                QueryStoreReadOnlyReason.Describe(value.ReadOnlyReason)),
            "OFF" => (QueryStoreCapability.Disabled, QueryStoreHealth.Unavailable, DataStatus.Disabled,
                "Query Store is OFF for this database."),
            "ERROR" => (QueryStoreCapability.Available, QueryStoreHealth.Error, DataStatus.Unknown,
                "Query Store reports ERROR and its workload history is unavailable."),
            _ => (QueryStoreCapability.Unknown, QueryStoreHealth.Unknown, DataStatus.Unknown,
                "Query Store returned an unrecognized operational state."),
        };
        var evidence = new EvidenceV1(
            EvidenceSource.QueryStoreAggregate, status, value.WindowEnd,
            collectedAt + _options.StaleAfter, reason);
        var count = capability == QueryStoreCapability.Available ? value.ExecutionCount : null;
        return new QueryStoreHistoryV1(
            count,
            capability == QueryStoreCapability.Available ? value.LogicalReads8KiBPages : null,
            WeightedAverage(value.TotalDurationMicroseconds, count),
            value.WindowStart,
            value.WindowEnd,
            capability,
            health,
            reason,
            evidence)
        {
            TotalDurationMicroseconds = capability == QueryStoreCapability.Available ? value.TotalDurationMicroseconds : null,
            TotalCpuMicroseconds = capability == QueryStoreCapability.Available ? value.TotalCpuMicroseconds : null,
            DesiredState = value.DesiredState,
            CaptureMode = value.CaptureMode,
            CurrentStorageBytes = value.CurrentStorageBytes,
            MaxStorageBytes = value.MaxStorageBytes,
        };
    }

    private FileIoV1 ProjectIo(
        string databaseId,
        IReadOnlyList<AtlasFileIoCounter> counters,
        DateTimeOffset? resetEpoch,
        DateTimeOffset source,
        DateTimeOffset collectedAt)
    {
        var files = counters.ToDictionary(
            counter => counter.FileId,
            counter => new FileCounters(ParseUnsigned(counter.BytesRead), ParseUnsigned(counter.BytesWritten)));
        var bytesRead = files.Values.Aggregate(BigInteger.Zero, (sum, counter) => sum + counter.BytesRead);
        var bytesWritten = files.Values.Aggregate(BigInteger.Zero, (sum, counter) => sum + counter.BytesWritten);
        var sampleMs = counters.Count == 0 ? 0 : counters.Max(counter => counter.SampleMilliseconds);
        string? readRate = null;
        string? writeRate = null;
        var reason = "Cumulative file I/O counters collected; a second comparable sample is required before rates are available.";

        lock (_ioGate)
        {
            if (_previousIo.TryGetValue(databaseId, out var previous) &&
                previous.ResetEpoch == resetEpoch &&
                sampleMs > previous.SampleMilliseconds &&
                files.Count == previous.Files.Count &&
                files.All(file => previous.Files.TryGetValue(file.Key, out var old) &&
                                  file.Value.BytesRead >= old.BytesRead &&
                                  file.Value.BytesWritten >= old.BytesWritten))
            {
                var elapsedMs = sampleMs - previous.SampleMilliseconds;
                var readDelta = files.Aggregate(BigInteger.Zero,
                    (sum, file) => sum + file.Value.BytesRead - previous.Files[file.Key].BytesRead);
                var writeDelta = files.Aggregate(BigInteger.Zero,
                    (sum, file) => sum + file.Value.BytesWritten - previous.Files[file.Key].BytesWritten);
                readRate = (readDelta * 1000 / elapsedMs).ToString(CultureInfo.InvariantCulture);
                writeRate = (writeDelta * 1000 / elapsedMs).ToString(CultureInfo.InvariantCulture);
                reason = "Rates are deltas between two comparable cumulative samples in the same SQL Server reset epoch.";
            }
            else if (_previousIo.ContainsKey(databaseId))
            {
                reason = "Cumulative counters reset or regressed; this sample establishes a new baseline and has no rate.";
            }

            _previousIo[databaseId] = new PreviousIoSample(files, sampleMs, resetEpoch);
        }

        return new FileIoV1(
            bytesRead.ToString(CultureInfo.InvariantCulture),
            bytesWritten.ToString(CultureInfo.InvariantCulture),
            readRate,
            writeRate,
            sampleMs.ToString(CultureInfo.InvariantCulture),
            resetEpoch,
            new EvidenceV1(EvidenceSource.LiveDmvCumulative, DataStatus.Available, source,
                collectedAt + _options.StaleAfter, reason));
    }

    private DatabaseAtlasItemV1 Unavailable(
        AtlasDatabaseIdentity database,
        DateTimeOffset collectedAt,
        string reason,
        DataStatus status)
    {
        var evidence = new EvidenceV1(EvidenceSource.NotProbed, status, null, null, reason);
        var bytes = new ByteMeasurementV1(null, MeasurementStatus.Unknown, reason, evidence);
        return new DatabaseAtlasItemV1(
            StableDatabaseId(database), database.Name, bytes, bytes,
            new LiveActivityV1(null, null, null, null, evidence),
            new QueryStoreHistoryV1(null, null, null, null, null,
                QueryStoreCapability.Unknown, QueryStoreHealth.Unavailable, reason, evidence))
        {
            State = database.State,
            CompatibilityLevel = database.CompatibilityLevel == 0 ? null : database.CompatibilityLevel,
            LogAllocated = bytes,
            LogUsed = bytes,
        };
    }

    private AtlasCollectionResult Failed(long sequence, DateTimeOffset collectedAt, long started, string reason)
    {
        var duration = (long)_timeProvider.GetElapsedTime(started).TotalMilliseconds;
        var snapshot = new AtlasSnapshotV1(
            "1.0", $"{_options.TargetId}/failed/{sequence}", new AtlasTargetV1(_options.TargetId, _options.DisplayName, "Unknown"),
            collectedAt, [], [])
        {
            Collection = new AtlasCollectionMetadataV1(
                AtlasCollectorMode.Connected, AtlasCollectorState.Disconnected, sequence, collectedAt, collectedAt,
                null, true, 0, 1, 0, duration, reason),
        };
        var status = new AtlasCollectorStatusV1(
            AtlasCollectorMode.Connected, AtlasCollectorState.Disconnected, sequence, null, null, null,
            true, 0, 1, 0, duration, 1, null, reason);
        return new AtlasCollectionResult(snapshot, status, true);
    }

    public static AtlasProbeSelection SelectProbes(AtlasTargetIdentity target)
    {
        var majorText = target.ProductVersion.Split('.', 2)[0];
        if (!int.TryParse(majorText, NumberStyles.None, CultureInfo.InvariantCulture, out var major))
            throw new InvalidOperationException("The negotiated product version has no valid major version.");
        var modern = target.Platform == EnginePlatform.AzureSqlDatabase || major >= 16;
        return new AtlasProbeSelection(
            target.Platform == EnginePlatform.AzureSqlDatabase || major >= 15
                ? "querystore.options_2019"
                : "querystore.options_2016",
            modern ? "querystore.runtime_stats_summary_2022" : "querystore.runtime_stats_summary_2016",
            target.Platform == EnginePlatform.AzureSqlDatabase
                ? "io.file_io_stats_current_db"
                : "io.file_io_stats");
    }

    private string StableDatabaseId(AtlasDatabaseIdentity database) =>
        database.ResourceIdentity is { Length: > 0 } resource
            ? $"{_options.TargetId}/resource/{Uri.EscapeDataString(resource)}"
            : $"{_options.TargetId}/database/{Uri.EscapeDataString(database.Name)}";

    private static ByteMeasurementV1 KnownBytes(string bytes, EvidenceV1 evidence)
    {
        _ = ParseUnsigned(bytes);
        return new ByteMeasurementV1(bytes, MeasurementStatus.Known, null, evidence);
    }

    private static decimal? WeightedAverage(string? total, string? count)
    {
        if (total is null || count is null || !decimal.TryParse(total, NumberStyles.Number, CultureInfo.InvariantCulture, out var totalValue) ||
            !decimal.TryParse(count, NumberStyles.None, CultureInfo.InvariantCulture, out var countValue) || countValue == 0)
            return null;
        return totalValue / countValue;
    }

    private static BigInteger ParseUnsigned(string value)
    {
        if (!BigInteger.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) || parsed < 0)
            throw new InvalidOperationException("A probe returned an invalid unsigned decimal value.");
        return parsed;
    }

    private static string PlatformName(EnginePlatform platform) => platform switch
    {
        EnginePlatform.SqlServerOnPremises => "SQL Server",
        EnginePlatform.AzureSqlDatabase => "Azure SQL Database",
        EnginePlatform.AzureSqlManagedInstance => "Azure SQL Managed Instance",
        _ => "Unsupported",
    };

    private sealed record IndexedResult(int Index, DatabaseAtlasItemV1 Item, bool Failed, bool Skipped, int RowCount);
    private sealed record FileCounters(BigInteger BytesRead, BigInteger BytesWritten);
    private sealed record PreviousIoSample(
        IReadOnlyDictionary<int, FileCounters> Files,
        long SampleMilliseconds,
        DateTimeOffset? ResetEpoch);
}
