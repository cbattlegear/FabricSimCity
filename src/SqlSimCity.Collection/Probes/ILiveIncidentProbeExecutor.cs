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

    /// <summary>
    /// Reads the plan cache's cumulative per-plan execution counters, which is the only way to learn
    /// about a query that has already finished.
    /// <para>
    /// This is the companion to <see cref="GetActiveRequestsAsync"/> rather than a variant of it.
    /// <c>sys.dm_exec_requests</c> holds a row only while a request is executing, so an OLTP
    /// statement taking a millisecond is invisible unless a sample lands inside that millisecond.
    /// Measured against the AdventureWorks churn workload, twelve samples 250 ms apart over one
    /// 3-second window caught 8 request rows in total while the plan cache recorded 364 executions
    /// over the same 3 seconds -- so live-request sampling observed roughly 2% of the work, and the
    /// rest was never sampled rather than absent.
    /// </para>
    /// <para>
    /// The returned counters are cumulative. A caller wanting "executions in the last interval" must
    /// difference them against its own previous observation, keyed on
    /// <see cref="CompletedQueryRow.PlanKey"/> and guarded by
    /// <see cref="CompletedQueryRow.CreationTime"/>; the row itself never carries an interval count.
    /// </para>
    /// </summary>
    /// <param name="sinceEngineLocal">
    /// The <see cref="CompletedQueryRow.SampledAtEngineLocal"/> value from the previous call, which
    /// bounds how much of the plan cache is returned. Null returns every cached plan and is what a
    /// first call wants. This must be an engine-local instant carried back from a previous row and
    /// never the collector's own clock: a watermark from a process in a different time zone, or with
    /// a drifted clock, silently filters out executions that really happened.
    /// </param>
    /// <param name="maxRows">Cap on rows returned, most recently executed first. Null returns every matching row; the pre-cap count always travels with the result.</param>
    /// <param name="includeSqlText">Whether to resolve statement and batch text. Edge collection passes false so raw SQL is never fetched.</param>
    /// <param name="maxTextLength">Cap on returned text length. The untruncated lengths always travel with the result.</param>
    Task<IReadOnlyList<CompletedQueryRow>> GetCompletedQueriesAsync(
        DateTimeOffset? sinceEngineLocal,
        int? maxRows,
        bool includeSqlText,
        int? maxTextLength,
        CancellationToken cancellationToken);

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
