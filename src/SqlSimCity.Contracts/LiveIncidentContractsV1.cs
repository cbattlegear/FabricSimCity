namespace SqlSimCity.Contracts.V1;

/// <summary>
/// Coarse availability of one sampled artifact (a request row, a plan lookup, a whole subsystem
/// sample) -- distinct from <see cref="DataStatus"/>, which describes freshness/permission of an
/// entire evidence stream rather than whether one specific row was still present.
/// <see cref="Stale"/> is a request row carried forward from a previous cycle because this
/// cycle's own <c>sessions.active_requests</c> probe failed outright -- a probe failure is never
/// evidence that the request disappeared, so it must not be reported as <see cref="Available"/>
/// in a snapshot whose own timestamps say the data is fresh, nor silently reclassified as
/// <see cref="Disappeared"/> (requirement 6).
/// </summary>
public enum SampleAvailability { Available, Disappeared, Unavailable, Stale }

/// <summary>
/// The four documented negative <c>sys.dm_exec_requests.blocking_session_id</c> /
/// <c>sys.dm_os_waiting_tasks.blocking_session_id</c> sentinel values. SqlSimCity never coerces
/// these to zero or null, and -5 (untracked latch owner) is never itself reported as a blocking
/// problem -- see sql/probes/sessions/waiting_tasks.sql and sql/README.md.
/// </summary>
public enum BlockingSentinelKind
{
    None,
    OrphanedDistributedTransaction, // -2
    DeferredRecoveryTransaction,    // -3
    IndeterminateLatchOwner,        // -4
    UntrackedLatchOwner,            // -5 -- commonly benign; not a blocker problem by itself
}

/// <summary>What one node in a <see cref="BlockingGraphV1"/> represents.</summary>
public enum BlockingNodeKind { Session, Sentinel }

/// <summary>Whether a waiting task is the coordinator (serial) task or a parallel worker task of a request.</summary>
public enum ExecutionContextKind { Coordinator, Worker }

/// <summary>
/// Whether a request's execution plan was collected. SqlSimCity's live sampling path is
/// deliberately lazy about plan XML (see requirement 6): ordinary sampled requests carry
/// <see cref="NotRequested"/>, because no plan lookup was attempted at all. <see cref="Unavailable"/>
/// models a separate, explicit lazy plan lookup that was attempted and denied/failed.
/// </summary>
public enum PlanCollectionState { NotRequested, Available, Unavailable }

/// <summary>
/// The outcome of comparing one cumulative counter sample against the immediately preceding one
/// for the same target/epoch (see requirement 5). A counter regression or an engine restart always
/// starts a new epoch and never yields a fabricated negative or zero rate.
/// </summary>
public enum CounterEpochState { FirstSample, Delta, EpochReset }

/// <summary>Run state of the background <c>LiveIncidentSampler</c> loop.</summary>
public enum SamplerRunState { Running, Paused, Stopped, Reconnecting }

/// <summary>
/// The lock-resource form named by <c>wait_resource</c> / <c>resource_description</c>. Parsed from
/// the verbatim text only -- an unrecognised prefix stays <see cref="Unrecognized"/> rather than
/// being coerced into a plausible-looking kind.
/// </summary>
public enum LockResourceKind
{
    None,
    Key,

    // CA1720: 'Object' is SQL Server's own name for this lock resource type (OBJECT: db:objectid),
    // and the wire value is consumed as the literal string "Object". Renaming it would misreport
    // the engine's vocabulary, so the rule is suppressed here rather than the name changed.
#pragma warning disable CA1720
    Object,
#pragma warning restore CA1720
    Page,
    Rid,
    HoBt,
    Table,
    Extent,
    File,
    Application,
    Metadata,
    Database,
    AllocationUnit,

    /// <summary>
    /// An <c>XACT</c> lock: a lock taken on a transaction id (TID) rather than on any row, key or
    /// object. Introduced by optimized locking (SQL Server 2025 / Azure SQL Database, Managed
    /// Instance and Fabric SQL), where a writer holds one <c>X</c> lock on its own TID for the life
    /// of the transaction and waiters queue on that TID with an <c>S</c> lock, instead of each row
    /// or key lock being held to commit.
    /// </summary>
    Transaction,
    Unrecognized,
}

