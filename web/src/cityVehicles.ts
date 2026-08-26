import type { DatabaseCityQueryFamily } from './databaseCityContracts'
import type { IncidentPlacement, IncidentPlacementBasis } from './cityIncidentPlacement'
import type { LiveRequest } from './liveContracts'

/**
 * Which vehicles are on the roads, and what each one is.
 *
 * Everything else this map draws about the workload is an *aggregate*: road colour is Query Store's
 * captured history, and it is true of the last hour rather than of this instant. A vehicle is the
 * other thing — one row of `sys.dm_exec_requests` that was running when the sampler last looked. The
 * two are never blended. A road can be dark red with no vehicle on it (the waiting happened earlier)
 * and a vehicle can drive a green road (this one execution is not what graded it).
 *
 * Three rules govern everything here, and each exists because the alternative would make the map
 * claim something nobody measured.
 *
 * - **A vehicle is only ever a sampled running request.** `requestStatus === null` is an idle session
 *   holding no request (issue #79) and produces nothing. Nothing is invented from the aggregate
 *   workload to fill an empty street, because an empty street is a finding: it means nothing was
 *   sampled here, which is not the same as nothing having run here. The live sampler runs on a 2–5 s
 *   cadence, so a query that starts and finishes between two samples never appears at all.
 * - **The join is `query_hash`, and only `query_hash`.** `sys.dm_exec_requests.query_hash` and
 *   `sys.query_store_query.query_hash` are the same `binary(8)`, rendered to the same string by both
 *   collectors. A request whose hash matches no family on this page gets no vehicle and is *counted*
 *   instead, because the alternative — matching statement text — invents a family the engine never
 *   agreed to.
 * - **Absent plan data volume is `unknown`, never the smallest class.** PR 1 publishes no
 *   `planDataVolume` at all when no retained plan stated both a row count and a row size, precisely
 *   so "the plans did not say" stays distinguishable from "this query moves very little". Collapsing
 *   the two into a bicycle would throw that distinction away.
 */

/**
 * The four sizes, plus the one that declines to say.
 *
 * The cut points are **invented**. Nothing in SQL Server divides queries into these bands; they were
 * chosen so that the four are roughly a factor of a hundred apart, which is what it takes for the
 * difference between two of them to survive being a few pixels tall on a map. The measurement being
 * banded — estimated bytes one execution moves — is the optimizer's own estimate, and an estimate
 * that is wrong is wrong here by the same factor. See `DatabaseCityPlanDataVolume.rationale`.
 */
export type VehicleClass = 'bike' | 'car' | 'van' | 'semiTruck' | 'unknown'

/** 64 KiB. Below this a query moves about a page or two and is drawn as a bicycle. */
export const CAR_FLOOR_BYTES = 65_536n
/** 8 MiB. */
export const VAN_FLOOR_BYTES = 8_388_608n
/** 512 MiB. Above this one execution moves more than most machines will cache. */
export const SEMI_FLOOR_BYTES = 536_870_912n

/**
 * How many vehicles may be drawn.
 *
 * A bound like every other bound in this codebase, and disclosed the same way: {@link
 * VehicleRoster.capped} carries what the cap dropped, so a capped roster can never be read as a
 * quiet server. Blocked requests are kept ahead of the cap because a stopped vehicle is the one
 * thing on this map worth interrupting a reader for.
 */
export const VEHICLE_CAP = 120

export interface VehiclePoint {
  readonly x: number
  readonly z: number
}

/** One drawn road, as the scene actually laid it out. Same shape the incident pins are placed from. */
export interface VehicleRoad {
  readonly routeId: string
  /** Which query families produced this road's numbers. The join from a family to a street. */
  readonly familyIds: readonly string[]
  /** Captured executions, or null when no family named the pair. Only used to break ties. */
  readonly executions: number | null
  readonly polyline: readonly VehiclePoint[]
}

