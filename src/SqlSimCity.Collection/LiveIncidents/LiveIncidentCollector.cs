using System.Globalization;
using SqlSimCity.Collection.Blocking;
using SqlSimCity.Collection.Deltas;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Collection.LiveIncidents;

/// <summary>
/// The real, source-neutral <see cref="ILiveIncidentCollector"/>. Every subsystem is probed
/// independently through <see cref="ILiveIncidentProbeExecutor"/> so one failing probe (a
/// permission gap, a timeout, an unsupported view on this platform) degrades only that subsystem
/// to an explicit <see cref="UnavailableFieldV1"/> rather than failing the whole snapshot
/// (requirement 2/6). This same class drives both a live <c>SqlLiveIncidentProbeExecutor</c> and
/// any other conforming executor; it holds no SQL-specific code itself.
///
/// Cross-cycle state this instance owns: the previous cycle's active requests (so a request that
/// disappears between polls is reported rather than silently dropped -- requirement 6's short-
/// lived-query disclosure), and one <see cref="CounterEpochTracker{TKey}"/> per cumulative counter
/// family (file I/O, scheduler CPU, scheduler delay) so deltas/epoch resets are computed correctly
/// across calls (requirement 5). Like <see cref="CounterEpochTracker{TKey}"/> itself, this type is
/// not thread-safe; the sampler guarantees at most one <see cref="CollectAsync"/> call is in
/// flight at a time.
/// </summary>
public sealed class LiveIncidentCollector : ILiveIncidentCollector
{
    private readonly ILiveIncidentProbeExecutor _probes;
    private readonly string _targetId;
    private readonly string _displayName;
    private readonly TimeProvider _timeProvider;
    private readonly TimeSpan _freshnessWindow;

    private readonly CounterEpochTracker<(int DatabaseId, int FileId, string Metric)> _fileIoTracker = new();
    private readonly CounterEpochTracker<int> _cpuUsageTracker = new();
    private readonly CounterEpochTracker<int> _schedulerDelayTracker = new();
    private Dictionary<string, LiveRequestV1> _previousRequests = new(StringComparer.Ordinal);
    private long _epochMarkerTicks;
    private DateTimeOffset? _previousSampleAt;

    public LiveIncidentCollector(
        ILiveIncidentProbeExecutor probes,
        string targetId,
        string displayName,
        TimeProvider? timeProvider = null,
        TimeSpan? freshnessWindow = null)
    {
        ArgumentNullException.ThrowIfNull(probes);
        ArgumentException.ThrowIfNullOrWhiteSpace(targetId);
        ArgumentException.ThrowIfNullOrWhiteSpace(displayName);
        _probes = probes;
        _targetId = targetId;
        _displayName = displayName;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _freshnessWindow = freshnessWindow ?? TimeSpan.FromSeconds(10);
    }