/// <summary>
/// How far a lock resource could be traced to a user object.
/// <see cref="Resolved"/> means an object id is known (either stated directly in the resource text
/// or looked up from a <c>hobt_id</c>); <see cref="RequiresLookup"/> means the resource names a
/// hobt/allocation unit that the bounded lookup did not cover; <see cref="NotObjectScoped"/> means
/// the lock is genuinely not on a user object (a database, file, or application lock);
/// <see cref="Unresolvable"/> means resolution would need a cost we refuse to pay in a realtime
/// probe (a page or row id needs an allocation scan). None of these are ever guessed.
/// </summary>
public enum LockResolutionStatus
{
    Resolved,
    RequiresLookup,
    NotObjectScoped,
    Unresolvable,
    Unrecognized,
}

/// <summary>
/// A parsed (and, where cheap and safe, resolved) lock resource. Optional throughout the live
/// contracts: it is emitted only once the lock-resource probe has run, so a consumer must treat its
/// absence as "not claimed" rather than "no lock". <see cref="RawResource"/> always preserves the
/// engine's own text so the parse can be audited.
/// </summary>
public sealed record LockResourceV1(
    string RawResource,
    LockResourceKind Kind,
    int? DatabaseId,
    int? ObjectId,
    int? IndexId,
    string? SchemaName,
    string? ObjectName,
    string? IndexName,
    LockResolutionStatus Status,
    string Reason)
{
    /// <summary>The <c>hobt_id</c> named by a KEY/HOBT/PAGE-style resource, when the text carries one.</summary>
    public long? HobtId { get; init; }

    /// <summary>
    /// The transaction id (TID) named by an <c>XACT</c> resource under optimized locking. Preserved
    /// because it is the one identifier such a wait does carry: it joins to
    /// <c>sys.dm_tran_locks.request_owner_id</c> and to the blocker's own transaction, which is how
    /// a reader gets from the wait to the statement responsible for it.
    /// </summary>
    public long? TransactionId { get; init; }
}

/// <summary>One waiting task, or one blocked/blocking request, preserving <c>blocking_session_id</c> verbatim plus its decoded sentinel meaning.</summary>
public sealed record BlockingReferenceV1(long? BlockingSessionId, BlockingSentinelKind Sentinel)
{
    public static BlockingReferenceV1 FromRaw(long? rawBlockingSessionId) => rawBlockingSessionId switch
    {
        null or 0 => new BlockingReferenceV1(rawBlockingSessionId, BlockingSentinelKind.None),
        -2 => new BlockingReferenceV1(rawBlockingSessionId, BlockingSentinelKind.OrphanedDistributedTransaction),
        -3 => new BlockingReferenceV1(rawBlockingSessionId, BlockingSentinelKind.DeferredRecoveryTransaction),
        -4 => new BlockingReferenceV1(rawBlockingSessionId, BlockingSentinelKind.IndeterminateLatchOwner),
        -5 => new BlockingReferenceV1(rawBlockingSessionId, BlockingSentinelKind.UntrackedLatchOwner),
        _ => new BlockingReferenceV1(rawBlockingSessionId, BlockingSentinelKind.None),
    };
}

/// <summary>
/// What a text length cap omitted from one sampled row. Present only when a cap actually shortened
/// something, and never a substitute for the text itself: <see cref="TotalCharacters"/> is the
/// untruncated length the engine reported, so a reader can always tell "4,096 characters of a
/// 1,048,576-character batch" from "a 4,096-character batch".
/// <para>
/// The cap exists because batch text is unbounded by anything SqlSimCity controls and is the
/// dominant cost of a live snapshot -- see <c>sql/probes/sessions/active_requests.sql</c> for the
/// measurements. Truncating without saying so would trade a bandwidth problem for an
/// evidence-honesty one, which is why this record travels with the row rather than the cap being
/// applied silently.
/// </para>
/// </summary>
public sealed record LiveTextTruncationV1(
    int RetainedCharacters,
    int TotalCharacters,
    string Reason);

/// <summary>
/// What a row cap omitted from one sampled collection. Present only when the cap actually cut rows.
/// <see cref="TotalRows"/> is the count that matched before the cap, so a bounded sample is never
/// mistaken for a smaller server -- "5,009 sessions, showing 1,000" stays distinguishable from
/// "1,000 sessions".
/// </summary>
public sealed record SampleTruncationV1(
    string Field,
    int ReturnedRows,
    int TotalRows,
    string Reason);

