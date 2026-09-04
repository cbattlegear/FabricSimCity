import type {
  DataStatus,
  FileIoDelta,
  LiveIncidentSnapshot,
  MemoryGrant,
  SchedulerSample,
} from './liveContracts'

/**
 * Projects one live snapshot onto the city's civic facilities: the places a running query actually
 * visits. CPU schedulers, memory grants, data files, tempdb and the transaction log are separate
 * physical resources in the engine, so they are separate facilities here rather than one abstract
 * "resources" bar.
 *
 * Every facility carries its own {@link DataStatus} and reason. A facility whose subsystem could not
 * be sampled renders as a nonquantitative wireframe and makes no claim at all -- an unavailable probe
 * is never evidence that a resource is idle.
 */

export type FacilityKind = 'cpu' | 'memory' | 'storage' | 'tempdb' | 'log' | 'lock'

/**
 * Placement order for the facilities. The seeded scatter in `cityPlan` walks this list, so the order
 * is what makes a database's facility layout reproducible rather than merely random.
 */
export const FACILITY_ORDER: readonly FacilityKind[] = [
  'cpu',
  'memory',
  'storage',
  'tempdb',
  'log',
  'lock',
]

export const FACILITY_LABELS: Readonly<Record<FacilityKind, string>> = {
  cpu: 'CPU Scheduler Yard',
  memory: 'Memory Grant Office',
  storage: 'Storage & I/O Depot',
  tempdb: 'tempdb Works',
  log: 'Log Yard',
  lock: 'Lock Authority',
}

/** One measured bar on a facility. `value` is null whenever the underlying fact was not available. */
export interface FacilityUnit {
  readonly id: string
  readonly label: string
  /** Normalized 0..1 fill used for geometry, or null when the measurement is unavailable. */
  readonly fill: number | null
  /** Exact measured text, always shown alongside the geometry. */
  readonly detail: string
  /** Set when this unit represents a resource that is currently waiting or stalled. */
  readonly alert: boolean
}

export interface Facility {
  readonly kind: FacilityKind
  readonly label: string
  readonly status: DataStatus
  readonly reason: string
  /** True only when the subsystem reported `Available`; false means render nonquantitative geometry. */
  readonly known: boolean
  readonly headline: string
  readonly units: readonly FacilityUnit[]
  /** Count of units currently waiting/stalled, used for the incident beacon. */
  readonly alertCount: number
}

const NOT_SAMPLED: DataStatus = 'Unknown'
const NO_SNAPSHOT_REASON =
  'No live snapshot has been received yet, so no claim is made about this resource.'

/**
 * Where one facility stands. Positions come from the city plan, which scatters facilities across the
 * grid at least {@link MIN_FACILITY_BLOCK_GAP} blocks apart and derives every position from the
 * database's seed — so a facility never moves when live data appears, disappears, or changes. You
 * can learn where the Memory Grant Office is.
 */
export interface FacilitySite {
  readonly kind: FacilityKind
  readonly label: string
  /** Facility centre in world units. */
  readonly x: number
  readonly z: number
  /** Plot half-extent; the facility's geometry stays inside this. */
  readonly radius: number
}

/** Facilities in fixed order. Always returns one entry per {@link FACILITY_ORDER} member. */
export function projectFacilities(snapshot: LiveIncidentSnapshot | null): Facility[] {  if (snapshot === null) {
    return FACILITY_ORDER.map(kind => unavailableFacility(kind, NOT_SAMPLED, NO_SNAPSHOT_REASON))
  }
  return [
    cpuFacility(snapshot),
    memoryFacility(snapshot),
    storageFacility(snapshot),
    tempdbFacility(snapshot),
    logFacility(snapshot),
    lockFacility(snapshot),
  ]
}

