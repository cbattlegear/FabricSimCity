import { formatDecimalCount, splitPascal } from './capacityAtlas'
import type {
  BlockingReference,
  BlockingSentinelKind,
  CounterDelta,
  DataStatus,
  LiveIncidentResponse,
  LiveIncidentSnapshot,
  MemoryGrant,
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

/**
 * Whether this reference describes a session that is actually stopped.
 *
 * Zero is SQL Server's "nothing is blocking this". It is not a session number and it is what
 * `sys.dm_exec_requests` reports for every request that is merely running, so a predicate that only
 * tests the field against null calls the entire sample blocked. That is a real defect this codebase
 * shipped twice, once in the live feed's badge and once in the map's pin: a running query was
 * labelled "blocked" in the scrolling feed while the map showed no pin beside it, because an
 * unblocked request has no lock resource and there was nothing to place. The two disagreed because
 * they were both wrong in the same way, and only one of them had a way to show it.
 *
 * {@link blockingReferenceLabel} has always read zero correctly. This is that same rule, exported so
 * the places that *decide* something is blocked cannot drift from the place that describes it.
 *
 * A negative sentinel still counts. `-5` is commonly benign and the label says so, but the session
 * is genuinely waiting on an owner the engine cannot name, which is not the same as running.
 */
export function isBlockedReference(blocking: BlockingReference): boolean {
  if (blocking.sentinel !== 'None') return true
  return blocking.blockingSessionId !== null && blocking.blockingSessionId !== 0
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

/**
 * Live push-channel state, reported separately from snapshot freshness: a connected channel can
 * still carry a stale snapshot, and a stale snapshot does not by itself mean the channel is down.
 */
export type LiveFeedConnectionState = 'connected' | 'reconnecting' | 'polling-fallback' | 'disconnected'

export const RECONNECT_BASE_DELAY_MS = 1000
export const RECONNECT_MAX_DELAY_MS = 30_000

/** Bounded exponential backoff: doubles from the base delay and never exceeds the cap. */
export function computeReconnectDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt)) return RECONNECT_MAX_DELAY_MS
  const safeAttempt = Math.max(0, Math.floor(attempt))
  // Cap the exponent before the shift so a large attempt count cannot overflow to Infinity/NaN.
  const exponent = Math.min(safeAttempt, 20)
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** exponent, RECONNECT_MAX_DELAY_MS)
}

export function liveFeedConnectionLabel(state: LiveFeedConnectionState): string {
  const labels: Record<LiveFeedConnectionState, string> = {
    connected: 'Live push channel connected.',
    reconnecting: 'Live push channel reconnecting — values below may not be current.',
    'polling-fallback': 'Live push channel unavailable; refreshing over REST instead — updates are slower than usual.',
    disconnected: 'Live push channel disconnected; a reconnect attempt is scheduled.',
  }
  return labels[state]
}

/** Glyph carried alongside the text label so connection state is never signalled by color alone. */
export function liveFeedConnectionGlyph(state: LiveFeedConnectionState): string {
  const glyphs: Record<LiveFeedConnectionState, string> = {
    connected: '●',
    reconnecting: '◐',
    'polling-fallback': '◑',
    disconnected: '○',
  }
  return glyphs[state]
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