/// <summary>
/// One sampled live session/request from <c>sessions.active_requests</c>. Every bigint counter
/// (reads/writes/logical reads) is a lossless base-10 string, never a narrowed numeric type.
/// <see cref="Availability"/>/<see cref="AvailabilityReason"/> record when a previously-seen
/// request has disappeared between polling cycles (it completed or was killed) rather than
/// silently omitting the row -- see requirement 6's short-lived-query disclosure.
/// <para>
/// Sampling includes idle sessions on purpose, so a row here is not necessarily a request. A row
/// with a null <see cref="RequestStatus"/> is an idle session that holds no request at all, and is
/// never a request whose state went unreported; see that member for why the distinction has to
/// survive.
/// </para>
/// </summary>
public sealed record LiveRequestV1(
    string RequestId,
    int SessionId,
    string? LoginName,
    string? HostName,
    string? ProgramName,
    string? SessionStatus,
    /// <summary>
    /// <c>sys.dm_exec_requests.status</c>, passed through verbatim, or null when this row is an idle
    /// session with no request. That column is never null for a request that exists, so null here is
    /// positive evidence of "no request" rather than "a request in some unreported state" -- which is
    /// what lets a consumer count running requests without counting idle connections. Never
    /// substitute a synthetic value such as "idle": doing so made every idle pooled connection read
    /// as a running request in atlas activity (issue #79). Idleness remains readable from
    /// <see cref="RequestId"/> (<c>req:&lt;session&gt;:idle</c>) and <see cref="SessionStatus"/>.
    /// </summary>
    string? RequestStatus,
    string? Command,
    string? WaitType,
    long? WaitTimeMs,
    string? WaitResource,
    BlockingReferenceV1 Blocking,
    DateTimeOffset? RequestStartTime,
    long? TotalElapsedMs,
    long? CpuTimeMs,
    string? Reads,
    string? Writes,
    string? LogicalReads8KiBPages,
    int? OpenTransactionCount,
    string? DatabaseId,
    string? DatabaseName,
    string? CurrentStatementText,
    string? BatchText,
    SampleAvailability Availability,
    string? AvailabilityReason,
    PlanCollectionState PlanState,
    string? PlanReason)
{
    /// <summary>
    /// The parsed/resolved form of <see cref="WaitResource"/>. Null when the lock-resource probe did
    /// not run, so consumers must not read null as "this request holds no lock".
    /// </summary>
    public LockResourceV1? LockResource { get; init; }

    /// <summary>
    /// What a text length cap removed from <see cref="BatchText"/>, or null when it was returned
    /// whole. Null therefore means "this is the entire batch", which is exactly the claim a silent
    /// truncation would have made falsely.
    /// </summary>
    public LiveTextTruncationV1? BatchTextTruncation { get; init; }

    /// <summary>
    /// What a text length cap removed from <see cref="CurrentStatementText"/>, or null when it was
    /// returned whole. Tracked separately from <see cref="BatchTextTruncation"/> because a short
    /// statement inside a very long batch is truncated in the batch and not in the statement.
    /// </summary>
    public LiveTextTruncationV1? CurrentStatementTextTruncation { get; init; }

    /// <summary>
    /// <c>sys.dm_exec_requests.query_hash</c>, rendered with <see cref="Convert.ToHexString(byte[])"/>
    /// — uppercase hex, no <c>0x</c> prefix. This is the same value Query Store publishes as
    /// <c>DatabaseCityQueryFamilyV1.QueryHash</c>, and it is deliberately produced by the same
    /// converter on both sides: the two are joined by string equality, so a difference in case or
    /// prefix would match nothing and be indistinguishable from an instance where nothing is running.
    /// <para>
    /// Null means this row carries no request, or the engine reported no hash for it. It never means
    /// "unknown query", and a consumer must not fall back to matching on statement text. An all-zero
    /// hash is normalized to null here for the same reason: zero is the engine's "not hashed", not a
    /// family whose hash happens to be zero, and letting it through would collide every unhashed
    /// request onto one family.
    /// </para>
    /// </summary>
    public string? QueryHash { get; init; }

    /// <summary>
    /// <c>sys.dm_exec_requests.query_plan_hash</c>, rendered exactly as <see cref="QueryHash"/> is.
    /// Joins to <c>sys.query_store_plan.query_plan_hash</c>, so it distinguishes which plan for a
    /// query family is running, not just which family. Same null and all-zero semantics.
    /// </summary>
    public string? QueryPlanHash { get; init; }
}

