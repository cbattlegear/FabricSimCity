using SqlSimCity.Collection.Blocking;

namespace SqlSimCity.Collection.Probes;

/// <summary>
/// Source-neutral access to the live-incident probe set: current sessions/requests, waiting tasks,
/// blocking-graph input facts, memory grants, tempdb usage, cumulative file I/O counters, scheduler
/// pressure, and log space usage. Implemented by <see cref="SqlLiveIncidentProbeExecutor"/> (a real
/// <c>Microsoft.Data.SqlClient</c> connection) and by a deterministic fixture executor, so
/// <c>LiveIncidentCollector</c> and its tests never depend on which one is in use -- mirroring
/// <see cref="IProbeExecutor"/>'s role for capability negotiation. Every method may throw a
/// <see cref="ProbeExecutionException"/> subclass; the collector is responsible for degrading that
/// one subsystem to an explicit unavailable reason rather than failing the whole snapshot.
/// </summary>
public interface ILiveIncidentProbeExecutor
{
    Task<ServerIdentityResult> GetServerIdentityAsync(CancellationToken cancellationToken);

    Task<IReadOnlyList<ActiveRequestRow>> GetActiveRequestsAsync(CancellationToken cancellationToken);

    Task<IReadOnlyList<WaitingTaskFact>> GetWaitingTasksAsync(CancellationToken cancellationToken);

    Task<IReadOnlyList<BlockingInputFact>> GetBlockingInputsAsync(CancellationToken cancellationToken);

    Task<IReadOnlyList<MemoryGrantRow>> GetMemoryGrantsAsync(CancellationToken cancellationToken);

    /// <summary>Requires the caller's connection to be opened against tempdb (see sql/probes/tempdb/tempdb_usage.sql).</summary>
    Task<TempdbUsageRaw> GetTempdbUsageAsync(CancellationToken cancellationToken);

    /// <summary>
    /// <paramref name="azureScoped"/> selects <c>io.file_io_stats_current_db</c> (Azure SQL
    /// Database-safe) instead of the instance-wide <c>io.file_io_stats</c>.
    /// </summary>
    Task<IReadOnlyList<FileIoRow>> GetFileIoStatsAsync(bool azureScoped, CancellationToken cancellationToken);

    /// <summary><paramref name="includeIdealWorkersLimit"/> selects <c>scheduler.pressure_2019</c> over the SQL Server 2016-2018 base variant.</summary>
    Task<IReadOnlyList<SchedulerRow>> GetSchedulerPressureAsync(bool includeIdealWorkersLimit, CancellationToken cancellationToken);

    Task<LogSpaceRow?> GetLogSpaceUsageAsync(CancellationToken cancellationToken);
}
