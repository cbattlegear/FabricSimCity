import type { DatabaseCityObject } from './databaseCityContracts'
import type { LiveIncidentSnapshot, LiveRequest, LockResource, WaitingTask } from './liveContracts'

/**
 * Turns a live snapshot into map pins.
 *
 * The rule that governs every function here is the same rule the rest of the app follows: a
 * subsystem that could not be sampled produces **no marker**, never a "clear" one. An empty map is
 * "nothing was observed", which is not the same claim as "nothing is wrong", and the popup says
 * which of the two it is.
 *
 * A marker is only ever anchored to a building the map is actually drawing. A live wait that
 * resolves to an object outside the loaded bounded page is real, and is counted, but it has nowhere
 * to be drawn — so it is reported as an off-map count rather than pinned to the wrong lot.
 */

export type IncidentSeverity = 'blocked' | 'waiting' | 'deadlock'

export interface IncidentMarker {
  readonly id: string
  readonly objectId: string
  readonly severity: IncidentSeverity
  /** One line naming what is happening. Never a judgement, always the observation. */
  readonly headline: string
  /** The measured facts behind the headline, each already formatted for display. */
  readonly details: readonly string[]
  /** Where this came from and when it was observed. Shown in the popup, always. */
  readonly source: string
  readonly observedAt: string
}

export interface IncidentProjection {
  readonly markers: readonly IncidentMarker[]
  /**
   * Live waits that resolved to a real object that this bounded page has not loaded. Counted so the
   * absence of a pin is never read as the absence of a problem.
   */
  readonly offPageCount: number
  /**
   * Waits that were sampled but could not name an object at all, with the parser's reason. A page
   * lock or a database lock lands here rather than being guessed onto a building.
   */
  readonly unresolved: ReadonlyArray<{ readonly rawResource: string; readonly reason: string }>
  /**
   * False when the snapshot carried no evidence for this at all — no snapshot, a failed collection,
   * or a lock-resource probe that never ran. The UI must say "not observed", not "none".
   */
  readonly probeReported: boolean
  /** Why the projection is empty or partial, in the collector's own words. */
  readonly reason: string
}

const NOT_OBSERVED: IncidentProjection = {
  markers: [],
  offPageCount: 0,
  unresolved: [],
  probeReported: false,
  reason: 'No live snapshot has been received, so nothing is claimed about current activity.',
}

/** Only a *blocked* waiter is an incident. Holding a lock nobody waits behind is just work. */
function isBlocked(blocking: { blockingSessionId: number | null; sentinel: string }): boolean {
  return blocking.blockingSessionId !== null || blocking.sentinel !== 'None'
}

function objectKeys(object: DatabaseCityObject): string[] {
  return [
    object.objectId.toLocaleLowerCase(),
    `${object.schemaName}.${object.name}`.toLocaleLowerCase(),
  ]
}

function lockKeys(lock: LockResource): string[] {
  const keys: string[] = []
  if (lock.schemaName && lock.objectName) {
    keys.push(`${lock.schemaName}.${lock.objectName}`.toLocaleLowerCase())
  }
  if (lock.databaseId !== null && lock.objectId !== null) {
    keys.push(`${lock.databaseId}/object/${lock.objectId}`.toLocaleLowerCase())
  }
  return keys
}