/// <summary>
/// One row of the current wait queue from <c>sessions.waiting_tasks</c>, preserving
/// <c>exec_context_id</c> so a request's parallel worker waits are never collapsed to a single
/// coordinator wait (requirement 4).
/// </summary>
public sealed record WaitingTaskV1(
    string TaskId,
    int SessionId,
    ExecutionContextKind ExecutionContext,
    int ExecContextId,
    string? WaitType,
    string WaitDurationMs,
    string? ResourceDescription,
    BlockingReferenceV1 Blocking)
{
    /// <summary>
    /// The parsed/resolved form of <see cref="ResourceDescription"/>. Null when the lock-resource
    /// probe did not run.
    /// </summary>
    public LockResourceV1? LockResource { get; init; }
}

/// <summary>One node in the reconstructed blocking graph: a real session, or an external/indeterminate sentinel "owner".</summary>
public sealed record BlockingNodeV1(
    string NodeId,
    BlockingNodeKind Kind,
    int? SessionId,
    BlockingSentinelKind Sentinel,
    bool IsRoot,
    bool IsIdleWithOpenTransaction,
    bool InCycle,
    int DirectlyBlockedCount);

/// <summary>One directed edge: <see cref="FromNodeId"/> (blocked) waits on <see cref="ToNodeId"/> (blocker).</summary>
public sealed record BlockingEdgeV1(
    string EdgeId,
    string FromNodeId,
    string ToNodeId,
    string? WaitType,
    string? WaitDurationMs,
    ExecutionContextKind? ExecutionContext,
    int? ExecContextId);

/// <summary>
/// A durable, documented summary of the graph. This is a convenience rollup only -- every parallel
/// waiting task is still present individually in <see cref="BlockingGraphV1.Edges"/> and
/// <see cref="LiveIncidentSnapshotV1.WaitingTasks"/>; this summary never substitutes for that
/// per-task detail (requirement 4).
/// </summary>
public sealed record BlockingGraphSummaryV1(
    int BlockedSessionCount,
    int RootBlockerCount,
    int SentinelRootCount,
    int CycleCount,
    int ParallelWaitTaskCount,
    string Note);

/// <summary>
/// The reconstructed blocking graph for one sample. Built entirely by the application from
/// <c>sessions.blocking_inputs</c> and <c>sessions.waiting_tasks</c> raw facts -- the probes
/// themselves never compute a root or a graph (see their own headers).
/// </summary>
public sealed record BlockingGraphV1(
    IReadOnlyList<BlockingNodeV1> Nodes,
    IReadOnlyList<BlockingEdgeV1> Edges,
    IReadOnlyList<string> RootNodeIds,
    IReadOnlyList<IReadOnlyList<string>> Cycles,
    BlockingGraphSummaryV1 Summary);

/// <summary>
/// One row of <c>sessions.memory_grants</c>. <see cref="IsWaitingForGrant"/> is
/// <c>grant_time IS NULL</c>, the authoritative "still waiting" signal; <see cref="WaitTimeMs"/> has
/// the inverted null-timing documented on the probe (populated only while waiting).
/// </summary>
public sealed record MemoryGrantV1(
    int SessionId,
    int? RequestId,
    int? SchedulerId,
    int? Dop,
    DateTimeOffset? RequestTime,
    DateTimeOffset? GrantTime,
    bool IsWaitingForGrant,
    string? RequestedKb,
    string? GrantedKb,
    string? RequiredKb,
    string? UsedKb,
    string? MaxUsedKb,
    string? IdealKb,
    decimal? QueryCost,
    int? TimeoutSec,
    string? WaitTimeMs,
    string? BatchText);

public sealed record TempdbFileUsageV1(
    int FileId,
    decimal TotalMb,
    decimal AllocatedMb,
    decimal FreeMb,
    decimal VersionStoreMb,
    decimal UserObjectsMb,
    decimal InternalObjectsMb,
    decimal MixedExtentMb);

public sealed record TempdbSessionUsageV1(
    int SessionId,
    string UserObjectsAllocPageCount,
    string UserObjectsDeallocPageCount,
    string InternalObjectsAllocPageCount,
    string InternalObjectsDeallocPageCount);

public sealed record TempdbTaskUsageV1(
    int SessionId,
    int? RequestId,
    int ExecContextId,
    string UserObjectsAllocPageCount,
    string UserObjectsDeallocPageCount,
    string InternalObjectsAllocPageCount,
    string InternalObjectsDeallocPageCount);

/// <summary>
/// tempdb space usage. Requires the correct tempdb connection context (see
/// sql/probes/tempdb/tempdb_usage.sql); on Azure SQL Database this is the database's own private
/// tempdb, a supported path distinct from server-wide tempdb visibility.
/// </summary>
public sealed record TempdbUsageV1(
    IReadOnlyList<TempdbFileUsageV1> Files,
    IReadOnlyList<TempdbSessionUsageV1> Sessions,
    IReadOnlyList<TempdbTaskUsageV1> Tasks,
    DataStatus Status,
    string Reason);

