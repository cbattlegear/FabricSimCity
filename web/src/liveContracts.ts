// Mirrors src/SqlSimCity.Contracts/LiveIncidentContractsV1.cs exactly, property-for-property.
// Every bigint count/byte crosses the wire as a base-10 string (never a narrowed JS number), so
// this file has no numeric fields for anything the C# side declares as `string` bigint text.

export type SampleAvailability = 'Available' | 'Disappeared' | 'Unavailable' | 'Stale'

/// The four documented negative blocking_session_id sentinels; -5 is common/benign and is never
/// itself reported as a blocking "problem".
export type BlockingSentinelKind =
  | 'None'
  | 'OrphanedDistributedTransaction' // -2
  | 'DeferredRecoveryTransaction' // -3
  | 'IndeterminateLatchOwner' // -4
  | 'UntrackedLatchOwner' // -5

export type BlockingNodeKind = 'Session' | 'Sentinel'
export type ExecutionContextKind = 'Coordinator' | 'Worker'
export type PlanCollectionState = 'NotRequested' | 'Available' | 'Unavailable'
export type CounterEpochState = 'FirstSample' | 'Delta' | 'EpochReset'
export type SamplerRunState = 'Running' | 'Paused' | 'Stopped' | 'Reconnecting'
export type DataStatus = 'Available' | 'Stale' | 'Disconnected' | 'PermissionDenied' | 'Disabled' | 'Unsupported' | 'Unknown'

export interface BlockingReference {
  blockingSessionId: number | null
  sentinel: BlockingSentinelKind
}

/// Every documented `wait_resource` form. `Page` and `Rid` name a page, not an object; resolving
/// them needs `sys.dm_db_page_info` or an allocation scan, which is too costly for a realtime
/// probe, so they are reported unresolved with a reason rather than guessed.
export type LockResourceKind =
  | 'None'
  | 'Key'
  | 'Object'
  | 'Page'
  | 'Rid'
  | 'HoBt'
  | 'Table'
  | 'Extent'
  | 'File'
  | 'Application'
  | 'Metadata'
  | 'Database'
  | 'AllocationUnit'
  /**
   * `XACT` — a lock on a transaction id rather than on any object. Optimized locking (SQL Server
   * 2025, Azure SQL Database, Managed Instance, Fabric SQL) has a writer hold one lock on its own
   * transaction instead of holding every row and key lock until commit, so waiters queue on that
   * transaction. Understood in full, and names no object by design.
   */
  | 'Transaction'
  | 'Unrecognized'

export type LockResolutionStatus =
  | 'Resolved'
  | 'RequiresLookup'
  | 'NotObjectScoped'
  | 'Unresolvable'
  | 'Unrecognized'

/// Optional throughout: emitted only once the lock-resource probe has run, so the UI must treat
/// its absence as "not claimed" rather than "no lock".
export interface LockResource {
  rawResource: string
  kind: LockResourceKind
  databaseId: number | null
  objectId: number | null
  indexId: number | null
  schemaName: string | null
  objectName: string | null
  indexName: string | null
  status: LockResolutionStatus
  reason: string
}

export interface LiveRequest {
  requestId: string
  sessionId: number
  loginName: string | null
  hostName: string | null
  programName: string | null
  sessionStatus: string | null
  /**
   * `sys.dm_exec_requests.status`, or null when the row is an idle session holding no request.
   * Sampling includes idle sessions on purpose, so null here means "no request" rather than "a
   * request in some unreported state" — do not count these rows as running requests (issue #79).
   */
  requestStatus: string | null
  command: string | null
  waitType: string | null
  waitTimeMs: number | null
  waitResource: string | null
  lockResource?: LockResource | null
  blocking: BlockingReference
  requestStartTime: string | null
  totalElapsedMs: number | null
  cpuTimeMs: number | null
  reads: string | null
  writes: string | null
  logicalReads8KiBPages: string | null
  openTransactionCount: number | null
  databaseId: string | null
  databaseName: string | null
  currentStatementText: string | null
  batchText: string | null
  availability: SampleAvailability
  availabilityReason: string | null
  planState: PlanCollectionState
  planReason: string | null
  /**
   * `sys.dm_exec_requests.query_hash` as uppercase hex with no `0x` prefix — the same rendering the
   * Query Store collector gives `DatabaseCityQueryFamily.queryHash`, so the two can be compared
   * with string equality to find which query family a running request belongs to.
   *
   * Null means no hash was reported (an idle session, or a request the engine did not hash). It
   * never means "unknown query", and must not be resolved by matching statement text instead. The
   * engine's all-zero "not hashed" sentinel is normalized to null by the collector, so it can never
   * arrive here as a family that every unhashed request shares.
   */
  queryHash?: string | null
  /**
   * `sys.dm_exec_requests.query_plan_hash`, rendered identically. Distinguishes which plan for a
   * family is running, not just which family. Same null semantics as {@link LiveRequest.queryHash}.
   */
  queryPlanHash?: string | null
}

