using SqlSimCity.Collection.Blocking;
using SqlSimCity.Collection.Probes;

namespace SqlSimCity.Collection.Tests.LiveIncidents;

/// <summary>
/// A fully scriptable <see cref="ILiveIncidentProbeExecutor"/> test double: every method can be
/// made to return a fixed value or throw a fixed <see cref="ProbeExecutionException"/>, and calls
/// are counted so a test can assert exactly how many cycles ran.
/// </summary>
public sealed class FakeLiveIncidentProbeExecutor : ILiveIncidentProbeExecutor
{
    public Func<CancellationToken, Task<ServerIdentityResult>>? ServerIdentity { get; set; }
    public Func<CancellationToken, Task<IReadOnlyList<ActiveRequestRow>>>? ActiveRequests { get; set; }
    public Func<CancellationToken, Task<IReadOnlyList<WaitingTaskFact>>>? WaitingTasks { get; set; }
    public Func<CancellationToken, Task<IReadOnlyList<BlockingInputFact>>>? BlockingInputs { get; set; }
    public Func<CancellationToken, Task<IReadOnlyList<MemoryGrantRow>>>? MemoryGrants { get; set; }

    /// <summary>
    /// Hook for <c>sessions.completed_query_stats</c>. The watermark argument is surfaced because it
    /// is the one the collector must NOT advance after a failed read -- a test that cannot see what
    /// was asked for cannot tell a retained watermark from a discarded interval.
    /// </summary>
    public Func<DateTimeOffset?, int?, bool, int?, CancellationToken, Task<IReadOnlyList<CompletedQueryRow>>>? CompletedQueries { get; set; }

    /// <summary>The watermark passed on the most recent completed-query call, or null if never called.</summary>
    public DateTimeOffset? LastCompletedQueryWatermark { get; private set; }

    public int CompletedQueriesCallCount { get; private set; }
    public Func<bool, CancellationToken, Task<TempdbUsageRaw>>? TempdbUsage { get; set; }
    public Func<bool, CancellationToken, Task<IReadOnlyList<FileIoRow>>>? FileIoStats { get; set; }
    public Func<bool, CancellationToken, Task<IReadOnlyList<SchedulerRow>>>? SchedulerPressure { get; set; }
    public Func<CancellationToken, Task<LogSpaceRow?>>? LogSpaceUsage { get; set; }

    /// <summary>
    /// Hook for <c>sessions.deadlock_graphs</c>. The arguments are surfaced so a test can assert
    /// what the collector actually asked for -- in particular that it is not requesting statement
    /// text by default, and that it applies the configured graph cap.
    /// </summary>
    public Func<bool, DateTimeOffset?, int?, bool, CancellationToken, Task<IReadOnlyList<DeadlockGraphRow>>>? DeadlockGraphs { get; set; }

    /// <summary>
    /// How many times the deadlock probe was actually invoked. The collector reuses one sample
    /// across cycles, so this is what distinguishes "reused" from "re-read" -- a count equal to the
    /// cycle count means the refresh interval is not being honoured.
    /// </summary>
    public int DeadlockGraphsCallCount { get; private set; }

    public int ActiveRequestsCallCount { get; private set; }

    public static ServerIdentityResult DefaultIdentity(DateTimeOffset startTime, int engineEdition = 2) => new(
        "fake-server", "16.0.1000.6", "RTM", "Developer Edition", engineEdition, false, CpuCount: 4, SchedulerCount: 4, PhysicalMemoryMb: 16_384, SqlServerStartTime: startTime);

    public Task<ServerIdentityResult> GetServerIdentityAsync(CancellationToken cancellationToken) =>
        (ServerIdentity ?? (_ => Task.FromResult(DefaultIdentity(DateTimeOffset.UnixEpoch))))(cancellationToken);

    public Task<IReadOnlyList<ActiveRequestRow>> GetActiveRequestsAsync(CancellationToken cancellationToken)
    {
        ActiveRequestsCallCount++;
        return (ActiveRequests ?? (_ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>([])))(cancellationToken);
    }

    public Task<IReadOnlyList<CompletedQueryRow>> GetCompletedQueriesAsync(
        DateTimeOffset? sinceEngineLocal, int? maxRows, bool includeSqlText, int? maxTextLength, CancellationToken cancellationToken)
    {
        CompletedQueriesCallCount++;
        LastCompletedQueryWatermark = sinceEngineLocal;
        return (CompletedQueries ?? ((_, _, _, _, _) => Task.FromResult<IReadOnlyList<CompletedQueryRow>>([])))(
            sinceEngineLocal, maxRows, includeSqlText, maxTextLength, cancellationToken);
    }

    public Task<IReadOnlyList<WaitingTaskFact>> GetWaitingTasksAsync(CancellationToken cancellationToken) =>        (WaitingTasks ?? (_ => Task.FromResult<IReadOnlyList<WaitingTaskFact>>([])))(cancellationToken);

    public Task<IReadOnlyList<BlockingInputFact>> GetBlockingInputsAsync(CancellationToken cancellationToken) =>
        (BlockingInputs ?? (_ => Task.FromResult<IReadOnlyList<BlockingInputFact>>([])))(cancellationToken);

    public Task<IReadOnlyList<MemoryGrantRow>> GetMemoryGrantsAsync(CancellationToken cancellationToken) =>
        (MemoryGrants ?? (_ => Task.FromResult<IReadOnlyList<MemoryGrantRow>>([])))(cancellationToken);

    public Task<TempdbUsageRaw> GetTempdbUsageAsync(bool azureScoped, CancellationToken cancellationToken) =>
        (TempdbUsage ?? ((_, _) => Task.FromResult(new TempdbUsageRaw([], [], []))))(azureScoped, cancellationToken);

    public Task<IReadOnlyList<FileIoRow>> GetFileIoStatsAsync(bool azureScoped, CancellationToken cancellationToken) =>
        (FileIoStats ?? ((_, _) => Task.FromResult<IReadOnlyList<FileIoRow>>([])))(azureScoped, cancellationToken);

    public Task<IReadOnlyList<SchedulerRow>> GetSchedulerPressureAsync(bool includeIdealWorkersLimit, CancellationToken cancellationToken) =>
        (SchedulerPressure ?? ((_, _) => Task.FromResult<IReadOnlyList<SchedulerRow>>([])))(includeIdealWorkersLimit, cancellationToken);

    public Task<LogSpaceRow?> GetLogSpaceUsageAsync(CancellationToken cancellationToken) =>
        (LogSpaceUsage ?? (_ => Task.FromResult<LogSpaceRow?>(null)))(cancellationToken);

    public Task<IReadOnlyList<DeadlockGraphRow>> GetDeadlockGraphsAsync(
        bool azureScoped,
        DateTimeOffset? sinceUtc,
        int? maxGraphs,
        bool includeSqlText,
        CancellationToken cancellationToken)
    {
        DeadlockGraphsCallCount++;
        return (DeadlockGraphs ?? ((_, _, _, _, _) => Task.FromResult<IReadOnlyList<DeadlockGraphRow>>([])))(
            azureScoped, sinceUtc, maxGraphs, includeSqlText, cancellationToken);
    }
}