/// <summary>
/// One counter's delta result across the immediately preceding sample and this one. A regression
/// or an engine restart between samples always yields <see cref="CounterEpochState.EpochReset"/>
/// with a null delta/rate rather than a fabricated negative or zero throughput (requirement 5).
/// </summary>
public sealed record CounterDeltaV1(CounterEpochState State, string? DeltaValue, decimal? RatePerSecond, string Reason);

/// <summary>
/// Per-file cumulative I/O counter deltas from <c>io.file_io_stats</c> /
/// <c>io.file_io_stats_current_db</c>. <see cref="EpochId"/> increments every time an engine
/// restart or counter regression is detected for this file, so a UI/consumer can tell "no rate yet"
/// apart from "the engine just restarted".
/// </summary>
public sealed record FileIoDeltaV1(
    int DatabaseId,
    string? DatabaseName,
    int FileId,
    string? TypeDesc,
    long EpochId,
    decimal? SampleWindowMs,
    CounterDeltaV1 ReadsDelta,
    CounterDeltaV1 BytesReadDelta,
    CounterDeltaV1 IoStallReadMsDelta,
    CounterDeltaV1 WritesDelta,
    CounterDeltaV1 BytesWrittenDelta,
    CounterDeltaV1 IoStallWriteMsDelta);

public sealed record FileIoSampleV1(IReadOnlyList<FileIoDeltaV1> Files, DataStatus Status, string Reason);

/// <summary>
/// One participant in a recorded deadlock, projected from a <c>&lt;process&gt;</c> element of the
/// graph. Every field here comes from an attribute, which is why the collector can offer a graph
/// with statement text removed and still describe the deadlock completely: the engine puts the
/// batch text in child elements and everything else in attributes.
/// <para>
/// <see cref="Id"/> is the graph-internal process identifier (for example <c>process21c43b4d088</c>)
/// and is the only thing the resource list's owner/waiter entries refer to, so it is what joins a
/// participant to what it held and what it wanted. It is unique within one graph and meaningless
/// outside it -- never store it as a session identity.
/// </para>
/// </summary>
public sealed record DeadlockProcessV1(
    string Id,
    int? SessionId,
    bool IsVictim,
    int? DatabaseId,
    string? DatabaseName,
    string? LockMode,
    string? WaitResource,
    long? WaitTimeMs,
    string? TransactionName,
    string? IsolationLevel,
    string? ClientApplication,
    string? HostName,
    string? LoginName,
    string? Statement);

/// <summary>
/// One resource in a recorded deadlock's <c>&lt;resource-list&gt;</c>, with the participants that
/// held it and the participants that were waiting for it.
/// <para>
/// <see cref="ResourceKind"/> is the element name the engine chose -- <c>keylock</c>,
/// <c>objectlock</c>, <c>pagelock</c>, <c>ridlock</c>, <c>exchangeEvent</c> and others -- and it is
/// carried through verbatim rather than mapped onto a closed enumeration, because the set is the
/// engine's to extend and an unrecognised kind must still be reportable. A consumer that cannot
/// render a kind should say so, not drop the resource.
/// </para>
/// <para>
/// <see cref="ObjectName"/> is present for the lock kinds that name an object and absent for the
/// ones that do not (an <c>exchangeEvent</c> is a parallelism resource inside one query and names
/// nothing). Absent means "this resource kind has no object", never "the object is unknown".
/// </para>
/// </summary>
public sealed record DeadlockResourceV1(
    string ResourceKind,
    int? DatabaseId,
    string? ObjectName,
    string? IndexName,
    long? AssociatedObjectId,
    IReadOnlyList<DeadlockParticipantV1> Owners,
    IReadOnlyList<DeadlockParticipantV1> Waiters);

/// <summary>
/// A reference from a resource to one of the graph's processes, with the lock mode involved.
/// <see cref="ProcessId"/> matches <see cref="DeadlockProcessV1.Id"/> within the same graph.
/// </summary>
public sealed record DeadlockParticipantV1(string ProcessId, string? Mode, string? RequestType);