function cpuFacility(snapshot: LiveIncidentSnapshot): Facility {
  const { schedulers, status, reason } = snapshot.scheduler
  if (status !== 'Available') return unavailableFacility('cpu', status, reason)

  const online = schedulers.filter(scheduler => scheduler.isOnline)
  const peakLoad = Math.max(1, ...schedulers.map(scheduler => scheduler.loadFactor))
  const runnable = schedulers.reduce((sum, scheduler) => sum + scheduler.runnableTasksCount, 0)
  return {
    kind: 'cpu',
    label: FACILITY_LABELS.cpu,
    status,
    reason,
    known: true,
    headline: `${online.length} of ${schedulers.length} schedulers online · ${runnable} runnable task(s) queued`,
    units: [...schedulers]
      .sort((left, right) => left.schedulerId - right.schedulerId)
      .map(scheduler => schedulerUnit(scheduler, peakLoad)),
    alertCount: schedulers.filter(scheduler => scheduler.runnableTasksCount > 0).length,
  }
}

function schedulerUnit(scheduler: SchedulerSample, peakLoad: number): FacilityUnit {
  const rate = scheduler.cpuUsageMsDelta
  const cpu =
    rate.state === 'Delta' && rate.ratePerSecond !== null
      ? `${rate.ratePerSecond.toFixed(1)} CPU ms/s`
      : `no CPU rate yet (${rate.state})`
  return {
    id: `scheduler:${scheduler.schedulerId}`,
    label: `Scheduler ${scheduler.schedulerId} (CPU ${scheduler.cpuId})`,
    fill: scheduler.isOnline ? scheduler.loadFactor / peakLoad : null,
    detail:
      `load factor ${scheduler.loadFactor} · ${scheduler.currentTasksCount} task(s), ` +
      `${scheduler.runnableTasksCount} runnable · ${scheduler.activeWorkersCount} active worker(s) · ${cpu}` +
      (scheduler.isOnline ? '' : ' · offline'),
    alert: scheduler.runnableTasksCount > 0,
  }
}

function memoryFacility(snapshot: LiveIncidentSnapshot): Facility {
  const grants = snapshot.memoryGrants
  const unavailable = findUnavailable(snapshot, 'memoryGrants', 'memory')
  if (unavailable) return unavailable

  const waiting = grants.filter(grant => grant.isWaitingForGrant)
  const grantedKb = sumKb(grants, grant => grant.grantedKb)
  const requestedKb = sumKb(grants, grant => grant.requestedKb)
  return {
    kind: 'memory',
    label: FACILITY_LABELS.memory,
    status: snapshot.status,
    reason:
      grants.length === 0
        ? 'The memory grant probe returned no rows: no request currently holds or awaits a grant.'
        : `${grants.length} sampled grant(s); ${waiting.length} still waiting for a grant.`,
    known: true,
    headline:
      `${formatKb(grantedKb)} granted of ${formatKb(requestedKb)} requested · ` +
      `${waiting.length} queued at the counter`,
    units: [...grants]
      .sort((left, right) => left.sessionId - right.sessionId || (left.requestId ?? 0) - (right.requestId ?? 0))
      .map(grant => memoryUnit(grant, requestedKb)),
    alertCount: waiting.length,
  }
}

function memoryUnit(grant: MemoryGrant, requestedTotalKb: number | null): FacilityUnit {
  const granted = toNumber(grant.grantedKb)
  const requested = toNumber(grant.requestedKb)
  const fill =
    grant.isWaitingForGrant || granted === null
      ? null
      : requested !== null && requested > 0
        ? Math.min(1, granted / requested)
        : requestedTotalKb !== null && requestedTotalKb > 0
          ? Math.min(1, granted / requestedTotalKb)
          : null
  const wait = grant.isWaitingForGrant
    ? ` · waiting ${grant.waitTimeMs ?? 'unknown'} ms for a grant`
    : ''
  return {
    id: `grant:${grant.sessionId}:${grant.requestId ?? 'none'}`,
    label: `Session ${grant.sessionId}${grant.dop === null ? '' : ` · DOP ${grant.dop}`}`,
    fill,
    detail:
      `requested ${grant.requestedKb ?? 'unavailable'} KB, granted ${grant.grantedKb ?? 'not yet granted'} KB, ` +
      `used ${grant.usedKb ?? 'unavailable'} KB, ideal ${grant.idealKb ?? 'unavailable'} KB${wait}`,
    alert: grant.isWaitingForGrant,
  }
}

