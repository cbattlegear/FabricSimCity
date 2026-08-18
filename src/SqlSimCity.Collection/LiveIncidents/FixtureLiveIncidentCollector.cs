using System.Globalization;
using System.Reflection;
using System.Text.Json;
using SqlSimCity.Collection.Blocking;
using SqlSimCity.Collection.Deltas;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Collection.LiveIncidents;

/// <summary>
/// A deterministic <see cref="ILiveIncidentCollector"/> backed by the repository's existing
/// <c>fixtures/v1/live-cases.json</c>, embedded into this assembly. This is the default,
/// no-credentials collector the API wires up (see <c>Program.cs</c>): every reader of
/// <c>/api/v1/live</c> sees the same blocking chain, sentinel, parallel-wait, disappearing-request,
/// and plan-unavailable cases described in the fixture without ever needing a live SQL Server
/// connection. The blocking graph and every cumulative-counter delta are still computed by the real
/// <see cref="BlockingGraphBuilder"/> and <see cref="CounterEpochTracker{TKey}"/> logic that the
/// live <c>SqlLiveIncidentProbeExecutor</c> path uses -- only the raw facts are fixed.
/// </summary>
public sealed class FixtureLiveIncidentCollector : ILiveIncidentCollector
{
    private const string TargetId = "fixture-live-incident-target";
    private const string DisplayName = "Fixture SQL Server";

    private readonly FixtureDocument _document;
    private readonly TimeProvider _timeProvider;
    private readonly CounterEpochTracker<(int DatabaseId, int FileId, string Metric)> _fileIoTracker = new();
    private readonly CounterEpochTracker<int> _cpuUsageTracker = new();
    private readonly CounterEpochTracker<int> _schedulerDelayTracker = new();
    private DateTimeOffset? _previousSampleAt;
    private long _epochMarkerTicks;

    public FixtureLiveIncidentCollector(TimeProvider? timeProvider = null, Assembly? assembly = null)
    {
        _timeProvider = timeProvider ?? TimeProvider.System;
        _document = LoadDocument(assembly ?? typeof(FixtureLiveIncidentCollector).Assembly);
        _epochMarkerTicks = _document.ServerIdentity.SqlServerStartTimeUtc.UtcTicks;
    }