    public async Task<LiveIncidentSnapshotV1> CollectAsync(long sequence, CancellationToken cancellationToken)
    {
        var startedAt = _timeProvider.GetUtcNow();
        var unavailable = new List<UnavailableFieldV1>();
        var anySuccess = false;
        DateTimeOffset? sourceTimestamp = null;

        ServerIdentityResult? identity = null;
        try
        {
            identity = await _probes.GetServerIdentityAsync(cancellationToken).ConfigureAwait(false);
            anySuccess = true;
            if (identity.SqlServerStartTime is { } startTime)
            {
                _epochMarkerTicks = startTime.UtcTicks;
            }
        }
        catch (ProbeExecutionException ex)
        {
            var (status, reason) = Classify(ex);
            unavailable.Add(new UnavailableFieldV1("serverIdentity", status, reason));
        }

        var platform = identity is null ? EnginePlatform.Unsupported : MapPlatform(identity.EngineEdition);
        var isAzureSqlDatabase = platform == EnginePlatform.AzureSqlDatabase;

        var (requests, requestsSucceeded) = await CollectRequestsAsync(unavailable, cancellationToken).ConfigureAwait(false);
        anySuccess = anySuccess || requestsSucceeded;

        IReadOnlyList<BlockingInputFact> blockingFacts = [];
        try
        {
            blockingFacts = await _probes.GetBlockingInputsAsync(cancellationToken).ConfigureAwait(false);
            anySuccess = true;
        }
        catch (ProbeExecutionException ex)
        {
            var (status, reason) = Classify(ex);
            unavailable.Add(new UnavailableFieldV1("blockingGraph", status, reason));
        }

        IReadOnlyList<WaitingTaskFact> waitingTaskFacts = [];
        try
        {
            waitingTaskFacts = await _probes.GetWaitingTasksAsync(cancellationToken).ConfigureAwait(false);
            anySuccess = true;
        }
        catch (ProbeExecutionException ex)
        {
            var (status, reason) = Classify(ex);
            unavailable.Add(new UnavailableFieldV1("waitingTasks", status, reason));
        }

        var blockingGraph = BlockingGraphBuilder.BuildGraph(blockingFacts, waitingTaskFacts);
        var waitingTasks = BlockingGraphBuilder.BuildWaitingTasks(waitingTaskFacts);

        IReadOnlyList<MemoryGrantV1> memoryGrants = [];
        try
        {
            var rows = await _probes.GetMemoryGrantsAsync(cancellationToken).ConfigureAwait(false);
            memoryGrants = rows.Select(MapMemoryGrant).ToList();
            anySuccess = true;
        }
        catch (ProbeExecutionException ex)
        {
            var (status, reason) = Classify(ex);
            unavailable.Add(new UnavailableFieldV1("memoryGrants", status, reason));
        }

        var tempdb = await CollectTempdbAsync(cancellationToken).ConfigureAwait(false);
        anySuccess = anySuccess || tempdb.Status == DataStatus.Available;

        var now = _timeProvider.GetUtcNow();
        decimal? sampleWindowMs = _previousSampleAt is { } previousSampleAt
            ? (decimal)(now - previousSampleAt).TotalMilliseconds
            : null;

        var fileIo = await CollectFileIoAsync(isAzureSqlDatabase, now, sampleWindowMs, cancellationToken).ConfigureAwait(false);
        anySuccess = anySuccess || fileIo.Status == DataStatus.Available;

        var includeIdealWorkersLimit = ShouldIncludeIdealWorkersLimit(identity, platform);
        var scheduler = await CollectSchedulerAsync(includeIdealWorkersLimit, now, sampleWindowMs, cancellationToken).ConfigureAwait(false);
        anySuccess = anySuccess || scheduler.Status == DataStatus.Available;

        var logSpace = await CollectLogSpaceAsync(cancellationToken).ConfigureAwait(false);
        anySuccess = anySuccess || logSpace.Status == DataStatus.Available;

        _previousSampleAt = now;

        var completedAt = _timeProvider.GetUtcNow();
        var overallStatus = anySuccess ? DataStatus.Available : DataStatus.Disconnected;
        var overallReason = anySuccess
            ? "Snapshot assembled; see diagnostics.unavailableFields for any subsystem that could not be sampled this cycle."
            : unavailable.Count > 0
                ? unavailable[0].Reason
                : "No probe in this cycle returned data.";

        var diagnostics = new CollectionDiagnosticsV1(
            sequence,
            completedAt,
            sourceTimestamp,
            DurationMs: (long)(completedAt - startedAt).TotalMilliseconds,
            MissedCycles: 0,
            SkippedCycles: 0,
            UnavailableFields: unavailable);

        return new LiveIncidentSnapshotV1(
            "1.0",
            new LiveIncidentTargetV1(
                _targetId,
                _displayName,
                platform.ToString(),
                isAzureSqlDatabase ? "DatabaseScoped" : "Server",
                isAzureSqlDatabase ? "Azure SQL Database DMV visibility is database-scoped; server-wide fields are unavailable, not zero." : null),
            sourceTimestamp,
            completedAt,
            completedAt.Add(_freshnessWindow),
            overallStatus,
            overallReason,
            requests,
            waitingTasks,
            blockingGraph,
            memoryGrants,
            tempdb,
            fileIo,
            scheduler,
            logSpace,
            diagnostics);
    }