function waitMs(value: number | string | null): number | null {
  if (value === null) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function formatMs(value: number | null): string {
  if (value === null) return 'wait duration not reported'
  if (value < 1000) return `${Math.round(value)} ms waited`
  return `${(value / 1000).toFixed(1)} s waited`
}

/**
 * Builds the marker set for one bounded page of objects.
 *
 * `sessionsInCycle` comes from the blocking graph's detected cycles. SQL Server does not report a
 * deadlock in `sys.dm_exec_requests` — a deadlock is already resolved by the time you could see it —
 * so a cycle in the *current* wait graph is reported as exactly that: a cycle, not a deadlock
 * verdict. The severity is named `deadlock` because that is the shape being drawn, and the popup
 * text says precisely what was measured.
 */
export function projectIncidents(
  snapshot: LiveIncidentSnapshot | null,
  objects: readonly DatabaseCityObject[],
): IncidentProjection {
  if (!snapshot) return NOT_OBSERVED
  if (snapshot.status !== 'Available' && snapshot.status !== 'Stale') {
    return {
      markers: [],
      offPageCount: 0,
      unresolved: [],
      probeReported: false,
      reason: `Live collection reported ${snapshot.status}: ${snapshot.reason}`,
    }
  }

  const byKey = new Map<string, string>()
  for (const object of objects) {
    for (const key of objectKeys(object)) byKey.set(key, object.objectId)
  }

  const sessionsInCycle = new Set<number>()
  for (const cycle of snapshot.blockingGraph.cycles) {
    for (const nodeId of cycle) {
      const node = snapshot.blockingGraph.nodes.find(candidate => candidate.nodeId === nodeId)
      if (node?.sessionId !== null && node?.sessionId !== undefined) sessionsInCycle.add(node.sessionId)
    }
  }

  const observedAt = snapshot.sourceTimestamp ?? snapshot.collectedAt
  const markers: IncidentMarker[] = []
  const unresolved: { rawResource: string; reason: string }[] = []
  let offPageCount = 0
  let probeReported = false
  // One marker per object: the worst wait wins the pin, and the rest become detail lines.
  const byObject = new Map<string, IncidentMarker>()

  const consider = (
    source: LiveRequest | WaitingTask,
    kind: 'request' | 'task',
  ) => {
    const lock = source.lockResource
    if (lock === undefined) return
    probeReported = true
    if (lock === null) return
    if (!isBlocked(source.blocking)) return

    if (lock.status !== 'Resolved') {
      unresolved.push({ rawResource: lock.rawResource, reason: lock.reason })
      return
    }

    const objectId = lockKeys(lock).map(key => byKey.get(key)).find(Boolean)
    if (!objectId) {
      offPageCount += 1
      return
    }

    const duration = waitMs(kind === 'request' ? (source as LiveRequest).waitTimeMs : (source as WaitingTask).waitDurationMs)
    const inCycle = sessionsInCycle.has(source.sessionId)
    const severity: IncidentSeverity = inCycle ? 'deadlock' : 'blocked'
    const blocker = source.blocking.blockingSessionId
    const details = [
      formatMs(duration),
      `wait type ${source.waitType ?? 'not reported'}`,
      blocker !== null
        ? `session ${source.sessionId} is blocked by session ${blocker}`
        : `session ${source.sessionId} is blocked behind ${source.blocking.sentinel}`,
      `lock resource ${lock.rawResource} resolved to ${lock.schemaName ?? '?'}.${lock.objectName ?? '?'}`,
    ]
    if (inCycle) {
      details.push('This session is part of a cycle in the current wait graph. A cycle is what was measured; SQL Server resolves real deadlocks before they can be sampled.')
    }

    const marker: IncidentMarker = {
      id: `${kind}:${source.sessionId}:${objectId}`,
      objectId,
      severity,
      headline: inCycle
        ? `Session ${source.sessionId} is in a wait cycle here`
        : `Session ${source.sessionId} is blocked here`,
      details,
      source: kind === 'request'
        ? 'sys.dm_exec_requests, with the lock resource resolved by the backend probe'
        : 'sys.dm_os_waiting_tasks, with the lock resource resolved by the backend probe',
      observedAt,
    }

    const existing = byObject.get(objectId)
    if (!existing) {
      byObject.set(objectId, marker)
      return
    }
    // A cycle outranks a plain block; otherwise the longer wait keeps the pin.
    const promote = marker.severity === 'deadlock' && existing.severity !== 'deadlock'
    byObject.set(objectId, promote ? { ...marker, details: [...marker.details, ...existing.details] } : {
      ...existing,
      details: [...existing.details, ...marker.details],
    })
  }

  for (const request of snapshot.requests) consider(request, 'request')
  for (const task of snapshot.waitingTasks) consider(task, 'task')
  markers.push(...byObject.values())
  markers.sort((left, right) => left.objectId.localeCompare(right.objectId))

  return {
    markers,
    offPageCount,
    unresolved,
    probeReported,
    reason: probeReported
      ? snapshot.reason
      : 'No sampled request or task carried a lock resource, so no blocking is claimed either way.',
  }
}

export const SEVERITY_LABELS: Record<IncidentSeverity, string> = {
  blocked: 'Blocked waiter',
  waiting: 'Waiting',
  deadlock: 'Wait cycle',
}