function storageFacility(snapshot: LiveIncidentSnapshot): Facility {
  const { files, status, reason } = snapshot.fileIo
  if (status !== 'Available') return unavailableFacility('storage', status, reason)

  const rates = files.map(file => combinedRate(file)).filter((rate): rate is number => rate !== null)
  const peak = rates.length > 0 ? Math.max(...rates) : 0
  const stalled = files.filter(file => hasStall(file)).length
  return {
    kind: 'storage',
    label: FACILITY_LABELS.storage,
    status,
    reason,
    known: true,
    headline:
      files.length === 0
        ? 'No file I/O counters in this sample.'
        : `${files.length} file(s) sampled · ${rates.length} reporting a rate · ${stalled} reporting I/O stall`,
    units: [...files]
      .sort((left, right) => left.databaseId - right.databaseId || left.fileId - right.fileId)
      .map(file => storageUnit(file, peak)),
    alertCount: stalled,
  }
}

function storageUnit(file: FileIoDelta, peak: number): FacilityUnit {
  const rate = combinedRate(file)
  const epochReset =
    file.readsDelta.state === 'EpochReset' || file.writesDelta.state === 'EpochReset'
  const detail = epochReset
    ? `counter epoch ${file.epochId}: the engine restarted or the counter regressed, so no rate is claimed`
    : rate === null
      ? `no rate yet: ${file.readsDelta.reason}`
      : `${formatRate(file.bytesReadDelta.ratePerSecond)} read/s · ${formatRate(file.bytesWrittenDelta.ratePerSecond)} written/s · ` +
        `stall ${file.ioStallReadMsDelta.deltaValue ?? '0'} ms read, ${file.ioStallWriteMsDelta.deltaValue ?? '0'} ms write`
  return {
    id: `file:${file.databaseId}:${file.fileId}`,
    label: `${file.databaseName ?? `database ${file.databaseId}`} file ${file.fileId}${file.typeDesc ? ` (${file.typeDesc})` : ''}`,
    fill: rate === null || peak <= 0 ? null : Math.min(1, rate / peak),
    detail,
    alert: hasStall(file),
  }
}

function tempdbFacility(snapshot: LiveIncidentSnapshot): Facility {
  const { files, sessions, status, reason } = snapshot.tempdb
  if (status !== 'Available') return unavailableFacility('tempdb', status, reason)

  const totalMb = files.reduce((sum, file) => sum + file.totalMb, 0)
  const allocatedMb = files.reduce((sum, file) => sum + file.allocatedMb, 0)
  const versionStoreMb = files.reduce((sum, file) => sum + file.versionStoreMb, 0)
  return {
    kind: 'tempdb',
    label: FACILITY_LABELS.tempdb,
    status,
    reason,
    known: true,
    headline:
      `${allocatedMb.toFixed(1)} MB allocated of ${totalMb.toFixed(1)} MB · ` +
      `${versionStoreMb.toFixed(1)} MB version store · ${sessions.length} session(s) holding space`,
    units: [...files]
      .sort((left, right) => left.fileId - right.fileId)
      .map(file => ({
        id: `tempdb:${file.fileId}`,
        label: `tempdb file ${file.fileId}`,
        fill: file.totalMb > 0 ? Math.min(1, file.allocatedMb / file.totalMb) : null,
        detail:
          `${file.allocatedMb.toFixed(1)} MB allocated, ${file.freeMb.toFixed(1)} MB free · ` +
          `user ${file.userObjectsMb.toFixed(1)} MB · internal ${file.internalObjectsMb.toFixed(1)} MB · ` +
          `version store ${file.versionStoreMb.toFixed(1)} MB`,
        alert: file.totalMb > 0 && file.allocatedMb / file.totalMb > 0.85,
      })),
    alertCount: files.filter(file => file.totalMb > 0 && file.allocatedMb / file.totalMb > 0.85).length,
  }
}

