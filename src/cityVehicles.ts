import type { IncidentPlacement, IncidentPlacementBasis } from './cityIncidentPlacement'

/**
 * Which vehicles are on the roads, and what each one is.
 *
 * The SQL build drew one vehicle per *live execution* — a row of `sys.dm_exec_requests` running
 * when the sampler last looked, or an advance of a plan-cache execution counter. Fabric has no such
 * thing: the Capacity Metrics model reports 30-second smoothing timepoints and per-family operation
 * totals, never a list of statements executing right now. So a vehicle here is not one execution.
 * It is a measured share of a road's **operation traffic**, drawn moving so that a busy corridor
 * reads as busy from the air.
 *
 * The rules that keep it honest are the same three the road grader holds, one dimension over:
 *
 * - **An unmeasured road gets no vehicles.** `operations === null` means no family named the pair,
 *   so the map has measured nothing about how much work crosses it. Inventing vehicles there is
 *   drawing a guess in the most literal way — it is motion a reader reads as evidence. A *measured*
 *   zero (`operations === 0`) is a genuinely quiet street and also draws nothing, but it is a
 *   different, legitimate finding, and the roster counts the two apart.
 * - **Class is the operation class, not an invented size.** Interactive work drives as a car,
 *   background work as freight. The old four-rung size ladder (bicycle…semi) was banded from a
 *   query's estimated data volume, which Fabric does not publish; collapsing that band into a guess
 *   would be the vehicle form of drawing an unmeasured height. So only `car`, `semiTruck` (freight)
 *   and `unknown` are ever produced. The full {@link VehicleClass} union survives because the scene's
 *   `VEHICLE_SIZE` table and the exported `vehicles.glb` still carry all four shells.
 * - **Speed is graded off the same throttling-per-operation ratio the road colour is.** A road the
 *   grader painted dark red for heavy throttling must not carry briskly-moving traffic — that is a
 *   self-contradicting picture. So a vehicle's pace comes from {@link VehicleRoad.delayPerOperation},
 *   the very number `congestionFromDelay` colours the road from, and a missing ratio drives at the
 *   base speed rather than being read as fast or slow.
 */

/**
 * The rendered shells, plus the one that declines to say.
 *
 * `car` and `semiTruck` are the two operation classes drawn. `unknown` is an operation whose class
 * the source could not name — drawn as a featureless cube, never rounded onto a class it was not
 * measured into. `bike` and `van` are retained so the size table and the asset kit keep all four
 * shells, but the roster never produces them: Fabric has no per-operation size to put a vehicle on
 * that ladder.
 */
export type VehicleClass = 'bike' | 'car' | 'van' | 'semiTruck' | 'unknown'

/**
 * How many vehicles may be drawn.
 *
 * A bound like every other bound in this codebase, and disclosed the same way: {@link
 * VehicleRoster.capped} carries what the cap dropped, so a capped roster can never be read as a
 * quiet capacity. Blocked vehicles are kept ahead of the cap because a stopped vehicle is the one
 * thing on this map worth interrupting a reader for.
 */
export const VEHICLE_CAP = 120

/**
 * The most vehicles one class contributes from one road.
 *
 * A road's operation count spans orders of magnitude, so the count is taken from its logarithm: one
 * vehicle says "measured traffic here", a handful says "a lot", and the cap stops a single hot road
 * from spending the whole {@link VEHICLE_CAP} on itself and starving the rest of the city.
 */
export const VEHICLES_PER_ROAD_CAP = 6

/**
 * World units the *typical* vehicle covers per second, before its road's own scaling.
 *
 * Invented, and shared with the scene so the roster and the renderer agree on where a car is. The
 * number itself measures nothing: it is a drawing speed chosen to read well at map scale. Fast
 * enough that a glance can tell a moving vehicle from a stopped one, which is the single distinction
 * the roster exists to draw.
 */
export const VEHICLE_SPEED = 82

/**
 * How far a road's own speed may depart from {@link VEHICLE_SPEED}, as a fraction.
 *
 * ±15%, so the fastest car on a map is about 35% quicker than the slowest. Wide enough to notice two
 * roads keeping different paces, narrow enough that speed never competes with the class as the thing
 * a reader measures a vehicle by.
 */