/**
 * Where a blocked request's vehicle was halted, and on what evidence.
 *
 * `basis` is {@link IncidentPlacementBasis} carried straight through from the pin, so the vehicle
 * and the pin are the same measurement rather than two computed independently — with one deliberate
 * gap. `frontage` means no drawn road reaches the contended object at all, which is the placement
 * module declining to claim a road; a vehicle must not answer that by snapping to the nearest one.
 * So on `frontage` the vehicle halts where it stood and claims no road either.
 *
 * On the two road rungs the vehicle halts at the point of **its own** route nearest the pin. It
 * never changes street to reach one: the road it is on is the road its family's captured traffic
 * graded, and driving it onto another would invent a route the workload never took.
 *
 * `basis: null` is a block that was sampled but could not be pinned — the object is off this page,
 * or the lock resource named no object. The vehicle still stops, because the block is measured; it
 * just stops where it happened to be.
 */
export interface VehicleStop {
  readonly x: number
  readonly z: number
  readonly basis: IncidentPlacementBasis | null
  /** The road the **pin** was placed on. Null for `frontage` and for an unpinned block. */
  readonly pinnedRouteId: string | null
  /** One sentence for the readout. Never omitted. */
  readonly rationale: string
}

export interface Vehicle {
  readonly id: string
  readonly sessionId: number
  readonly familyId: string
  /** The drawn road this vehicle travels. */
  readonly routeId: string
  readonly class: VehicleClass
  /** The road's centreline, in the direction the vehicle travels. */
  readonly points: readonly VehiclePoint[]
  /**
   * Where along the route this vehicle starts, 0–1.
   *
   * Invented, and deterministic from the session and family so the same request sits in the same
   * place from one sample to the next instead of teleporting back to the kerb every few seconds.
   * It encodes nothing: SQL Server does not report how far through a statement a request is.
   */
  readonly phase: number
  /** Non-null exactly when the request is blocked. A blocked vehicle does not move. */
  readonly blockedAt: VehicleStop | null
}

export interface VehicleRoster {
  readonly vehicles: readonly Vehicle[]
  /** Sampled rows carrying a request status — the population a vehicle could have come from. */
  readonly sampledRunning: number
  /**
   * Running requests whose `query_hash` matched no family on this page. Real work, drawn nowhere,
   * counted here so the gap between the street and the DMV is visible rather than silent.
   */
  readonly unmatchedHash: number
  /** Matched requests whose family names no road this page drew, so there is nothing to drive. */
  readonly noRoad: number
  /** Vehicles the cap dropped. */
  readonly capped: number
  readonly cap: number
  /**
   * False when no sampled running request carried a `query_hash` field at all.
   *
   * That is what an API build older than the field looks like, and it produces an empty roster which
   * is indistinguishable from an idle instance. The reader has to be told which of the two they are
   * looking at.
   */
  readonly hashReported: boolean
  /** Why the roster is empty or partial, in plain language. Never omitted. */
  readonly reason: string
}

export const EMPTY_ROSTER: VehicleRoster = {
  vehicles: [],
  sampledRunning: 0,
  unmatchedHash: 0,
  noRoad: 0,
  capped: 0,
  cap: VEHICLE_CAP,
  hashReported: false,
  reason: 'No live snapshot has been received, so nothing is claimed about what is running now.',
}

export interface VehicleInput {
  /**
   * The live snapshot's request rows, or null when there is no snapshot. Optional at runtime the
   * way `cityIncidents.ts` treats `deadlocks`: a tab left open across a deployment can be handed a
   * payload from a build that predates the field this reads.
   */
  readonly requests: readonly LiveRequest[] | null
  readonly families: readonly DatabaseCityQueryFamily[]
  readonly roads: readonly VehicleRoad[]
  /** Incident placements keyed by the session they were pinned for. */
  readonly blocked: ReadonlyMap<number, IncidentPlacement>
}

const STOP_RATIONALE: Readonly<Record<IncidentPlacementBasis | 'unpinned', string>> = {
  sharedRoad:
    'Stopped at the point of its route nearest the block pin, which sits on the road between the two objects this wait names.',
  objectRoad:
    'Stopped at the point of its route nearest the block pin. Only the contended object could be resolved, so that pin is on the busiest road that object is an endpoint of — a road chosen by captured executions, not by what is blocking.',
  frontage:
    'Stopped where it was. No drawn road reaches the contended object, so the block was pinned at a kerb rather than on a street, and moving a vehicle to it would claim a road the placement declined to name.',
  unpinned:
    'Stopped where it was. The block was sampled but could not be placed: the contended object is not on this page, or the lock resource named no object.',
}