    private async Task<(IReadOnlyList<LiveRequestV1> Requests, bool Succeeded)> CollectRequestsAsync(
        List<UnavailableFieldV1> unavailable,
        CancellationToken cancellationToken)
    {
        IReadOnlyList<ActiveRequestRow> rows;
        try
        {
            rows = await _probes.GetActiveRequestsAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (ProbeExecutionException ex)
        {
            var (status, reason) = Classify(ex);
            unavailable.Add(new UnavailableFieldV1("requests", status, reason));

            // The probe failed outright this cycle: carry every previously-known request forward
            // unchanged rather than silently discarding them, since we have no evidence they ended.
            return (_previousRequests.Values.ToList(), false);
        }

        var current = new Dictionary<string, LiveRequestV1>(StringComparer.Ordinal);
        foreach (var row in rows)
        {
            var mapped = MapActiveRequest(row);
            current[mapped.RequestId] = mapped;
        }

        var disappeared = _previousRequests
            .Where(kvp => !current.ContainsKey(kvp.Key) && kvp.Value.Availability == SampleAvailability.Available)
            .Select(kvp => kvp.Value with
            {
                Availability = SampleAvailability.Disappeared,
                AvailabilityReason = "This request was present in the previous sampling cycle and is no longer visible: " +
                    "it completed, was killed, or its session ended. A request that both started and finished between " +
                    "two sampling cycles is never observed at all (requirement 6's short-lived-query disclosure).",
            })
            .ToList();

        _previousRequests = current;
        return (current.Values.Concat(disappeared).ToList(), true);
    }

    private static LiveRequestV1 MapActiveRequest(ActiveRequestRow row) => new(
        RequestId: $"req:{row.SessionId}:{row.RequestId ?? 0}",
        SessionId: row.SessionId,
        LoginName: row.LoginName,
        HostName: row.HostName,
        ProgramName: row.ProgramName,
        SessionStatus: row.SessionStatus,
        RequestStatus: row.RequestStatus,
        Command: row.Command,
        WaitType: row.WaitType,
        WaitTimeMs: row.WaitTimeMs,
        WaitResource: row.WaitResource,
        Blocking: BlockingReferenceV1.FromRaw(row.BlockingSessionId),
        RequestStartTime: row.RequestStartTime,
        TotalElapsedMs: row.TotalElapsedTimeMs,
        CpuTimeMs: row.CpuTimeMs,
        Reads: row.Reads?.ToString(CultureInfo.InvariantCulture),
        Writes: row.Writes?.ToString(CultureInfo.InvariantCulture),
        LogicalReads8KiBPages: row.LogicalReads?.ToString(CultureInfo.InvariantCulture),
        OpenTransactionCount: row.OpenTransactionCount,
        DatabaseId: row.DatabaseId?.ToString(CultureInfo.InvariantCulture),
        DatabaseName: row.DatabaseName,
        CurrentStatementText: row.CurrentStatementText,
        BatchText: row.BatchText,
        Availability: SampleAvailability.Available,
        AvailabilityReason: null,
        PlanState: PlanCollectionState.NotRequested,
        PlanReason: "Plan XML is never fetched during routine sampling; only statement text is captured " +
                    "(requirement 6). A request that both started and finished between two sampling cycles " +
                    "is never observed here at all.");

    private static MemoryGrantV1 MapMemoryGrant(MemoryGrantRow row) => new(
        row.SessionId,
        row.RequestId,
        row.SchedulerId,
        row.Dop,
        row.RequestTime,
        row.GrantTime,
        row.GrantTime is null,
        row.RequestedMemoryKb?.ToString(CultureInfo.InvariantCulture),
        row.GrantedMemoryKb?.ToString(CultureInfo.InvariantCulture),
        row.RequiredMemoryKb?.ToString(CultureInfo.InvariantCulture),
        row.UsedMemoryKb?.ToString(CultureInfo.InvariantCulture),
        row.MaxUsedMemoryKb?.ToString(CultureInfo.InvariantCulture),
        row.IdealMemoryKb?.ToString(CultureInfo.InvariantCulture),
        row.QueryCost,
        row.TimeoutSec,
        row.WaitTimeMs?.ToString(CultureInfo.InvariantCulture),
        row.BatchText);

    private async Task<TempdbUsageV1> CollectTempdbAsync(CancellationToken cancellationToken)
    {
        try
        {
            var raw = await _probes.GetTempdbUsageAsync(cancellationToken).ConfigureAwait(false);
            return new TempdbUsageV1(
                raw.Files.Select(f => new TempdbFileUsageV1(
                    f.FileId, f.TotalMb, f.AllocatedMb, f.FreeMb, f.VersionStoreMb, f.UserObjectsMb, f.InternalObjectsMb, f.MixedExtentMb)).ToList(),
                raw.Sessions.Select(s => new TempdbSessionUsageV1(
                    s.SessionId,
                    s.UserObjectsAllocPageCount.ToString(CultureInfo.InvariantCulture),
                    s.UserObjectsDeallocPageCount.ToString(CultureInfo.InvariantCulture),
                    s.InternalObjectsAllocPageCount.ToString(CultureInfo.InvariantCulture),
                    s.InternalObjectsDeallocPageCount.ToString(CultureInfo.InvariantCulture))).ToList(),
                raw.Tasks.Select(t => new TempdbTaskUsageV1(
                    t.SessionId, t.RequestId, t.ExecContextId,
                    t.UserObjectsAllocPageCount.ToString(CultureInfo.InvariantCulture),
                    t.UserObjectsDeallocPageCount.ToString(CultureInfo.InvariantCulture),
                    t.InternalObjectsAllocPageCount.ToString(CultureInfo.InvariantCulture),
                    t.InternalObjectsDeallocPageCount.ToString(CultureInfo.InvariantCulture))).ToList(),
                DataStatus.Available,
                "tempdb usage sampled from a connection opened with tempdb as its initial database.");
        }
        catch (ProbeExecutionException ex)
        {
            var (status, reason) = Classify(ex);
            return new TempdbUsageV1([], [], [], status, reason);
        }
    }

    private async Task<FileIoSampleV1> CollectFileIoAsync(
        bool isAzureSqlDatabase, DateTimeOffset now, decimal? sampleWindowMs, CancellationToken cancellationToken)
    {
        try
        {
            var rows = await _probes.GetFileIoStatsAsync(isAzureSqlDatabase, cancellationToken).ConfigureAwait(false);
            var deltas = rows.Select(row =>
            {
                // Each counter (reads/bytesRead/stallRead/writes/bytesWritten/stallWrite) is
                // tracked under its own key: sharing one key per file would make each metric's
                // Compute() call overwrite the previous metric's "last observation" for that file,
                // silently comparing unrelated counters and fabricating spurious epoch resets.
                var reads = _fileIoTracker.Compute((row.DatabaseId, row.FileId, "reads"), new CounterObservation(row.NumOfReads, now, _epochMarkerTicks));
                var bytesRead = _fileIoTracker.Compute((row.DatabaseId, row.FileId, "bytesRead"), new CounterObservation(row.NumOfBytesRead, now, _epochMarkerTicks));
                var stallRead = _fileIoTracker.Compute((row.DatabaseId, row.FileId, "stallRead"), new CounterObservation(row.IoStallReadMs, now, _epochMarkerTicks));
                var writes = _fileIoTracker.Compute((row.DatabaseId, row.FileId, "writes"), new CounterObservation(row.NumOfWrites, now, _epochMarkerTicks));
                var bytesWritten = _fileIoTracker.Compute((row.DatabaseId, row.FileId, "bytesWritten"), new CounterObservation(row.NumOfBytesWritten, now, _epochMarkerTicks));
                var stallWrite = _fileIoTracker.Compute((row.DatabaseId, row.FileId, "stallWrite"), new CounterObservation(row.IoStallWriteMs, now, _epochMarkerTicks));
                var epochId = FileIoMetrics(row.DatabaseId, row.FileId).Max(_fileIoTracker.CurrentEpochId);
                return new FileIoDeltaV1(
                    row.DatabaseId, row.DatabaseName, row.FileId, row.TypeDesc,
                    epochId, sampleWindowMs,
                    reads, bytesRead, stallRead, writes, bytesWritten, stallWrite);
            }).ToList();

            _fileIoTracker.Prune(rows.SelectMany(r => FileIoMetrics(r.DatabaseId, r.FileId)).ToList());
            return new FileIoSampleV1(deltas, DataStatus.Available,
                isAzureSqlDatabase
                    ? "File I/O sampled through the Azure SQL Database-scoped view (io.file_io_stats_current_db)."
                    : "File I/O sampled through the instance-wide view (io.file_io_stats).");
        }
        catch (ProbeExecutionException ex)
        {
            var (status, reason) = Classify(ex);
            return new FileIoSampleV1([], status, reason);
        }
    }

    private static readonly string[] FileIoMetricNames = ["reads", "bytesRead", "stallRead", "writes", "bytesWritten", "stallWrite"];

    private static IEnumerable<(int DatabaseId, int FileId, string Metric)> FileIoMetrics(int databaseId, int fileId) =>
        FileIoMetricNames.Select(metric => (databaseId, fileId, metric));

    private async Task<SchedulerPressureV1> CollectSchedulerAsync(
        bool includeIdealWorkersLimit, DateTimeOffset now, decimal? sampleWindowMs, CancellationToken cancellationToken)
    {
        try
        {
            var rows = await _probes.GetSchedulerPressureAsync(includeIdealWorkersLimit, cancellationToken).ConfigureAwait(false);
            var samples = rows.Select(row =>
            {
                var cpuDelta = _cpuUsageTracker.Compute(row.SchedulerId, new CounterObservation(row.TotalCpuUsageMs, now, _epochMarkerTicks));
                var delayDelta = _schedulerDelayTracker.Compute(row.SchedulerId, new CounterObservation(row.TotalSchedulerDelayMs, now, _epochMarkerTicks));
                return new SchedulerSampleV1(
                    row.SchedulerId, row.CpuId, row.Status, row.IsOnline, row.IsIdle,
                    row.CurrentTasksCount, row.RunnableTasksCount, row.CurrentWorkersCount, row.ActiveWorkersCount,
                    row.WorkQueueCount, row.PendingDiskIoCount, row.LoadFactor,
                    _cpuUsageTracker.CurrentEpochId(row.SchedulerId), sampleWindowMs,
                    cpuDelta, delayDelta, row.IdealWorkersLimit);
            }).ToList();

            var liveSchedulerIds = rows.Select(r => r.SchedulerId).ToList();
            _cpuUsageTracker.Prune(liveSchedulerIds);
            _schedulerDelayTracker.Prune(liveSchedulerIds);
            return new SchedulerPressureV1(samples, DataStatus.Available,
                includeIdealWorkersLimit
                    ? "Scheduler pressure sampled including ideal_workers_limit (SQL Server 2019+/Azure SQL Database)."
                    : "Scheduler pressure sampled without ideal_workers_limit (pre-2019 SQL Server).");
        }
        catch (ProbeExecutionException ex)
        {
            var (status, reason) = Classify(ex);
            return new SchedulerPressureV1([], status, reason);
        }
    }

    private async Task<LogSpaceUsageV1> CollectLogSpaceAsync(CancellationToken cancellationToken)
    {
        try
        {
            var row = await _probes.GetLogSpaceUsageAsync(cancellationToken).ConfigureAwait(false);
            return row is null
                ? new LogSpaceUsageV1(null, null, null, DataStatus.Unknown, "The log space probe returned no row for the current database.")
                : new LogSpaceUsageV1(row.TotalLogSizeMb, row.UsedLogSpaceMb, row.UsedLogSpacePercent, DataStatus.Available,
                    "Log space usage is an instant gauge for the connected database; it is never delta'd.");
        }
        catch (ProbeExecutionException ex)
        {
            var (status, reason) = Classify(ex);
            return new LogSpaceUsageV1(null, null, null, status, reason);
        }
    }

    /// <summary>
    /// Azure SQL Database always exposes <c>ideal_workers_limit</c> (see scheduler.pressure_2019's
    /// manifest notes); on-premises SQL Server needs the 2019+ variant only from SQL Server 2019
    /// onward, detected from the leading product-version component.
    /// </summary>
    private static bool ShouldIncludeIdealWorkersLimit(ServerIdentityResult? identity, EnginePlatform platform)
    {
        if (platform is EnginePlatform.AzureSqlDatabase or EnginePlatform.AzureSqlManagedInstance)
        {
            return true;
        }

        if (identity?.ProductVersion is { } version)
        {
            var majorText = version.Split('.', 2)[0];
            if (int.TryParse(majorText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var major))
            {
                return major >= 15; // SQL Server 2019 is major version 15.
            }
        }

        return false;
    }

    private static EnginePlatform MapPlatform(int engineEdition) => engineEdition switch
    {
        1 or 2 or 3 or 4 => EnginePlatform.SqlServerOnPremises,
        5 => EnginePlatform.AzureSqlDatabase,
        8 => EnginePlatform.AzureSqlManagedInstance,
        _ => EnginePlatform.Unsupported,
    };

    private static (DataStatus Status, string Reason) Classify(ProbeExecutionException ex) => ex switch
    {
        ProbePermissionDeniedException => (DataStatus.PermissionDenied, ex.Reason),
        ProbeObjectUnavailableException => (DataStatus.Unsupported, ex.Reason),
        ProbeNotProbedException => (DataStatus.Unknown, ex.Reason),
        ProbeTimeoutException => (DataStatus.Disconnected, ex.Reason),
        ProbeTransientConnectionException => (DataStatus.Disconnected, ex.Reason),
        ProbeAuthenticationException => (DataStatus.Disconnected, ex.Reason),
        ProbeDatabaseUnavailableException => (DataStatus.Disconnected, ex.Reason),
        _ => (DataStatus.Unknown, ex.Reason),
    };
}