export const VEHICLE_SPEED_VARIATION = 0.15

/**
 * The throttling-per-operation anchors the speed scale is drawn between, as log10 of seconds.
 *
 * -2 is 0.01 s per operation (effectively free) and 1 is 10 s per operation (heavily throttled), so
 * the ramp spans three decades. Anything at or below the free anchor drives at the full
 * `1 + variation`, anything at or above the congested one at `1 - variation`, and everything between
 * is linear **in the logarithm** because throttling is distributed across orders of magnitude.
 *
 * These are absolute, and share the reasoning `congestionFromDelay`'s thresholds use: a speed means
 * the same thing on every map, and a uniformly throttled capacity correctly shows a city where
 * *everything* crawls rather than manufacturing a spread that is not there.
 */
export const SPEED_FREE_LOG10 = -2
export const SPEED_CONGESTED_LOG10 = 1

export interface VehiclePoint {
  readonly x: number
  readonly z: number
}

/** One drawn road, as the scene actually laid it out. Same polyline the incident pins are placed on. */
export interface VehicleRoad {
  readonly routeId: string
  readonly fromItemId: string
  readonly toItemId: string
  /** Which operation families produced this road's numbers. The join from a family to a street. */
  readonly familyIds: readonly string[]
  /** Total operations of families naming both endpoints, or null when none were reported. */
  readonly operations: number | null
  /** Interactive operations on this road — drawn as cars — or null when nothing was reported. */
  readonly carOperations: number | null
  /** Background operations on this road — drawn as freight — or null when nothing was reported. */
  readonly freightOperations: number | null
  /** Mean throttling seconds per operation — what the road colour and the vehicle speed both grade from. */
  readonly delayPerOperation: number | null
  readonly polyline: readonly VehiclePoint[]
}

/**
 * Where a vehicle was halted by a throttle incident, and on what evidence.
 *
 * `basis` is {@link IncidentPlacementBasis} carried straight through from the pin, so the vehicle
 * and the pin are the same measurement rather than two computed independently. On the two road rungs
 * the vehicle halts at the point of **its own** route nearest the pin — it never changes street to
 * reach one, because the road it is on is the road its traffic graded. `frontage` means no drawn
 * road reaches the contended item, so the vehicle halts where it stood and claims no road either.
 */
export interface VehicleStop {
  readonly x: number
  readonly z: number
  readonly basis: IncidentPlacementBasis | null
  /** The road the pin was placed on. Null for `frontage`. */
  readonly pinnedRouteId: string | null
  /** One sentence for the readout. Never omitted. */
  readonly rationale: string
}

export interface Vehicle {
  readonly id: string
  /** The drawn road this vehicle travels. */
  readonly routeId: string
  readonly class: VehicleClass
  /** The road's centreline, in the direction the vehicle travels. */
  readonly points: readonly VehiclePoint[]
  /**
   * Seconds of travel this vehicle had already done when the roster was built — its phase offset
   * along the road. Deterministic per vehicle so a car does not jump when the roster is rebuilt. The
   * scene adds its own elapsed time on top, so a vehicle laps its road forever.
   */
  readonly elapsedSeconds: number
  /**
   * Always null. A Fabric vehicle is aggregate traffic, not one execution that ends, so it never
   * "finishes" and retires — it laps its road for as long as the road is drawn. Kept on the record
   * because the scene's animation shares one code path with {@link travelledFraction}'s lapping rule.
   */
  readonly finishedAfterSeconds: null
  /**
   * This vehicle's own multiplier on {@link VEHICLE_SPEED}, from its road's throttling-per-operation.
   * Fixed for the life of the car so the roster and the scene cannot disagree about where it is.
   */
  readonly speedScale: number
  /** Non-null exactly when a rejection incident halts this vehicle's road. A blocked vehicle does not move. */
  readonly blockedAt: VehicleStop | null
}