/**
 * Builds the roster for one bounded page.
 *
 * Pure: every input is something the caller already measured, and nothing here reads a DMV or a
 * clock. The scene calls it with the roads exactly as it drew them, so a vehicle travels a ribbon a
 * reader can see rather than the straight line between two lots that nothing draws.
 */
export function buildVehicleRoster(input: VehicleInput): VehicleRoster {
  const { requests, families, roads, blocked } = input
  if (!requests) return EMPTY_ROSTER

  const familyByHash = new Map<string, DatabaseCityQueryFamily>()
  for (const family of families) {
    const key = normalizeHash(family.queryHash)
    // Ranked families are already unique per hash; first wins so the result is order-stable anyway.
    if (key && !familyByHash.has(key)) familyByHash.set(key, family)
  }

  const roadByFamily = bestRoadPerFamily(roads)

  let sampledRunning = 0
  let unmatchedHash = 0
  let noRoad = 0
  let hashReported = false
  const built: Vehicle[] = []
  const elapsedBySession = new Map<number, number>()
  // One vehicle per session and family. A session can hold several requests at once under MARS, and
  // they are the same session driving the same street; two overlapping vehicles would read as two
  // sessions.
  const seen = new Set<string>()

  for (const request of requests) {
    // Idle sessions are sampled on purpose and are not running requests.
    if (request.requestStatus === null || request.requestStatus === undefined) continue
    sampledRunning += 1
    const elapsed = request.totalElapsedMs ?? -1
    elapsedBySession.set(request.sessionId, Math.max(elapsedBySession.get(request.sessionId) ?? -1, elapsed))

    // `undefined` is a payload with no such field; `null` is the engine reporting no hash.
    if (request.queryHash !== undefined) hashReported = true
    const hash = normalizeHash(request.queryHash ?? null)
    if (!hash) {
      unmatchedHash += 1
      continue
    }
    const family = familyByHash.get(hash)
    if (!family) {
      unmatchedHash += 1
      continue
    }

    const road = roadByFamily.get(family.familyId)
    if (!road) {
      noRoad += 1
      continue
    }

    const id = `request:${request.sessionId}:${family.familyId}`
    if (seen.has(id)) continue
    seen.add(id)

    const phase = phaseOf(request.sessionId, family.familyId)
    built.push({
      id,
      sessionId: request.sessionId,
      familyId: family.familyId,
      routeId: road.routeId,
      class: vehicleClass(family),
      points: road.polyline,
      phase,
      blockedAt: stopFor(request, road, blocked, phase),
    })
  }

  // A stopped vehicle outranks a moving one, then the longest-running request, then the session id
  // so the same sample always truncates the same tail.
  built.sort(
    (left, right) =>
      Number(right.blockedAt !== null) - Number(left.blockedAt !== null)
      || (elapsedBySession.get(right.sessionId) ?? -1) - (elapsedBySession.get(left.sessionId) ?? -1)
      || left.sessionId - right.sessionId
      || left.familyId.localeCompare(right.familyId),
  )

  const vehicles = built.slice(0, VEHICLE_CAP)
  return {
    vehicles,
    sampledRunning,
    unmatchedHash,
    noRoad,
    capped: built.length - vehicles.length,
    cap: VEHICLE_CAP,
    hashReported,
    reason: rosterReason({
      sampledRunning,
      drawn: vehicles.length,
      unmatchedHash,
      noRoad,
      capped: built.length - vehicles.length,
      hashReported,
    }),
  }
}

/**
 * Which class a family's estimated data volume puts it in.
 *
 * Absent `planDataVolume`, and anything that is not a plain non-negative decimal integer, is
 * `unknown`. Both mean the same thing to a reader — the retained plans did not support a size — and
 * neither may be rounded down into the smallest band.
 */
