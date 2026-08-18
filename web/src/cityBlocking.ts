import type { LiveIncidentSnapshot, LockResource } from './liveContracts'
import type { DatabaseCityObject } from './databaseCityContracts'
import type { LiveBlockingEdge } from './cityTraffic'

/**
 * Turns live lock waits into per-object blocking evidence.
 *
 * `wait_resource` names a `hobt_id`, not an object, so a lock only pins to a building once the
 * backend lock-resource probe has resolved it. Three separate absences are kept distinct and none of
 * them is reported as "not blocked":
 *
 * - `lockResource` missing entirely — the probe has not run; nothing is claimed.
 * - `status !== 'Resolved'` — the wait was parsed but names a page, a database, or an application
 *   resource, so no object can be named without guessing. Counted in `unresolvedCount` with reasons.
 * - resolved but naming an object outside the loaded bounded page — real, but off this map. Counted
 *   in `offPageCount`.
 *
 * Only a *blocked* waiter counts. A session holding a lock that nobody is waiting behind is not
 * congestion, so `blocking.blockingSessionId` (or a sentinel) must be present.
 */

export interface LiveBlockingSummary {
  readonly edges: LiveBlockingEdge[]
  /** Waits that were reported but could not name an object, with the reason given by the parser. */
  readonly unresolved: { readonly rawResource: string; readonly reason: string }[]
  /** Resolved waits naming an object outside the loaded bounded page. */
  readonly offPageCount: number
  /** True only when at least one request or task carried a `lockResource` field at all. */
  readonly probeReported: boolean
}

const EMPTY: LiveBlockingSummary = { edges: [], unresolved: [], offPageCount: 0, probeReported: false }

function isBlocked(blocking: { blockingSessionId: number | null; sentinel: string }): boolean {
  return blocking.blockingSessionId !== null || blocking.sentinel !== 'None'
}

/**
 * Builds the lookup keys a resolved lock can match a loaded object by. Connected mode emits
 * `{databaseId}/object/{int}` object ids while the fixture emits `object:dbo:100`, so the
 * `schema.object` name is always carried as a fallback — which is why the probe returns names too.
 */
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

export function liveBlockingEdges(
  snapshot: LiveIncidentSnapshot | null,
  objects: readonly DatabaseCityObject[],
): LiveBlockingSummary {
  if (!snapshot) return EMPTY

  const byKey = new Map<string, string>()
  for (const object of objects) {
    for (const key of objectKeys(object)) byKey.set(key, object.objectId)
  }

  const waits: LockResource[] = []
  let probeReported = false
  for (const request of snapshot.requests ?? []) {
    if (request.lockResource === undefined) continue
    probeReported = true
    if (request.lockResource && isBlocked(request.blocking)) waits.push(request.lockResource)
  }
  for (const task of snapshot.waitingTasks ?? []) {
    if (task.lockResource === undefined) continue
    probeReported = true
    if (task.lockResource && isBlocked(task.blocking)) waits.push(task.lockResource)
  }

  const counts = new Map<string, number>()
  const unresolved: { rawResource: string; reason: string }[] = []
  let offPageCount = 0

  for (const lock of waits) {
    if (lock.status !== 'Resolved') {
      unresolved.push({ rawResource: lock.rawResource, reason: lock.reason })
      continue
    }
    const objectId = lockKeys(lock).map(key => byKey.get(key)).find(value => value !== undefined)
    if (objectId === undefined) {
      offPageCount += 1
      continue
    }
    counts.set(objectId, (counts.get(objectId) ?? 0) + 1)
  }

  const edges = [...counts.entries()]
    .map(([objectKey, blockedSessionCount]) => ({ objectKey, blockedSessionCount }))
    .sort((left, right) =>
      right.blockedSessionCount - left.blockedSessionCount ||
      left.objectKey.localeCompare(right.objectKey))

  return { edges, unresolved, offPageCount, probeReported }
}