export interface VehicleRoster {
  readonly vehicles: readonly Vehicle[]
  /** Roads that carried a measured operation count, so vehicles could honestly be placed on them. */
  readonly measuredRoads: number
  /** Roads with no measured operations (`operations === null`) — drawn empty, never invented onto. */
  readonly unmeasuredRoads: number
  /** Roads measured at zero operations — a genuinely quiet street, distinct from an unmeasured one. */
  readonly quietRoads: number
  readonly cars: number
  readonly freight: number
  readonly unknown: number
  /** Vehicles halted at a rejection incident. */
  readonly blocked: number
  /** Vehicles the cap dropped. */
  readonly capped: number
  readonly cap: number
  /** Why the roster is empty or partial, in plain language. Never omitted. */
  readonly reason: string
}

export const EMPTY_ROSTER: VehicleRoster = {
  vehicles: [],
  measuredRoads: 0,
  unmeasuredRoads: 0,
  quietRoads: 0,
  cars: 0,
  freight: 0,
  unknown: 0,
  blocked: 0,
  capped: 0,
  cap: VEHICLE_CAP,
  reason: 'No roads have been graded yet, so nothing is claimed about the capacity\u2019s traffic.',
}

export interface VehicleInput {
  /** The drawn roads, exactly as the scene laid them out. */
  readonly roads: readonly VehicleRoad[]
  /**
   * Rejection incident placements keyed by the item they were pinned to. Only rejections reach here
   * (`stopsTraffic` decides that in the scene), so a placement here always means "traffic stops".
   */
  readonly blocked: ReadonlyMap<string, IncidentPlacement>
}

const STOP_RATIONALE: Readonly<Record<IncidentPlacementBasis | 'unpinned', string>> = {
  sharedRoad:
    'Stopped at the point of its route nearest the block pin, which sits on the road between the two items this rejection names.',
  objectRoad:
    'Stopped at the point of its route nearest the block pin. Only the contended item could be resolved, so that pin is on the busiest road that item is an endpoint of.',
  frontage:
    'Stopped where it was. No drawn road reaches the rejected item, so the block was pinned at a kerb rather than on a street.',
  unpinned:
    'Stopped where it was. The rejection was measured but could not be placed on a drawn road.',
}

/**
 * The multiplier a road's measured throttling puts on {@link VEHICLE_SPEED}, in `[0.85, 1.15]`.
 *
 * More throttling, slower traffic — the same ratio `congestionFromDelay` colours the road from, so
 * paint and motion never contradict. A null ratio (nothing measured) drives at exactly 1: absent is
 * neither fast nor slow, the same reading `unknown` gives the class. A measured zero is free-flowing
 * and drives at the top of the band.
 */
export function vehicleSpeedScale(delayPerOperation: number | null): number {
  if (delayPerOperation === null || !Number.isFinite(delayPerOperation)) return 1
  if (delayPerOperation <= 0) return 1 + VEHICLE_SPEED_VARIATION
  const log = Math.log10(delayPerOperation)
  const span = SPEED_CONGESTED_LOG10 - SPEED_FREE_LOG10
  const t = Math.min(1, Math.max(0, (log - SPEED_FREE_LOG10) / span))
  return 1 + VEHICLE_SPEED_VARIATION - t * 2 * VEHICLE_SPEED_VARIATION
}

/**
 * How many vehicles one class contributes from a road carrying `operations` of it.
 *
 * Zero for zero (a measured-quiet class draws nothing), then the base-10 logarithm capped at
 * {@link VEHICLES_PER_ROAD_CAP}. `null` — the class was not reported — also draws nothing here; the
 * caller decides separately whether the road as a whole was measured.
 */
export function vehicleCount(operations: number | null): number {
  if (operations === null || !Number.isFinite(operations) || operations <= 0) return 0
  return Math.min(VEHICLES_PER_ROAD_CAP, Math.max(1, Math.round(Math.log10(operations))))
}

/**
 * Builds the roster from the roads the scene drew.
 *
 * Pure: every input is something the scene already measured and laid out. An unmeasured road
 * contributes nothing; a measured one contributes cars for its interactive operations and freight
 * for its background operations, each phase-offset evenly along the road so they read as flowing
 * traffic rather than a stack at the kerb.
 */