/// <summary>
/// One deadlock the engine already resolved and recorded, read back from the <c>system_health</c>
/// session. A deadlock is only ever historical: by the time anything can query for it the victim
/// has been rolled back and nothing about it remains in <c>sys.dm_exec_requests</c> or
/// <c>sys.dm_os_waiting_tasks</c>. This is not a live measurement and must not be rendered as one --
/// <see cref="OccurredAt"/> is when it happened, which may be minutes or hours before the snapshot
/// carrying it.
/// <para>
/// <see cref="Id"/> is stable for a given deadlock across calls, and across whether statement text
/// was requested, so a consumer can deduplicate a deadlock that appears in several consecutive
/// snapshots. It is derived from the event timestamp and a hash of the graph's redacted form; see
/// <c>sql/probes/sessions/deadlock_graphs.sql</c>.
/// </para>
/// <para>
/// <see cref="IncludesSqlText"/> reports what the graph actually contained, not what was asked for,
/// so a consumer never renders an empty statement as "this participant ran nothing".
/// </para>
/// </summary>
public sealed record DeadlockGraphV1(
    string Id,
    DateTimeOffset OccurredAt,
    IReadOnlyList<DeadlockProcessV1> Processes,
    IReadOnlyList<DeadlockResourceV1> Resources,
    IReadOnlyList<string> VictimProcessIds,
    bool IncludesSqlText);

/// <summary>
/// Deadlocks recorded by the <c>system_health</c> session, with the observation window disclosed.
/// <para>
/// An empty <see cref="Graphs"/> with <see cref="DataStatus.Available"/> means "no deadlock is
/// retained in the window that was read". It does not mean the instance has no deadlocks:
/// <c>system_health</c> rolls its event files over, so an older deadlock is simply gone.
/// <see cref="DataStatus.Unsupported"/> means deadlocks are not observed here at all -- Azure SQL
/// Database has no <c>system_health</c> session -- and the two are never conflated.
/// </para>
/// <para>
/// <see cref="CollectedAt"/> is when this sample was read, which is deliberately not the snapshot's
/// own <c>CollectedAt</c>. Reading the session's files costs roughly a second, far too much for the
/// sampler's 2-5 second cycle, so the sample is refreshed on its own slower interval and reused in
/// between. A consumer showing deadlock age must use this, not the snapshot timestamp.
/// </para>
/// <para>
/// <see cref="TotalRetainedCount"/> is the number of deadlocks the probe saw before any cap was
/// applied, so a capped list is never read as a calmer instance.
/// </para>
/// </summary>
public sealed record DeadlockSampleV1(
    IReadOnlyList<DeadlockGraphV1> Graphs,
    int TotalRetainedCount,
    DateTimeOffset? CollectedAt,
    DataStatus Status,
    string Reason);

/// <summary>
/// One query family that executed during the interval between two samples, learned from the plan
/// cache's cumulative counters rather than from a live request.
/// <para>
/// This is the other half of what the live feed knows, and it exists because
/// <see cref="LiveRequestV1"/> structurally cannot see a short query:
/// <c>sys.dm_exec_requests</c> holds a row only while a request is executing, so an OLTP statement
/// taking a millisecond is invisible unless a sample lands inside it. Measured against the
/// AdventureWorks churn workload, twelve samples 250 ms apart over one 3-second window caught 8
/// request rows in total while the plan cache recorded 364 executions over the same 3 seconds.
/// </para>
/// <para>
/// <see cref="Executions"/> is a count for an <em>interval</em>, obtained by differencing the plan's
/// cumulative counter against the previous sample. It is not a cumulative total and must never be
/// rendered as one: "ran 4 times" here means four times since the last sample, roughly the last few
/// seconds, not four times ever.
/// </para>
/// <para>
/// The per-execution figures are the engine's <c>last_*</c> columns, which describe the single most
/// recent execution. They are deliberately not averages over <see cref="Executions"/>: a plan's
/// lifetime average is not a description of the execution that just happened, and dividing a
/// cumulative total by an interval count would mix two different windows into one number that
/// describes neither.
/// </para>
/// <para>
/// <see cref="FirstObservation"/> is true when this plan had no previous sample to difference
/// against, in which case <see cref="Executions"/> is 1 -- the floor the evidence supports, since the
/// plan's last execution fell inside the interval, and never the plan's whole cumulative count, which
/// on a hot plan is six figures of history that did not happen just now.
/// </para>
/// </summary>
public sealed record CompletedQueryV1(
    /// <summary>Identity of one statement within one cached plan; stable across samples so a consumer can recognise the same query returning.</summary>
    string PlanKey,
    /// <summary>Executions observed in the interval between the previous sample and this one. Never a cumulative total.</summary>
    long Executions,
    /// <summary>True when no previous observation existed to difference against, so <see cref="Executions"/> is the evidenced floor of 1 rather than a measured count.</summary>
    bool FirstObservation,
    /// <summary>When the engine last ran this plan, on its own local clock.</summary>
    DateTimeOffset? LastExecutionAt,
    /// <summary>The most recent execution's elapsed time in microseconds. Not an average.</summary>
    long LastElapsedTimeUs,
    /// <summary>The most recent execution's CPU time in microseconds. Not an average.</summary>
    long LastWorkerTimeUs,
    /// <summary>The most recent execution's logical reads, in 8-KiB pages.</summary>
    long LastLogicalReads,
    /// <summary>Rows returned or affected by the most recent execution.</summary>
    long LastRows,
    int? DatabaseId,
    string? DatabaseName,
    /// <summary>The statement these counters belong to, or the batch when no statement was isolated. Null when text was not collected.</summary>
    string? StatementText,
    /// <summary><c>query_hash</c> rendered by the one shared converter, so it joins to a Query Store family without a formatting disagreement. Null when the engine reported none.</summary>
    string? QueryHash,
    /// <summary><c>query_plan_hash</c>, on the same terms as <see cref="QueryHash"/>.</summary>
    string? QueryPlanHash);