export function vehicleClass(family: DatabaseCityQueryFamily): VehicleClass {
  const bytes = parseBytes(family.planDataVolume?.estimatedBytesPerExecution)
  if (bytes === null) return 'unknown'
  if (bytes < CAR_FLOOR_BYTES) return 'bike'
  if (bytes < VAN_FLOOR_BYTES) return 'car'
  if (bytes < SEMI_FLOOR_BYTES) return 'van'
  return 'semiTruck'
}

/**
 * Parses one of PR 1's decimal byte strings.
 *
 * `BigInt` rather than `Number` because the product of a row count and a row size routinely exceeds
 * what a JSON number survives intact, which is why the wire format is a string in the first place.
 * Returns null for absent, empty, signed, fractional or otherwise non-integer input — every one of
 * which is "the plans did not say" rather than a size.
 */
export function parseBytes(value: string | null | undefined): bigint | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  return BigInt(trimmed)
}

/**
 * Normalizes a rendered `binary(8)` hash for comparison.
 *
 * Both collectors already render this identically — PR 1 verified that against a live instance — so
 * this is a no-op on real payloads. It exists because the failure mode of a format drift is *silent*:
 * zero vehicles, which looks exactly like a quiet server. Uppercasing and dropping a `0x` prefix
 * cannot make two different hashes equal, so it costs nothing and removes one way to fail quietly.
 *
 * The engine's all-zero "not hashed" sentinel is normalized to null by the collector, but it is
 * rejected here too: if one ever arrived it would be a family every unhashed request shared.
 */
export function normalizeHash(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toUpperCase()
  const body = trimmed.startsWith('0X') ? trimmed.slice(2) : trimmed
  if (body.length === 0 || !/^[0-9A-F]+$/.test(body)) return null
  if (/^0+$/.test(body)) return null
  return body
}

/** The busiest road each family names, so a vehicle drives the street its family's traffic graded. */
function bestRoadPerFamily(roads: readonly VehicleRoad[]): Map<string, VehicleRoad> {
  const byFamily = new Map<string, VehicleRoad>()
  for (const road of roads) {
    if (road.polyline.length < 2) continue
    for (const familyId of road.familyIds) {
      const existing = byFamily.get(familyId)
      if (!existing || busier(road, existing)) byFamily.set(familyId, road)
    }
  }
  return byFamily
}

function busier(candidate: VehicleRoad, incumbent: VehicleRoad): boolean {
  const delta = (candidate.executions ?? -1) - (incumbent.executions ?? -1)
  if (delta !== 0) return delta > 0
  return candidate.routeId.localeCompare(incumbent.routeId) < 0
}

/** Only a *blocked* request is stopped. Holding a lock nobody waits behind is just work. */
function isBlocked(request: LiveRequest): boolean {
  return request.blocking.blockingSessionId !== null || request.blocking.sentinel !== 'None'
}

function stopFor(
  request: LiveRequest,
  road: VehicleRoad,
  blocked: ReadonlyMap<number, IncidentPlacement>,
  phase: number,
): VehicleStop | null {
  if (!isBlocked(request)) return null

  // Where it would have been standing had nothing stopped it. Used whenever the pin cannot honestly
  // move it, so a halt never teleports a vehicle to a place no measurement put it.
  const inPlace = pointAt(road.polyline, phase)

  const placement = blocked.get(request.sessionId)
  if (!placement) {
    return { ...inPlace, basis: null, pinnedRouteId: null, rationale: STOP_RATIONALE.unpinned }
  }

  if (placement.basis === 'frontage') {
    return { ...inPlace, basis: 'frontage', pinnedRouteId: null, rationale: STOP_RATIONALE.frontage }
  }

  const at = nearestPointOnPolyline(road.polyline, placement)
  return {
    ...at,
    basis: placement.basis,
    pinnedRouteId: placement.routeId,
    rationale: STOP_RATIONALE[placement.basis],
  }
}

/**
 * A stable 0–1 offset from the session and one other key.
 *
 * FNV-1a over the two, so it is deterministic across reloads and across machines, and spreads
 * neighbouring session ids rather than clustering them at one end of the road.
 */
export function phaseOf(sessionId: number, key: string): number {
  let hash = 0x811c9dc5
  const text = `${sessionId}:${key}`
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 0x100000000
}