    public Task<LiveIncidentSnapshotV1> CollectAsync(long sequence, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var now = _timeProvider.GetUtcNow();

        var lockResolutions = (_document.LockResourceResolutions ?? [])
            .GroupBy(r => r.HobtId)
            .ToDictionary(g => g.Key, g => g.First());

        var requests = _document.Requests
            .Select(row => ApplyLockResolution(MapRequest(row), lockResolutions))
            .ToList();

        var blockingFacts = _document.Requests
            .Where(r => r.Availability == "available" && r.BlockingSessionId is not null and not 0)
            .Select(r => new BlockingInputFact(
                "blocked_request",
                r.SessionId,
                0,
                r.BlockingSessionId,
                r.WaitType,
                r.WaitTimeMs,
                r.WaitResource,
                r.Status,
                r.OpenTransactionCount,
                r.RequestStartTime,
                r.Command,
                null))
            .ToList();

        var waitingTaskFacts = _document.WaitingTasks
            .GroupBy(t => t.SessionId)
            .SelectMany(group => group.Select((t, index) => new WaitingTaskFact(
                t.TaskId,
                t.SessionId,
                t.ExecutionContext == "coordinator" ? 0 : index,
                t.WaitDurationMs,
                t.WaitType,
                null,
                null,
                t.BlockingSessionId,
                t.ResourceDescription)))
            .ToList();

        var blockingGraph = BlockingGraphBuilder.BuildGraph(blockingFacts, waitingTaskFacts);
        var waitingTasks = BlockingGraphBuilder.BuildWaitingTasks(waitingTaskFacts);

        var memoryGrants = _document.MemoryGrants.Select(MapMemoryGrant).ToList();

        var tempdb = new TempdbUsageV1(
            _document.TempdbUsage.Files.Select(f => new TempdbFileUsageV1(
                f.FileId, f.TotalMb, f.AllocatedMb, f.FreeMb, f.VersionStoreMb, f.UserObjectsMb, f.InternalObjectsMb, f.MixedExtentMb)).ToList(),
            _document.TempdbUsage.Sessions.Select(s => new TempdbSessionUsageV1(
                s.SessionId,
                s.UserObjectsAllocPageCount.ToString(CultureInfo.InvariantCulture),
                s.UserObjectsDeallocPageCount.ToString(CultureInfo.InvariantCulture),
                s.InternalObjectsAllocPageCount.ToString(CultureInfo.InvariantCulture),
                s.InternalObjectsDeallocPageCount.ToString(CultureInfo.InvariantCulture))).ToList(),
            _document.TempdbUsage.Tasks.Select(t => new TempdbTaskUsageV1(
                t.SessionId, t.RequestId,
                t.ExecContextId,
                t.UserObjectsAllocPageCount.ToString(CultureInfo.InvariantCulture),
                t.UserObjectsDeallocPageCount.ToString(CultureInfo.InvariantCulture),
                t.InternalObjectsAllocPageCount.ToString(CultureInfo.InvariantCulture),
                t.InternalObjectsDeallocPageCount.ToString(CultureInfo.InvariantCulture))).ToList(),
            DataStatus.Available,
            "tempdb usage sampled from the fixture's own private tempdb context.");

        decimal? sampleWindowMs = _previousSampleAt is { } previous ? (decimal)(now - previous).TotalMilliseconds : null;

        var fileIoDeltas = _document.FileIo.Select(row =>
        {
            // Each counter is tracked under its own key: sharing one key per file would make
            // each metric's Compute() call overwrite the previous metric's "last observation"
            // for that file, silently comparing unrelated counters and fabricating spurious
            // epoch resets.
            var reads = _fileIoTracker.Compute((row.DatabaseId, row.FileId, "reads"), new CounterObservation(row.NumOfReads, now, _epochMarkerTicks));
            var bytesRead = _fileIoTracker.Compute((row.DatabaseId, row.FileId, "bytesRead"), new CounterObservation(row.NumOfBytesRead, now, _epochMarkerTicks));
            var stallRead = _fileIoTracker.Compute((row.DatabaseId, row.FileId, "stallRead"), new CounterObservation(row.IoStallReadMs, now, _epochMarkerTicks));
            var writes = _fileIoTracker.Compute((row.DatabaseId, row.FileId, "writes"), new CounterObservation(row.NumOfWrites, now, _epochMarkerTicks));
            var bytesWritten = _fileIoTracker.Compute((row.DatabaseId, row.FileId, "bytesWritten"), new CounterObservation(row.NumOfBytesWritten, now, _epochMarkerTicks));
            var stallWrite = _fileIoTracker.Compute((row.DatabaseId, row.FileId, "stallWrite"), new CounterObservation(row.IoStallWriteMs, now, _epochMarkerTicks));
            var epochId = FileIoMetrics(row.DatabaseId, row.FileId).Max(_fileIoTracker.CurrentEpochId);
            return new FileIoDeltaV1(
                row.DatabaseId, row.DatabaseName, row.FileId, row.TypeDesc,
                epochId,
                sampleWindowMs,
                reads, bytesRead, stallRead, writes, bytesWritten, stallWrite);
        }).ToList();

        var schedulerSamples = _document.SchedulerPressure.Select(row =>
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

        _previousSampleAt = now;

        var diagnostics = new CollectionDiagnosticsV1(
            sequence,
            now,
            _document.ObservedAt,
            DurationMs: 0,
            MissedCycles: 0,
            SkippedCycles: 0,
            UnavailableFields: []);

        var snapshot = new LiveIncidentSnapshotV1(
            "1.0",
            new LiveIncidentTargetV1(TargetId, DisplayName, "SqlServerOnPremises", "Server", null),
            _document.ObservedAt,
            now,
            now.AddSeconds(5),
            DataStatus.Available,
            "Fixture snapshot; no live connection was used.",
            requests,
            waitingTasks,
            blockingGraph,
            memoryGrants,
            tempdb,
            new FileIoSampleV1(fileIoDeltas, DataStatus.Available, "File I/O counters sampled from the fixture."),
            new SchedulerPressureV1(schedulerSamples, DataStatus.Available, "Scheduler pressure sampled from the fixture."),
            new LogSpaceUsageV1(_document.LogSpace.TotalLogSizeMb, _document.LogSpace.UsedLogSpaceMb, _document.LogSpace.UsedLogSpacePercent,
                DataStatus.Available, "Log space sampled from the fixture."),
            diagnostics);

        return Task.FromResult(snapshot);
    }

    private static readonly string[] FileIoMetricNames = ["reads", "bytesRead", "stallRead", "writes", "bytesWritten", "stallWrite"];

    private static IEnumerable<(int DatabaseId, int FileId, string Metric)> FileIoMetrics(int databaseId, int fileId) =>
        FileIoMetricNames.Select(metric => (databaseId, fileId, metric));

    /// <summary>
    /// Applies the fixture's declared hobt resolution table, mirroring what connected mode does with
    /// the <c>sessions.lock_resource_objects</c> probe result. A hobt the table does not cover keeps
    /// <see cref="LockResolutionStatus.RequiresLookup"/> and says so, so the fixture demonstrates the
    /// unresolved path as well as the resolved one.
    /// </summary>
    private static LiveRequestV1 ApplyLockResolution(
        LiveRequestV1 request,
        IReadOnlyDictionary<long, FixtureLockResolutionRow> resolutions)
    {
        var resource = request.LockResource;
        if (resource is null || resource.Status != LockResolutionStatus.RequiresLookup || resource.HobtId is null)
        {
            return request;
        }

        if (!resolutions.TryGetValue(resource.HobtId.Value, out var row))
        {
            return request with
            {
                LockResource = LockResourceParser.MarkLookupMissed(
                    resource,
                    "The fixture's declared lock-resolution table does not cover this hobt_id, so the lock is reported unresolved."),
            };
        }

        return request with
        {
            LockResource = LockResourceParser.Resolve(
                resource,
                row.ObjectId,
                row.IndexId,
                row.SchemaName,
                row.ObjectName,
                row.IndexName,
                "Resolved from the fixture's declared lock-resolution table, which stands in for the sessions.lock_resource_objects probe offline."),
        };
    }

    private static LiveRequestV1 MapRequest(FixtureRequestRow row)
    {
        var availability = row.Availability switch
        {
            "disappeared" => SampleAvailability.Disappeared,
            "unavailable" => SampleAvailability.Unavailable,
            _ => SampleAvailability.Available,
        };

        var planState = row.PlanAvailability switch
        {
            "unavailable" => PlanCollectionState.Unavailable,
            "available" => PlanCollectionState.Available,
            _ => PlanCollectionState.NotRequested,
        };

        return new LiveRequestV1(
            row.RequestId,
            row.SessionId,
            row.LoginName,
            row.HostName,
            row.ProgramName,
            row.SessionStatus,
            row.Status,
            row.Command,
            row.WaitType,
            row.WaitTimeMs,
            row.WaitResource,
            BlockingReferenceV1.FromRaw(row.BlockingSessionId),
            row.RequestStartTime,
            row.TotalElapsedMs,
            row.CpuTimeMs,
            row.Reads?.ToString(CultureInfo.InvariantCulture),
            row.Writes?.ToString(CultureInfo.InvariantCulture),
            row.LogicalReads?.ToString(CultureInfo.InvariantCulture),
            row.OpenTransactionCount,
            row.DatabaseId,
            row.DatabaseId,
            row.CurrentStatementText,
            row.BatchText,
            availability,
            row.AvailabilityReason,
            planState,
            row.PlanAvailabilityReason)
        {
            // The fixture has no catalog to look a hobt_id up in, so a KEY/HOBT resource stays
            // RequiresLookup here. Fixture cases that need a resolved lock state it as an OBJECT
            // resource, which resolves with no lookup at all.
            LockResource = LockResourceParser.Parse(row.WaitResource),
        };
    }

    private static MemoryGrantV1 MapMemoryGrant(FixtureMemoryGrantRow row) => new(
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

    private static FixtureDocument LoadDocument(Assembly assembly)
    {
        var logicalName = "fixtures/v1/live-cases.json";
        var resourceName = assembly.GetManifestResourceNames().FirstOrDefault(n => n.Replace('\\', '/') == logicalName)
            ?? throw new InvalidOperationException($"Embedded fixture resource '{logicalName}' was not found.");
        using var stream = assembly.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"Embedded fixture resource '{logicalName}' could not be opened.");
        using var document = JsonDocument.Parse(stream);
        var root = document.RootElement;

        var observedAt = DateTimeOffset.Parse(root.GetProperty("observedAt").GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);

        var requests = root.GetProperty("requests").EnumerateArray().Select(e => new FixtureRequestRow(
            e.GetProperty("requestId").GetString()!,
            e.GetProperty("sessionId").GetInt32(),
            GetString(e, "loginName"),
            GetString(e, "hostName"),
            GetString(e, "programName"),
            GetString(e, "sessionStatus"),
            GetString(e, "status"),
            GetString(e, "command"),
            GetString(e, "waitType"),
            GetNullableInt64(e, "waitTimeMs"),
            GetString(e, "waitResource"),
            GetNullableInt64(e, "blockingSessionId"),
            GetNullableDateTimeOffset(e, "requestStartTime"),
            GetNullableInt64(e, "totalElapsedMs"),
            GetNullableInt64(e, "cpuTimeMs"),
            GetNullableInt64(e, "reads"),
            GetNullableInt64(e, "writes"),
            GetNullableInt64(e, "logicalReads"),
            GetNullableInt32(e, "openTransactionCount"),
            GetString(e, "databaseId"),
            GetString(e, "batchText"),
            GetString(e, "currentStatementText"),
            e.GetProperty("availability").GetString()!,
            GetString(e, "availabilityReason"),
            GetString(e, "planAvailability"),
            GetString(e, "planAvailabilityReason")))
            .ToList();

        var waitingTasks = root.GetProperty("waitingTasks").EnumerateArray().Select(e => new FixtureWaitingTaskRow(
            e.GetProperty("taskId").GetString()!,
            e.GetProperty("sessionId").GetInt32(),
            e.GetProperty("executionContext").GetString()!,
            GetString(e, "waitType"),
            GetNullableInt64(e, "waitDurationMs") ?? 0,
            GetString(e, "resourceDescription"),
            GetNullableInt64(e, "blockingSessionId")))
            .ToList();

        var memoryGrants = root.GetProperty("memoryGrants").EnumerateArray().Select(e => new FixtureMemoryGrantRow(
            e.GetProperty("sessionId").GetInt32(),
            GetNullableInt32(e, "requestId"),
            GetNullableInt32(e, "schedulerId"),
            GetNullableInt32(e, "dop"),
            GetNullableDateTimeOffset(e, "requestTime"),
            GetNullableDateTimeOffset(e, "grantTime"),
            GetNullableInt64(e, "requestedMemoryKb"),
            GetNullableInt64(e, "grantedMemoryKb"),
            GetNullableInt64(e, "requiredMemoryKb"),
            GetNullableInt64(e, "usedMemoryKb"),
            GetNullableInt64(e, "maxUsedMemoryKb"),
            GetNullableInt64(e, "idealMemoryKb"),
            GetNullableDecimal(e, "queryCost"),
            GetNullableInt32(e, "timeoutSec"),
            GetNullableInt64(e, "waitTimeMs"),
            GetString(e, "batchText")))
            .ToList();

        var tempdbElement = root.GetProperty("tempdbUsage");
        var tempdbFiles = tempdbElement.GetProperty("files").EnumerateArray().Select(e => new FixtureTempdbFileRow(
            e.GetProperty("databaseId").GetInt32(),
            e.GetProperty("fileId").GetInt32(),
            e.GetProperty("totalMb").GetDecimal(),
            e.GetProperty("allocatedMb").GetDecimal(),
            e.GetProperty("freeMb").GetDecimal(),
            e.GetProperty("versionStoreMb").GetDecimal(),
            e.GetProperty("userObjectsMb").GetDecimal(),
            e.GetProperty("internalObjectsMb").GetDecimal(),
            e.GetProperty("mixedExtentMb").GetDecimal()))
            .ToList();
        var tempdbSessions = tempdbElement.GetProperty("sessions").EnumerateArray().Select(e => new FixtureTempdbSessionRow(
            e.GetProperty("sessionId").GetInt32(),
            e.GetProperty("userObjectsAllocPageCount").GetInt64(),
            e.GetProperty("userObjectsDeallocPageCount").GetInt64(),
            e.GetProperty("internalObjectsAllocPageCount").GetInt64(),
            e.GetProperty("internalObjectsDeallocPageCount").GetInt64()))
            .ToList();
        var tempdbTasks = tempdbElement.GetProperty("tasks").EnumerateArray().Select(e => new FixtureTempdbTaskRow(
            e.GetProperty("sessionId").GetInt32(),
            GetNullableInt32(e, "requestId"),
            e.GetProperty("execContextId").GetInt32(),
            e.GetProperty("userObjectsAllocPageCount").GetInt64(),
            e.GetProperty("userObjectsDeallocPageCount").GetInt64(),
            e.GetProperty("internalObjectsAllocPageCount").GetInt64(),
            e.GetProperty("internalObjectsDeallocPageCount").GetInt64()))
            .ToList();

        var fileIo = root.GetProperty("fileIo").EnumerateArray().Select(e => new FixtureFileIoRow(
            e.GetProperty("databaseId").GetInt32(),
            GetString(e, "databaseName"),
            e.GetProperty("fileId").GetInt32(),
            GetString(e, "typeDesc"),
            e.GetProperty("sampleMs").GetInt64(),
            e.GetProperty("numOfReads").GetInt64(),
            e.GetProperty("numOfBytesRead").GetInt64(),
            e.GetProperty("ioStallReadMs").GetInt64(),
            e.GetProperty("numOfWrites").GetInt64(),
            e.GetProperty("numOfBytesWritten").GetInt64(),
            e.GetProperty("ioStallWriteMs").GetInt64(),
            e.GetProperty("ioStall").GetInt64()))
            .ToList();

        var schedulerPressure = root.GetProperty("schedulerPressure").EnumerateArray().Select(e => new FixtureSchedulerRow(
            e.GetProperty("schedulerId").GetInt32(),
            e.GetProperty("cpuId").GetInt32(),
            GetString(e, "status"),
            e.GetProperty("isOnline").GetBoolean(),
            e.GetProperty("isIdle").GetBoolean(),
            e.GetProperty("currentTasksCount").GetInt32(),
            e.GetProperty("runnableTasksCount").GetInt32(),
            e.GetProperty("currentWorkersCount").GetInt32(),
            e.GetProperty("activeWorkersCount").GetInt32(),
            e.GetProperty("workQueueCount").GetInt32(),
            e.GetProperty("pendingDiskIoCount").GetInt32(),
            e.GetProperty("loadFactor").GetInt32(),
            e.GetProperty("totalCpuUsageMs").GetInt64(),
            e.GetProperty("totalSchedulerDelayMs").GetInt64(),
            GetNullableInt32(e, "idealWorkersLimit")))
            .ToList();

        var logSpaceElement = root.GetProperty("logSpace");
        var logSpace = new FixtureLogSpaceRow(
            logSpaceElement.GetProperty("totalLogSizeMb").GetDecimal(),
            logSpaceElement.GetProperty("usedLogSpaceMb").GetDecimal(),
            logSpaceElement.GetProperty("usedLogSpacePercent").GetDecimal());

        var identityElement = root.GetProperty("serverIdentity");
        var serverIdentity = new FixtureServerIdentity(
            identityElement.GetProperty("serverName").GetString()!,
            DateTimeOffset.Parse(identityElement.GetProperty("sqlServerStartTimeUtc").GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal));

        var lockResolutions = root.TryGetProperty("lockResourceResolutions", out var lockElement)
            && lockElement.ValueKind == JsonValueKind.Array
            ? lockElement.EnumerateArray().Select(e => new FixtureLockResolutionRow(
                e.GetProperty("hobtId").GetInt64(),
                e.GetProperty("objectId").GetInt32(),
                GetNullableInt32(e, "indexId"),
                GetString(e, "schemaName"),
                GetString(e, "objectName"),
                GetString(e, "indexName"))).ToList()
            : [];

        return new FixtureDocument(observedAt, requests, waitingTasks, memoryGrants,
            new FixtureTempdbUsage(tempdbFiles, tempdbSessions, tempdbTasks), fileIo, schedulerPressure, logSpace, serverIdentity)
        {
            LockResourceResolutions = lockResolutions,
        };
    }

    private static string? GetString(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static int? GetNullableInt32(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.Number ? value.GetInt32() : null;

    private static long? GetNullableInt64(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.Number ? value.GetInt64() : null;

    private static decimal? GetNullableDecimal(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.Number ? value.GetDecimal() : null;

    private static DateTimeOffset? GetNullableDateTimeOffset(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.String
            ? DateTimeOffset.Parse(value.GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal)
            : null;

    private sealed record FixtureDocument(
        DateTimeOffset ObservedAt,
        IReadOnlyList<FixtureRequestRow> Requests,
        IReadOnlyList<FixtureWaitingTaskRow> WaitingTasks,
        IReadOnlyList<FixtureMemoryGrantRow> MemoryGrants,
        FixtureTempdbUsage TempdbUsage,
        IReadOnlyList<FixtureFileIoRow> FileIo,
        IReadOnlyList<FixtureSchedulerRow> SchedulerPressure,
        FixtureLogSpaceRow LogSpace,
        FixtureServerIdentity ServerIdentity)
    {
        /// <summary>
        /// The sanitized stand-in for what the <c>sessions.lock_resource_objects</c> probe would
        /// return against a live catalog. Declaring it in the fixture keeps hobt resolution honest
        /// offline: nothing is inferred, the mapping is stated, and it flows through the same
        /// <see cref="LockResourceParser.Resolve"/> path connected mode uses.
        /// </summary>
        public IReadOnlyList<FixtureLockResolutionRow>? LockResourceResolutions { get; init; }
    }

    private sealed record FixtureLockResolutionRow(
        long HobtId,
        int ObjectId,
        int? IndexId,
        string? SchemaName,
        string? ObjectName,
        string? IndexName);

    private sealed record FixtureRequestRow(
        string RequestId,
        int SessionId,
        string? LoginName,
        string? HostName,
        string? ProgramName,
        string? SessionStatus,
        string? Status,
        string? Command,
        string? WaitType,
        long? WaitTimeMs,
        string? WaitResource,
        long? BlockingSessionId,
        DateTimeOffset? RequestStartTime,
        long? TotalElapsedMs,
        long? CpuTimeMs,
        long? Reads,
        long? Writes,
        long? LogicalReads,
        int? OpenTransactionCount,
        string? DatabaseId,
        string? BatchText,
        string? CurrentStatementText,
        string Availability,
        string? AvailabilityReason,
        string? PlanAvailability,
        string? PlanAvailabilityReason);

    private sealed record FixtureWaitingTaskRow(
        string TaskId,
        int SessionId,
        string ExecutionContext,
        string? WaitType,
        long WaitDurationMs,
        string? ResourceDescription,
        long? BlockingSessionId);

    private sealed record FixtureMemoryGrantRow(
        int SessionId,
        int? RequestId,
        int? SchedulerId,
        int? Dop,
        DateTimeOffset? RequestTime,
        DateTimeOffset? GrantTime,
        long? RequestedMemoryKb,
        long? GrantedMemoryKb,
        long? RequiredMemoryKb,
        long? UsedMemoryKb,
        long? MaxUsedMemoryKb,
        long? IdealMemoryKb,
        decimal? QueryCost,
        int? TimeoutSec,
        long? WaitTimeMs,
        string? BatchText);

    private sealed record FixtureTempdbUsage(
        IReadOnlyList<FixtureTempdbFileRow> Files,
        IReadOnlyList<FixtureTempdbSessionRow> Sessions,
        IReadOnlyList<FixtureTempdbTaskRow> Tasks);

    private sealed record FixtureTempdbFileRow(
        int DatabaseId, int FileId, decimal TotalMb, decimal AllocatedMb, decimal FreeMb,
        decimal VersionStoreMb, decimal UserObjectsMb, decimal InternalObjectsMb, decimal MixedExtentMb);

    private sealed record FixtureTempdbSessionRow(
        int SessionId, long UserObjectsAllocPageCount, long UserObjectsDeallocPageCount,
        long InternalObjectsAllocPageCount, long InternalObjectsDeallocPageCount);

    private sealed record FixtureTempdbTaskRow(
        int SessionId, int? RequestId, int ExecContextId, long UserObjectsAllocPageCount,
        long UserObjectsDeallocPageCount, long InternalObjectsAllocPageCount, long InternalObjectsDeallocPageCount);

    private sealed record FixtureFileIoRow(
        int DatabaseId, string? DatabaseName, int FileId, string? TypeDesc, long SampleMs,
        long NumOfReads, long NumOfBytesRead, long IoStallReadMs, long NumOfWrites, long NumOfBytesWritten,
        long IoStallWriteMs, long IoStall);

    private sealed record FixtureSchedulerRow(
        int SchedulerId, int CpuId, string? Status, bool IsOnline, bool IsIdle, int CurrentTasksCount,
        int RunnableTasksCount, int CurrentWorkersCount, int ActiveWorkersCount, int WorkQueueCount,
        int PendingDiskIoCount, int LoadFactor, long TotalCpuUsageMs, long TotalSchedulerDelayMs, int? IdealWorkersLimit);

    private sealed record FixtureLogSpaceRow(decimal TotalLogSizeMb, decimal UsedLogSpaceMb, decimal UsedLogSpacePercent);

    private sealed record FixtureServerIdentity(string ServerName, DateTimeOffset SqlServerStartTimeUtc);
}
