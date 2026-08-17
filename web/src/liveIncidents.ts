import { formatDecimalCount, splitPascal } from './atlas'
import type {
  BlockingReference,
  BlockingSentinelKind,
  CounterDelta,
  DataStatus,
  LiveCollectorStatus,
  LiveIncidentResponse,
  LiveIncidentSnapshot,
  LiveRequest,
  MemoryGrant,
  SamplerRunState,
  WaitingTask,
} from './liveContracts'

/** Human labels for the four documented negative blocking_session_id sentinels (never coerced to zero/null). */
const SENTINEL_LABELS: Record<BlockingSentinelKind, string> = {
  None: '',
  OrphanedDistributedTransaction: 'orphaned distributed transaction (-2)',
  DeferredRecoveryTransaction: 'deferred recovery transaction (-3)',
  IndeterminateLatchOwner: 'indeterminate latch owner (-4)',
  UntrackedLatchOwner: 'untracked latch owner (-5)',
}

/**
 * Describes a blocking reference. -5 (untracked latch owner) is common and is deliberately never
 * described as a "blocking problem" by itself — see BlockingSentinelKind on the wire contract.
 */
export function blockingReferenceLabel(blocking: BlockingReference): string {
  if (blocking.sentinel !== 'None') {
    const note = blocking.sentinel === 'UntrackedLatchOwner'
      ? ' — commonly benign, not necessarily a blocking problem'
      : ''
    return `${SENTINEL_LABELS[blocking.sentinel]}${note}`
  }
  if (blocking.blockingSessionId === null || blocking.blockingSessionId === 0) return 'not blocked'
  return `blocked by session ${blocking.blockingSessionId}`
}

export function formatKb(value: string | null): string {
  if (value === null) return 'Unavailable'
  if (!/^\d+$/.test(value)) return 'Invalid value'
  const kb = BigInt(value)
  if (kb < 1024n) return `${formatDecimalCount(value)} KiB`
  const mb = Number(kb) / 1024
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(mb)} MiB`
}

export function dataStatusLabel(status: DataStatus): string {
  return splitPascal(status)
}

/** True only for a fresh, available snapshot — the sole condition under which motion cues may be shown (requirement 8). */
export function isSnapshotFresh(snapshot: LiveIncidentSnapshot, now: string): boolean {
  return snapshot.status === 'Available' &&
    snapshot.freshUntil !== null && Date.parse(snapshot.freshUntil) >= Date.parse(now)
}

export function samplerStateLabel(state: SamplerRunState): string {
  const labels: Record<SamplerRunState, string> = {
    Running: 'running',
    Paused: 'paused',
    Stopped: 'stopped',
    Reconnecting: 'reconnecting after an error',
  }
  return labels[state]
}

/** Accessible summary of collector health, independent of whether a snapshot has ever arrived. */
export function collectorStatusLabel(status: LiveCollectorStatus): string {
  const base = `Collector is ${samplerStateLabel(status.state)}. Cycle ${status.sequence}.`
  if (status.state === 'Reconnecting' && status.lastErrorReason) {
    const retry = status.nextAttemptInMs !== null ? ` Retrying in ${Math.round(status.nextAttemptInMs / 1000)}s.` : ''
    return `${base} Last error: ${status.lastErrorReason}.${retry}`
  }
  if (status.missedCycles > 0 || status.skippedCycles > 0) {
    return `${base} Missed ${status.missedCycles}, skipped ${status.skippedCycles} cycles since start.`
  }
  return base
}

/** Session/request row label: exact wait, blocking reference, and short-lived-query disclosure never implied as complete capture. */
export function requestLabel(request: LiveRequest): string {
  const wait = request.waitType ? ` waiting on ${request.waitType}${request.waitTimeMs !== null ? ` for ${request.waitTimeMs} ms` : ''}.` : ' not waiting.'
  const disappeared = request.availability === 'Disappeared'
    ? ` This request disappeared between samples (completed or was killed) — ${request.availabilityReason ?? 'not observed further'}.`
    : ''
  const blockingText = blockingReferenceLabel(request.blocking)
  return `Session ${request.sessionId}, ${request.requestStatus ?? 'unknown status'}.${wait} ${blockingText}.${disappeared}`
}

/** One parallel waiting task's label; every worker exec_context_id is exposed individually, never collapsed to the coordinator wait (requirement 4). */
export function waitingTaskLabel(task: WaitingTask): string {
  const role = task.executionContext === 'Worker' ? `parallel worker (exec_context_id ${task.execContextId})` : 'coordinator'
  const wait = task.waitType ? `${task.waitType} for ${task.waitDurationMs} ms` : 'no recorded wait type'
  return `Session ${task.sessionId}, ${role}: ${wait}. ${blockingReferenceLabel(task.blocking)}.`
}

export function memoryGrantLabel(grant: MemoryGrant): string {
  const state = grant.isWaitingForGrant
    ? `waiting for a memory grant${grant.waitTimeMs !== null ? ` (${grant.waitTimeMs} ms so far)` : ''}`
    : 'grant satisfied'
  return `Session ${grant.sessionId}: requested ${formatKb(grant.requestedKb)}, ${state}.`
}

export function counterDeltaLabel(delta: CounterDelta, unit: string): string {
  switch (delta.state) {
    case 'FirstSample':
      return 'first sample — no rate yet'
    case 'EpochReset':
      return `epoch reset (engine restart or counter regression) — ${delta.reason}`
    case 'Delta':
      return delta.ratePerSecond !== null ? `${delta.ratePerSecond.toFixed(1)} ${unit}/s` : 'no rate available'
  }
}

/**
 * A durable, non-color-only summary of the blocking graph. Every individual parallel wait and
 * blocked session is still present in the full graph; this text never substitutes for that detail.
 */
export function blockingGraphSummaryLabel(snapshot: LiveIncidentSnapshot): string {
  const summary = snapshot.blockingGraph.summary
  const cycles = summary.cycleCount > 0 ? ` ${summary.cycleCount} cycle(s) detected.` : ''
  return `${summary.blockedSessionCount} blocked session(s), ${summary.rootBlockerCount} root blocker(s), ` +
    `${summary.sentinelRootCount} sentinel root(s), ${summary.parallelWaitTaskCount} parallel wait task(s).${cycles} ${summary.note}`
}

/** Never claims complete query capture: short-lived queries between sampling cycles can be missed entirely. */
export const POLLING_DISCLOSURE =
  'This is a point-in-time sample on a bounded cadence, not a complete record of every query. ' +
  'A query that starts and finishes between samples may never appear here.'

export function assertLiveIncidentResponse(value: unknown): LiveIncidentResponse {
  if (!value || typeof value !== 'object') throw new Error('Live incident response is not an object')
  const candidate = value as Partial<LiveIncidentResponse>
  if (!candidate.collector || typeof candidate.collector !== 'object') {
    throw new Error('Live incident response is missing collector status')
  }
  if (candidate.snapshot !== null && candidate.snapshot !== undefined && candidate.snapshot.schemaVersion !== '1.0') {
    throw new Error('Live incident snapshot does not match schema version 1.0')
  }
  return candidate as LiveIncidentResponse
}