function logFacility(snapshot: LiveIncidentSnapshot): Facility {
  const { totalLogSizeMb, usedLogSpaceMb, usedLogSpacePercent, status, reason } = snapshot.logSpace
  if (status !== 'Available') return unavailableFacility('log', status, reason)

  const percent = usedLogSpacePercent
  return {
    kind: 'log',
    label: FACILITY_LABELS.log,
    status,
    reason,
    known: true,
    headline:
      percent === null
        ? 'Log utilization was not reported in this sample.'
        : `${percent.toFixed(1)}% of the transaction log is in use`,
    units: [
      {
        id: 'log:current',
        label: 'Transaction log',
        fill: percent === null ? null : Math.min(1, Math.max(0, percent / 100)),
        detail:
          `${usedLogSpaceMb === null ? 'unavailable' : `${usedLogSpaceMb.toFixed(1)} MB`} used of ` +
          `${totalLogSizeMb === null ? 'unavailable' : `${totalLogSizeMb.toFixed(1)} MB`} · instant gauge, never delta'd`,
        alert: percent !== null && percent >= 80,
      },
    ],
    alertCount: percent !== null && percent >= 80 ? 1 : 0,
  }
}

function lockFacility(snapshot: LiveIncidentSnapshot): Facility {
  const { summary, nodes } = snapshot.blockingGraph
  const roots = nodes.filter(node => node.isRoot)
  return {
    kind: 'lock',
    label: FACILITY_LABELS.lock,
    status: snapshot.status,
    reason: summary.note,
    known: snapshot.status === 'Available',
    headline:
      `${summary.blockedSessionCount} blocked · ${summary.rootBlockerCount} root blocker(s) · ` +
      `${summary.sentinelRootCount} sentinel root(s) · ${summary.cycleCount} cycle(s)`,
    units: roots
      .slice()
      .sort((left, right) => right.directlyBlockedCount - left.directlyBlockedCount ||
        left.nodeId.localeCompare(right.nodeId))
      .map(node => ({
        id: `blocker:${node.nodeId}`,
        label:
          node.kind === 'Sentinel'
            ? `Sentinel owner (${node.sentinel})`
            : `Session ${node.sessionId ?? 'unknown'}`,
        fill:
          summary.blockedSessionCount > 0
            ? Math.min(1, node.directlyBlockedCount / summary.blockedSessionCount)
            : null,
        detail:
          `blocking ${node.directlyBlockedCount} session(s) directly` +
          (node.isIdleWithOpenTransaction ? ' · idle with an open transaction' : '') +
          (node.inCycle ? ' · participates in a cycle' : ''),
        alert: node.directlyBlockedCount > 0,
      })),
    alertCount: summary.blockedSessionCount,
  }
}

function unavailableFacility(kind: FacilityKind, status: DataStatus, reason: string): Facility {
  return {
    kind,
    label: FACILITY_LABELS[kind],
    status,
    reason,
    known: false,
    headline: `${FACILITY_LABELS[kind]} evidence is ${status.toLowerCase()}; no quantity is claimed.`,
    units: [],
    alertCount: 0,
  }
}

/** Uses the snapshot's own unavailable-field list, which is how subsystems without a status flag report failure. */
function findUnavailable(
  snapshot: LiveIncidentSnapshot,
  field: string,
  kind: FacilityKind,
): Facility | null {
  const entry = snapshot.diagnostics.unavailableFields.find(item => item.field === field)
  return entry ? unavailableFacility(kind, entry.status, entry.reason) : null
}

function combinedRate(file: FileIoDelta): number | null {
  const read = file.bytesReadDelta.ratePerSecond
  const write = file.bytesWrittenDelta.ratePerSecond
  if (read === null && write === null) return null
  return (read ?? 0) + (write ?? 0)
}

function hasStall(file: FileIoDelta): boolean {
  const read = toNumber(file.ioStallReadMsDelta.deltaValue) ?? 0
  const write = toNumber(file.ioStallWriteMsDelta.deltaValue) ?? 0
  return read > 0 || write > 0
}

function sumKb(
  grants: readonly MemoryGrant[],
  pick: (grant: MemoryGrant) => string | null,
): number | null {
  let total = 0
  let sawValue = false
  for (const grant of grants) {
    const value = toNumber(pick(grant))
    if (value === null) continue
    sawValue = true
    total += value
  }
  return sawValue ? total : null
}

function toNumber(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function formatKb(kb: number | null): string {
  if (kb === null) return 'an unavailable amount'
  if (kb < 1024) return `${kb.toLocaleString()} KB`
  return `${(kb / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`
}

function formatRate(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null) return 'unavailable'
  if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B`
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KiB`
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MiB`
}