export interface WaitingTask {
  taskId: string
  sessionId: number
  executionContext: ExecutionContextKind
  execContextId: number
  waitType: string | null
  waitDurationMs: string
  resourceDescription: string | null
  lockResource?: LockResource | null
  blocking: BlockingReference
}

export interface BlockingNode {
  nodeId: string
  kind: BlockingNodeKind
  sessionId: number | null
  sentinel: BlockingSentinelKind
  isRoot: boolean
  isIdleWithOpenTransaction: boolean
  inCycle: boolean
  directlyBlockedCount: number
}

export interface BlockingEdge {
  edgeId: string
  fromNodeId: string
  toNodeId: string
  waitType: string | null
  waitDurationMs: string | null
  executionContext: ExecutionContextKind | null
  execContextId: number | null
}

export interface BlockingGraphSummary {
  blockedSessionCount: number
  rootBlockerCount: number
  sentinelRootCount: number
  cycleCount: number
  parallelWaitTaskCount: number
  note: string
}

export interface BlockingGraph {
  nodes: BlockingNode[]
  edges: BlockingEdge[]
  rootNodeIds: string[]
  cycles: string[][]
  summary: BlockingGraphSummary
}

export interface MemoryGrant {
  sessionId: number
  requestId: number | null
  schedulerId: number | null
  dop: number | null
  requestTime: string | null
  grantTime: string | null
  isWaitingForGrant: boolean
  requestedKb: string | null
  grantedKb: string | null
  requiredKb: string | null
  usedKb: string | null
  maxUsedKb: string | null
  idealKb: string | null
  queryCost: number | null
  timeoutSec: number | null
  waitTimeMs: string | null
  batchText: string | null
}

export interface TempdbFileUsage {
  fileId: number
  totalMb: number
  allocatedMb: number
  freeMb: number
  versionStoreMb: number
  userObjectsMb: number
  internalObjectsMb: number
  mixedExtentMb: number
}

export interface TempdbSessionUsage {
  sessionId: number
  userObjectsAllocPageCount: string
  userObjectsDeallocPageCount: string
  internalObjectsAllocPageCount: string
  internalObjectsDeallocPageCount: string
}

export interface TempdbTaskUsage {
  sessionId: number
  requestId: number | null
  execContextId: number
  userObjectsAllocPageCount: string
  userObjectsDeallocPageCount: string
  internalObjectsAllocPageCount: string
  internalObjectsDeallocPageCount: string
}

export interface TempdbUsage {
  files: TempdbFileUsage[]
  sessions: TempdbSessionUsage[]
  tasks: TempdbTaskUsage[]
  status: DataStatus
  reason: string
}

export interface CounterDelta {
  state: CounterEpochState
  deltaValue: string | null
  ratePerSecond: number | null
  reason: string
}

export interface FileIoDelta {
  databaseId: number
  databaseName: string | null
  fileId: number
  typeDesc: string | null
  epochId: number
  sampleWindowMs: number | null
  readsDelta: CounterDelta
  bytesReadDelta: CounterDelta
  ioStallReadMsDelta: CounterDelta
  writesDelta: CounterDelta
  bytesWrittenDelta: CounterDelta
  ioStallWriteMsDelta: CounterDelta
}

export interface FileIoSample {
  files: FileIoDelta[]
  status: DataStatus
  reason: string
}

export interface SchedulerSample {
  schedulerId: number
  cpuId: number
  status: string | null
  isOnline: boolean
  isIdle: boolean
  currentTasksCount: number
  runnableTasksCount: number
  currentWorkersCount: number
  activeWorkersCount: number
  workQueueCount: number
  pendingDiskIoCount: number
  loadFactor: number
  epochId: number
  sampleWindowMs: number | null
  cpuUsageMsDelta: CounterDelta
  schedulerDelayMsDelta: CounterDelta
  idealWorkersLimit: number | null
}

export interface SchedulerPressure {
  schedulers: SchedulerSample[]
  status: DataStatus
  reason: string
}

export interface LogSpaceUsage {
  totalLogSizeMb: number | null
  usedLogSpaceMb: number | null
  usedLogSpacePercent: number | null
  status: DataStatus
  reason: string
}

/**
 * One participant in a recorded deadlock.
 *
 * `id` is the graph-internal process identifier (for example `process21c43b4d088`). It is the only
 * thing `DeadlockResource`'s owners and waiters refer to, so it is what joins a participant to what
 * it held and what it wanted. It is unique within one graph and meaningless outside it -- never
 * treat it as a session identity.
 *
 * `statement` is present only when the graph was fetched with statement text, which is off by
 * default. Check `DeadlockGraph.includesSqlText` before rendering its absence: null means "text was
 * not requested" far more often than it means "this participant ran nothing".
 */