export function buildVehicleRoster(input: VehicleInput): VehicleRoster {
  const { roads, blocked } = input

  // Which routes a rejection has pinned. A vehicle on a pinned route halts; everything else flows.
  const blockedRoutes = new Map<string, IncidentPlacement>()
  for (const placement of blocked.values()) {
    if (placement.routeId !== null) blockedRoutes.set(placement.routeId, placement)
  }

  let measuredRoads = 0
  let unmeasuredRoads = 0
  let quietRoads = 0
  const built: Vehicle[] = []

  for (const road of roads) {
    if (road.polyline.length < 2) continue
    if (road.operations === null) {
      unmeasuredRoads += 1
      continue
    }
    measuredRoads += 1
    if (road.operations === 0) {
      quietRoads += 1
      continue
    }

    const speedScale = vehicleSpeedScale(road.delayPerOperation)
    const placement = blockedRoutes.get(road.routeId) ?? null
    const length = polylineLength(road.polyline)

    // A class the source could name (`car`/`freight`), plus whatever operations it could not — drawn
    // as `unknown` rather than folded onto either class. When neither class was reported at all, the
    // whole measured count is unknown.
    const carOps = road.carOperations ?? 0
    const freightOps = road.freightOperations ?? 0
    const namedOps = carOps + freightOps
    const unknownOps =
      road.carOperations === null && road.freightOperations === null
        ? road.operations
        : Math.max(0, road.operations - namedOps)

    const emit = (klass: VehicleClass, operations: number) => {
      const count = vehicleCount(operations)
      for (let index = 0; index < count; index += 1) {
        const id = `${road.routeId}:${klass}:${index}`
        // Even phase spacing along the road, so several vehicles of one class read as a stream.
        const phase = count === 0 ? 0 : index / count
        const elapsedSeconds = length <= 0 ? 0 : (phase * length) / (VEHICLE_SPEED * speedScale)
        built.push({
          id,
          routeId: road.routeId,
          class: klass,
          points: road.polyline,
          elapsedSeconds,
          finishedAfterSeconds: null,
          speedScale,
          blockedAt: stopFor(road, placement, elapsedSeconds, length),
        })
      }
    }

    emit('car', carOps)
    emit('semiTruck', freightOps)
    emit('unknown', unknownOps)
  }

  // Blocked vehicles outrank moving ones (a halt is the news), then the deterministic id order.
  built.sort(
    (left, right) =>
      Number(right.blockedAt !== null) - Number(left.blockedAt !== null)
      || left.id.localeCompare(right.id),
  )

  const vehicles = built.slice(0, VEHICLE_CAP)
  const cars = vehicles.filter(vehicle => vehicle.class === 'car').length
  const freight = vehicles.filter(vehicle => vehicle.class === 'semiTruck').length
  const unknown = vehicles.filter(vehicle => vehicle.class === 'unknown').length
  const blockedCount = vehicles.filter(vehicle => vehicle.blockedAt !== null).length

  return {
    vehicles,
    measuredRoads,
    unmeasuredRoads,
    quietRoads,
    cars,
    freight,
    unknown,
    blocked: blockedCount,
    capped: built.length - vehicles.length,
    cap: VEHICLE_CAP,
    reason: rosterReason({
      drawn: vehicles.length,
      measuredRoads,
      unmeasuredRoads,
      quietRoads,
      capped: built.length - vehicles.length,
      blocked: blockedCount,
    }),
  }
}

