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

    /// <summary>
    /// Reads tempdb-scoped file/session/task usage. <paramref name="azureScoped"/> is rejected:
    /// Azure SQL Database cannot open a tempdb connection, and these DMVs are tempdb-only.
    /// </summary>
    Task<TempdbUsageRaw> GetTempdbUsageAsync(bool azureScoped, CancellationToken cancellationToken);

    /// <summary>
    /// <paramref name="azureScoped"/> selects <c>io.file_io_stats_current_db</c> (Azure SQL
    /// Database-safe) instead of the instance-wide <c>io.file_io_stats</c>.
    /// </summary>
    Task<IReadOnlyList<FileIoRow>> GetFileIoStatsAsync(bool azureScoped, CancellationToken cancellationToken);

    /// <summary><paramref name="includeIdealWorkersLimit"/> selects <c>scheduler.pressure_2019</c> over the SQL Server 2016-2018 base variant.</summary>
    Task<IReadOnlyList<SchedulerRow>> GetSchedulerPressureAsync(bool includeIdealWorkersLimit, CancellationToken cancellationToken);

    Task<LogSpaceRow?> GetLogSpaceUsageAsync(CancellationToken cancellationToken);

    /// <summary>
    /// Reads deadlocks recorded by the <c>system_health</c> Extended Events session.
    /// <para>
    /// This probe is server-scoped and reads the session's event files, which costs roughly a
    /// second on an ordinary instance. It is deliberately not on the sampler's per-cycle path; the
    /// collector refreshes it on its own slower interval and reuses the sample in between.
    /// </para>
    /// <para>
    /// <paramref name="azureScoped"/> is rejected. Azure SQL Database has no <c>system_health</c>
    /// session and no server-scoped Extended Events views, so there is nothing to degrade to -- the
    /// collector must report this as <c>Unsupported</c>, which is not the same as an empty list.
    /// </para>
    /// </summary>
    /// <param name="sinceUtc">
    /// When supplied, only deadlocks recorded strictly after this instant are returned. This
    /// filters the result; the session's files are read either way.
    /// </param>
    /// <param name="maxGraphs">Cap on graphs returned, most recent first. Null returns everything retained.</param>
    /// <param name="includeSqlText">Whether to ask for the graph with participant statement text included.</param>
    Task<IReadOnlyList<DeadlockGraphRow>> GetDeadlockGraphsAsync(
        bool azureScoped,
        DateTimeOffset? sinceUtc,
        int? maxGraphs,
        bool includeSqlText,
        CancellationToken cancellationToken);
}