export interface DeadlockProcess {
  id: string
  sessionId: number | null
  isVictim: boolean
  databaseId: number | null
  databaseName: string | null
  lockMode: string | null
  waitResource: string | null
  waitTimeMs: number | null
  transactionName: string | null
  isolationLevel: string | null
  clientApplication: string | null
  hostName: string | null
  loginName: string | null
  statement: string | null
}

/** A reference from a resource to one of the graph's processes, with the lock mode involved. */
export interface DeadlockParticipant {
  processId: string
  mode: string | null
  requestType: string | null
}

/**
 * One resource in a recorded deadlock, with the participants that held it and those waiting for it.
 *
 * `resourceKind` is the element name the engine chose -- `keylock`, `objectlock`, `pagelock`,
 * `ridlock`, `exchangeEvent` and others it may add -- and is carried verbatim rather than mapped
 * onto a closed union, because the set is the engine's to extend. A consumer that cannot render a
 * kind should say so rather than drop the resource, or the cycle stops explaining itself.
 *
 * `objectName` is the three-part name for the lock kinds that name an object, and null for the ones
 * that do not (an `exchangeEvent` is a parallelism resource inside one query and names nothing).
 * Null means "this resource kind has no object", never "the object is unknown".
 */
export interface DeadlockResource {
  resourceKind: string
  databaseId: number | null
  objectName: string | null
  indexName: string | null
  associatedObjectId: number | null
  owners: DeadlockParticipant[]
  waiters: DeadlockParticipant[]
}

/**
 * One deadlock the engine already resolved and recorded.
 *
 * This is history, not a live measurement. By the time anything can query for a deadlock the victim
 * has been rolled back and nothing about it remains in the request or waiting-task DMVs.
 * `occurredAt` is when it happened, which may be minutes or hours before the snapshot carrying it,
 * and a consumer must date it from that rather than from the snapshot.
 *
 * `id` is stable across snapshots and across whether statement text was requested, so a deadlock
 * appearing in several consecutive snapshots can be deduplicated on it.
 */
export interface DeadlockGraph {
  id: string
  occurredAt: string
  processes: DeadlockProcess[]
  resources: DeadlockResource[]
  victimProcessIds: string[]
  includesSqlText: boolean
}

/**
 * Deadlocks recorded by the `system_health` session, with the observation window disclosed.
 *
 * An empty `graphs` with status `Available` means "no deadlock is retained in the window that was
 * read". It does not mean the instance has no deadlocks: `system_health` rolls its event files over,
 * so an older deadlock is simply gone. Status `Unsupported` means deadlocks are not observed here at
 * all -- Azure SQL Database has no such session. Never render those two the same way.
 *
 * `collectedAt` is when this sample was read, deliberately not the snapshot's own `collectedAt`.
 * Reading the session's files costs about a second, far too much for a 2-5 second cycle, so the
 * sample is refreshed on its own slower interval and reused in between. Deadlock age must be
 * computed from this.
 *
 * `totalRetainedCount` is the count before any cap, so a capped list is never read as a calmer
 * instance.
 */
export interface DeadlockSample {
  graphs: DeadlockGraph[]
  totalRetainedCount: number
  collectedAt: string | null
  status: DataStatus
  reason: string
}

export interface UnavailableField {
  field: string
  status: DataStatus
  reason: string
}

export interface CollectionDiagnostics {
  sequence: number
  collectedAt: string
  sourceTimestamp: string | null
  durationMs: number
  missedCycles: number
  skippedCycles: number
  unavailableFields: UnavailableField[]
}

export interface LiveIncidentTarget {
  targetId: string
  displayName: string
  platform: string
  visibilityScope: string
  unavailableServerWideEvidenceReason: string | null
}

export interface LiveIncidentSnapshot {
  schemaVersion: string
  target: LiveIncidentTarget
  sourceTimestamp: string | null
  collectedAt: string
  freshUntil: string | null
  status: DataStatus
  reason: string
  requests: LiveRequest[]
  waitingTasks: WaitingTask[]
  blockingGraph: BlockingGraph
  memoryGrants: MemoryGrant[]
  tempdb: TempdbUsage
  fileIo: FileIoSample
  scheduler: SchedulerPressure
  logSpace: LogSpaceUsage
  deadlocks: DeadlockSample
  diagnostics: CollectionDiagnostics
}

export interface LiveCollectorStatus {
  state: SamplerRunState
  sequence: number
  lastSuccessAt: string | null
  lastAttemptAt: string | null
  consecutiveFailures: number
  nextAttemptInMs: number | null
  lastErrorReason: string | null
  missedCycles: number
  skippedCycles: number
}

export interface LiveIncidentResponse {
  snapshot: LiveIncidentSnapshot | null
  collector: LiveCollectorStatus
}
