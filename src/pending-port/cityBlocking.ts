import type { LiveIncidentSnapshot, LockResource } from '../liveContracts'
import type { CapacityCityItem } from '../capacityCityContracts'
import type { LiveBlockingEdge } from './cityTraffic'
import { isBlockedReference } from '../liveIncidents'

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

/** Shared with the pin projection so the chip and the pins cannot disagree about what "blocked" is. */
function isBlocked(blocking: { blockingSessionId: number | null; sentinel: string }): boolean {
  return isBlockedReference(blocking as Parameters<typeof isBlockedReference>[0])
}

/**
 * Builds the lookup keys a resolved lock can match a loaded object by.
 *
 * Connected mode emits `<endpoint>/database/<name>/object/<object_id>` — measured against a live
 * instance, `primary/database/SimCitySmall/object/901578250`. An earlier comment here claimed the
 * format was `{databaseId}/object/{int}`, which is the key `lockKeys` used to build rather than
 * anything the API returns, so the numeric join could never match and every table-level block was
 * counted off-map. The `schema.object` name remains the primary join; the numeric id is the
 * fallback for `OBJECT:`/`TAB:` waits, which the parser resolves without a catalog lookup and which
 * therefore carry no names at all.
 */
function objectKeys(object: CapacityCityItem): string[] {
  const keys = [
    object.itemId.toLocaleLowerCase(),
    `${object.workspaceName}.${object.name}`.toLocaleLowerCase(),
  ]
  const marker = object.itemId.lastIndexOf('/object/')
  if (marker >= 0) {
    const tail = object.itemId.slice(marker + '/object/'.length)
    if (/^\d+$/.test(tail)) keys.push(`object/${tail}`)
  }
  return keys
}

/** The database segment every object id on this page shares, lowercased. */
function pageDatabaseName(objects: readonly CapacityCityItem[]): string | null {
  for (const object of objects) {
    const match = /\/database\/([^/]+)\/object\//.exec(object.itemId)
    if (match) return match[1].toLocaleLowerCase()
  }
  return null
}

export function liveBlockingEdges(
  snapshot: LiveIncidentSnapshot | null,
  objects: readonly CapacityCityItem[],
): LiveBlockingSummary {
  if (!snapshot) return EMPTY

  const byKey = new Map<string, string>()
  for (const object of objects) {
    for (const key of objectKeys(object)) byKey.set(key, object.itemId)
  }

  /*
   * Which database each sampled session ran in, so a bare `object_id` can be trusted. An object id
   * is unique only inside its own database; instance-wide it is just a number. Waiting tasks report
   * no database of their own and borrow their session's request, which is in the same sample.
   */
  const databaseBySession = new Map<number, string>()
  for (const request of snapshot.requests ?? []) {
    if (request.databaseName) {
      databaseBySession.set(request.sessionId, request.databaseName.toLocaleLowerCase())
    }
  }
  const pageDatabase = pageDatabaseName(objects)

  const resolveLockObject = (lock: LockResource, sessionId: number): string | undefined => {
    if (lock.workspaceName && lock.objectName) {
      const named = byKey.get(`${lock.workspaceName}.${lock.objectName}`.toLocaleLowerCase())
      if (named !== undefined) return named
    }
    if (lock.itemId === null) return undefined
    if (pageDatabase === null || databaseBySession.get(sessionId) !== pageDatabase) return undefined
    return byKey.get(`object/${lock.itemId}`.toLocaleLowerCase())
  }

  const waits: { lock: LockResource; sessionId: number }[] = []
  let probeReported = false
  for (const request of snapshot.requests ?? []) {
    if (request.lockResource === undefined) continue
    probeReported = true
    if (request.lockResource && isBlocked(request.blocking)) {
      waits.push({ lock: request.lockResource, sessionId: request.sessionId })
    }
  }
  for (const task of snapshot.waitingTasks ?? []) {
    if (task.lockResource === undefined) continue
    probeReported = true
    if (task.lockResource && isBlocked(task.blocking)) {
      waits.push({ lock: task.lockResource, sessionId: task.sessionId })
    }
  }

  const counts = new Map<string, number>()
  const unresolved: { rawResource: string; reason: string }[] = []
  let offPageCount = 0

  for (const { lock, sessionId } of waits) {
    if (lock.status !== 'Resolved') {
      unresolved.push({ rawResource: lock.rawResource, reason: lock.reason })
      continue
    }
    const itemId = resolveLockObject(lock, sessionId)
    if (itemId === undefined) {
      offPageCount += 1
      continue
    }
    counts.set(itemId, (counts.get(itemId) ?? 0) + 1)
  }

  const edges = [...counts.entries()]
    .map(([objectKey, blockedSessionCount]) => ({ objectKey, blockedSessionCount }))
    .sort((left, right) =>
      right.blockedSessionCount - left.blockedSessionCount ||
      left.objectKey.localeCompare(right.objectKey))

  return { edges, unresolved, offPageCount, probeReported }
}