/** Where a vehicle on a rejection-pinned road stops. Null when nothing pins its road. */
function stopFor(
  road: VehicleRoad,
  placement: IncidentPlacement | null,
  elapsedSeconds: number,
  length: number,
): VehicleStop | null {
  if (!placement) return null

  // Where it would have been standing had nothing stopped it, so a halt never teleports a vehicle to
  // a place no measurement put it.
  const fraction = length <= 0 ? 0 : (elapsedSeconds * VEHICLE_SPEED) / length
  const inPlace = pointAt(road.polyline, fraction % 1)

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
 * How far along its road a vehicle is, 0–1, **by arc length**, lapping forever.
 *
 * A Fabric vehicle is aggregate traffic, not one execution, so it never finishes: it laps its road
 * for as long as the road is drawn. `finishedAfterSeconds` is retained in the signature so the scene
 * and the roster share one code path, but it is always null here.
 *
 * `speedScale` defaults to 1 so the lapping tests can be written about lapping alone. Every
 * *production* call passes {@link Vehicle.speedScale}, and `vehicleSpeedWiring.test.ts` pins that,
 * because a call site that quietly took the default would draw a car at a different speed from the
 * one the roster placed it at.
 */
export function travelledFraction(
  points: readonly VehiclePoint[],
  elapsedSeconds: number,
  finishedAfterSeconds: number | null,
  speedScale = 1,
): number {
  const length = polylineLength(points)
  if (length <= 0) return 0
  const speed = VEHICLE_SPEED * (Number.isFinite(speedScale) && speedScale > 0 ? speedScale : 1)
  const travelled = (Math.max(0, elapsedSeconds) * speed) / length
  if (finishedAfterSeconds === null) return travelled % 1
  const lapsWhenFinished = Math.floor((Math.max(0, finishedAfterSeconds) * speed) / length)
  return Math.min(1, Math.max(0, travelled - lapsWhenFinished))
}

/**
 * The hue, in `[0, 1)`, that a vehicle's body is painted — derived from its id and nothing else.
 *
 * Hashed rather than drawn from `Math.random()` because the roster is rebuilt from scratch whenever
 * the roads change. A random hue would repaint the whole city on that cadence, and a vehicle that
 * changes colour while you are watching it reads as a *different* vehicle. Hashing the id makes the
 * colour a property of the vehicle, so a car keeps its paint across every rebuild.
 *
 * Hue only. The caller pairs this with one fixed saturation and one fixed lightness, so no vehicle
 * can be brighter or more washed-out than another — colour here is identity, not magnitude.
 *
 * FNV-1a over the UTF-16 code units. It avalanches well enough that ids differing in one character
 * land far apart on the wheel, which is the only property that matters.
 */
export function vehiclePaintHue(id: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return (hash >>> 0) / 4294967296
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
 * The case this exists for is an empty roster, which has causes a reader cannot tell apart by
 * looking at the map: no road carried measured traffic, every measured road was quiet, or everything
 * was capped away. Only "every measured road was quiet" is "the capacity is idle".
 */
function rosterReason(counts: {
  drawn: number
  measuredRoads: number
  unmeasuredRoads: number
  quietRoads: number
  capped: number
  blocked: number
}): string {
  const parts: string[] = []
  if (counts.measuredRoads === 0) {
    parts.push(
      counts.unmeasuredRoads === 0
        ? 'No roads have been graded, so no traffic is drawn.'
        : `No road carried a measured operation count — ${counts.unmeasuredRoads} ${plural(counts.unmeasuredRoads, 'road is', 'roads are')} drawn empty because no family named ${plural(counts.unmeasuredRoads, 'it', 'them')}, which is a gap in evidence rather than a quiet capacity.`,
    )
  } else if (counts.drawn === 0) {
    parts.push(
      `Every one of the ${counts.measuredRoads} measured ${plural(counts.measuredRoads, 'road')} carried zero operations, so the capacity is genuinely quiet.`,
    )
  } else {
    parts.push(`${counts.drawn} ${plural(counts.drawn, 'vehicle')} drawn across ${counts.measuredRoads} measured ${plural(counts.measuredRoads, 'road')}.`)
  }
  if (counts.unmeasuredRoads > 0 && counts.measuredRoads > 0) {
    parts.push(`${counts.unmeasuredRoads} unmeasured ${plural(counts.unmeasuredRoads, 'road carries', 'roads carry')} no vehicles, because no operation family named the pair.`)
  }
  if (counts.blocked > 0) {
    parts.push(`${counts.blocked} ${plural(counts.blocked, 'is', 'are')} halted at a rejection.`)
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
  if (roster.vehicles.length > 0) return `${roster.vehicles.length} driving`
  if (roster.measuredRoads === 0 && roster.unmeasuredRoads > 0) return 'Not measured'
  if (roster.measuredRoads > 0) return 'None running'
  return 'No roads'
}