/** The point a fraction of the way along a polyline **by arc length**. */
export function pointAt(points: readonly VehiclePoint[], t: number): VehiclePoint {
  if (points.length === 0) return { x: 0, z: 0 }
  if (points.length === 1) return { x: points[0].x, z: points[0].z }
  const total = polylineLength(points)
  if (total <= 0) return { x: points[0].x, z: points[0].z }

  const target = Math.min(1, Math.max(0, t)) * total
  let walked = 0
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]
    const to = points[index]
    const segment = Math.hypot(to.x - from.x, to.z - from.z)
    if (walked + segment >= target) {
      const along = segment === 0 ? 0 : (target - walked) / segment
      return { x: from.x + (to.x - from.x) * along, z: from.z + (to.z - from.z) * along }
    }
    walked += segment
  }
  const last = points[points.length - 1]
  return { x: last.x, z: last.z }
}

/** Closest point to `target` anywhere on the polyline, including part way along a segment. */
function nearestPointOnPolyline(points: readonly VehiclePoint[], target: VehiclePoint): VehiclePoint {
  let best: VehiclePoint = { x: points[0].x, z: points[0].z }
  let bestDistance = Number.POSITIVE_INFINITY
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]
    const to = points[index]
    const dx = to.x - from.x
    const dz = to.z - from.z
    const lengthSquared = dx * dx + dz * dz
    const along = lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((target.x - from.x) * dx + (target.z - from.z) * dz) / lengthSquared))
    const candidate = { x: from.x + dx * along, z: from.z + dz * along }
    const measured = Math.hypot(candidate.x - target.x, candidate.z - target.z)
    if (measured < bestDistance) {
      bestDistance = measured
      best = candidate
    }
  }
  return best
}

export function polylineLength(points: readonly VehiclePoint[]): number {
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z)
  }
  return total
}

/**
 * What the roster is allowed to say about itself.
 *
 * The case this exists for is an empty roster, which has at least five causes that a reader cannot
 * tell apart by looking at the map: no sampled request was running, the API predates `query_hash`,
 * the hashes matched no family on this page, the families name no drawn road, or everything was
 * capped away. Only one of those is "the instance is quiet".
 */
function rosterReason(counts: {
  sampledRunning: number
  drawn: number
  unmatchedHash: number
  noRoad: number
  capped: number
  hashReported: boolean
}): string {
  const parts: string[] = []
  if (counts.sampledRunning === 0) {
    parts.push(
      'No request was running in the last sample. The sampler runs every few seconds, so a query that started and finished between two samples never appears.',
    )
  } else if (!counts.hashReported) {
    parts.push(
      `${counts.sampledRunning} running ${plural(counts.sampledRunning, 'request')} sampled, but this snapshot carries no query_hash at all — it came from an API build that predates the field, so no request can be matched to a query family. An empty road here is a missing field, not an idle instance.`,
    )
  } else {
    parts.push(
      `${counts.drawn} of ${counts.sampledRunning} sampled running ${plural(counts.sampledRunning, 'request')} drawn.`,
    )
  }
  if (counts.hashReported && counts.unmatchedHash > 0) {
    parts.push(
      `${counts.unmatchedHash} matched no query family on this page and ${plural(counts.unmatchedHash, 'is', 'are')} not drawn.`,
    )
  }
  if (counts.noRoad > 0) {
    parts.push(`${counts.noRoad} matched a family that names no road drawn on this page.`)
  }
  if (counts.capped > 0) {
    parts.push(`${counts.capped} beyond the ${VEHICLE_CAP}-vehicle cap ${plural(counts.capped, 'is', 'are')} not drawn.`)
  }
  return parts.join(' ')
}

function plural(count: number, one: string, many?: string): string {
  return count === 1 ? one : (many ?? `${one}s`)
}

/** What the folded, one-line summary of a roster says. Never "idle" unless that is what was measured. */
export function vehicleSummaryLabel(roster: VehicleRoster): string {
  if (roster.sampledRunning > 0 && !roster.hashReported) return 'Not matchable'
  if (roster.vehicles.length > 0) return `${roster.vehicles.length} running`
  if (roster.sampledRunning > 0) return `${roster.sampledRunning} unplaced`
  return 'None sampled'
}