/// <summary>
/// The executions the plan cache retained since the previous sample.
/// <para>
/// An empty <see cref="Queries"/> with <see cref="DataStatus.Available"/> means no cached plan
/// advanced its counter during the interval. That is a much stronger statement than the live request
/// list's silence, but it is still not "the instance ran nothing": a statement compiled with
/// <c>OPTION (RECOMPILE)</c> leaves no plan-cache row at all, unparameterized ad-hoc text under
/// 'optimize for ad hoc workloads' is stubbed on first execution, natively compiled procedures report
/// elsewhere, and anything evicted between two reads takes its executions with it.
/// </para>
/// <para>
/// <see cref="WatermarkEngineLocal"/> is the engine's own clock as of this read, carried so the next
/// cycle can bound its query without substituting the collector's clock, and so a consumer can see
/// which interval <see cref="CompletedQueryV1.Executions"/> counts over.
/// <see cref="IntervalMs"/> is that interval's length, null on the first cycle when there is no
/// previous sample and therefore no interval.
/// </para>
/// <para>
/// <see cref="PlansAdvanced"/> is how many distinct plans advanced before any cap, so a capped list
/// is never read as a quieter instance, and <see cref="TotalExecutions"/> is the executions those
/// plans account for -- including the ones whose plans the cap dropped.
/// </para>
/// </summary>
public sealed record CompletedQuerySampleV1(
    IReadOnlyList<CompletedQueryV1> Queries,
    int PlansAdvanced,
    long TotalExecutions,
    DateTimeOffset? WatermarkEngineLocal,
    decimal? IntervalMs,
    DataStatus Status,
    string Reason);

/// <summary>
/// Per-scheduler CPU/runnable-queue pressure. <c>current_tasks_count</c>/<c>runnable_tasks_count</c>
/// etc. are instant gauges and are reported as-is; <c>total_cpu_usage_ms</c>/
/// <c>total_scheduler_delay_ms</c> are cumulative since engine start and are delta'd the same way as
/// file I/O counters (requirement 5).
/// </summary>
public sealed record SchedulerSampleV1(
    int SchedulerId,
    int CpuId,
    string? Status,
    bool IsOnline,
    bool IsIdle,
    int CurrentTasksCount,
    int RunnableTasksCount,
    int CurrentWorkersCount,
    int ActiveWorkersCount,
    int WorkQueueCount,
    int PendingDiskIoCount,
    int LoadFactor,
    long EpochId,
    decimal? SampleWindowMs,
    CounterDeltaV1 CpuUsageMsDelta,
    CounterDeltaV1 SchedulerDelayMsDelta,
    int? IdealWorkersLimit);

public sealed record SchedulerPressureV1(IReadOnlyList<SchedulerSampleV1> Schedulers, DataStatus Status, string Reason);

/// <summary>Transaction log size/utilization for the current database. An instant gauge -- never delta'd.</summary>
public sealed record LogSpaceUsageV1(
    decimal? TotalLogSizeMb,
    decimal? UsedLogSpaceMb,
    decimal? UsedLogSpacePercent,
    DataStatus Status,
    string Reason);

/// <summary>One subsystem sample this snapshot could not collect, and why -- never a silent omission.</summary>
public sealed record UnavailableFieldV1(string Field, DataStatus Status, string Reason);

/// <summary>
/// Collection metadata for one sample cycle: its position in the sampling sequence, when the
/// server-side facts were actually observed versus when this process finished assembling them, how
/// long assembly took, and how many scheduled cycles were skipped (overlap avoided) or missed
/// (paused/backing off) since the sampler started.
/// </summary>
public sealed record CollectionDiagnosticsV1(
    long Sequence,
    DateTimeOffset CollectedAt,
    DateTimeOffset? SourceTimestamp,
    long DurationMs,
    long MissedCycles,
    long SkippedCycles,
    IReadOnlyList<UnavailableFieldV1> UnavailableFields)
{
    /// <summary>
    /// Every collection a row cap bounded this cycle, and how much it left out. Empty means nothing
    /// was capped -- the counterpart of <see cref="UnavailableFields"/> for evidence that was
    /// reached but deliberately not all returned, rather than evidence that could not be sampled at
    /// all. A consumer that ignores this list will under-report the server; it must never be read
    /// as decoration.
    /// </summary>
    public IReadOnlyList<SampleTruncationV1> Truncations { get; init; } = [];
}

public sealed record LiveIncidentTargetV1(
    string TargetId,
    string DisplayName,
    string Platform,
    string VisibilityScope,
    string? UnavailableServerWideEvidenceReason);

/// <summary>
/// The canonical, versioned, immutable snapshot the sampler publishes once per cycle. Produced
/// identically by a fixture-backed and a live <c>Microsoft.Data.SqlClient</c>-backed
/// <c>ILiveIncidentCollector</c> (see <c>SqlSimCity.Collection</c>). <see cref="FreshUntil"/> is the
/// point after which a consumer should treat this snapshot as stale even without a newer one
/// arriving; <see cref="Status"/>/<see cref="Reason"/> record disconnection/permission/timeout
/// causes explicitly rather than an empty snapshot standing in for "nothing is happening".
/// </summary>
public sealed record LiveIncidentSnapshotV1(
    string SchemaVersion,
    LiveIncidentTargetV1 Target,
    DateTimeOffset? SourceTimestamp,
    DateTimeOffset CollectedAt,
    DateTimeOffset? FreshUntil,
    DataStatus Status,
    string Reason,
    IReadOnlyList<LiveRequestV1> Requests,
    IReadOnlyList<WaitingTaskV1> WaitingTasks,
    BlockingGraphV1 BlockingGraph,
    IReadOnlyList<MemoryGrantV1> MemoryGrants,
    TempdbUsageV1 Tempdb,
    FileIoSampleV1 FileIo,
    SchedulerPressureV1 Scheduler,
    LogSpaceUsageV1 LogSpace,
    DeadlockSampleV1 Deadlocks,
    CollectionDiagnosticsV1 Diagnostics)
{
    /// <summary>
    /// Executions the plan cache retained since the previous sample -- the queries that finished
    /// between two looks and that <see cref="Requests"/> therefore never saw.
    /// <para>
    /// An init-only member with a default rather than a positional parameter, so every existing
    /// construction site and deserializer keeps compiling and an older payload decodes to an explicit
    /// "not collected" rather than to an empty list that would read as a quiet instance.
    /// </para>
    /// </summary>
    public CompletedQuerySampleV1 CompletedQueries { get; init; } = new(
        [],
        0,
        0,
        null,
        null,
        DataStatus.Unknown,
        "Completed-query collection did not run for this snapshot, so nothing is claimed about queries that finished between samples.");
}

/// <summary>
/// The <c>LiveIncidentSampler</c>'s own operational status, independent of whether a snapshot has
/// ever successfully been produced -- so a consumer can distinguish "paused", "reconnecting with
/// backoff", and "stopped" from ordinary staleness of the last good snapshot.
/// </summary>
public sealed record LiveCollectorStatusV1(
    SamplerRunState State,
    long Sequence,
    DateTimeOffset? LastSuccessAt,
    DateTimeOffset? LastAttemptAt,
    long ConsecutiveFailures,
    double? NextAttemptInMs,
    string? LastErrorReason,
    long MissedCycles,
    long SkippedCycles);

/// <summary>The <c>/api/v1/live</c> response shape: the latest immutable snapshot (if any) plus the sampler's own status.</summary>
public sealed record LiveIncidentResponseV1(LiveIncidentSnapshotV1? Snapshot, LiveCollectorStatusV1 Collector);
