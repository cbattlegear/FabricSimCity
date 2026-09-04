import { assignTraffic, tourDemands, type TravelDemand } from './cityAssignment'
import { dedupePoints, nearestIntersectionId, type CityPlan } from './cityPlan'
import type { OperationClass, OperationFamily } from './capacityCityContracts'
import {
  CONGESTION_COLORS,
  congestionFromDelay,
  trafficModeForClass,
  type CongestionGrade,
  type TrafficMode,
} from './cityTraffic'

/**
 * Building the capacity's traffic map out of the workload itself.
 *
 * Every ranked operation family is driven through the items it touched, once per measured operation,
 * and what accumulates on each street is the traffic layer. This is the aggregate view the map shows
 * by default. A single family's *path* is a detail you ask for by selecting it; what you want to see
 * standing back is which parts of town are busy and which are being held at a throttle gate, which is
 * a property of the whole workload rather than of any one family.
 *
 * Two quantities accumulate per street, and they are kept apart on purpose because they answer
 * different questions and are measured differently:
 *
 * - **operations** — Capacity Metrics' operation count for every family whose drawn journey uses this
 *   street, summed. Measured, and nothing else. It is reported, not drawn: street width is a constant
 *   now, for the reason given on {@link ./cityTraffic}.
 * - **throttling seconds** — the throttling time apportioned to the items at each end of the leg. The
 *   seconds are measured; how they are divided across the items a family touched is this module's
 *   model, because Capacity Metrics attributes throttling to a *family*, not to each item within it.
 *   Colour comes from the ratio of the two — the mean throttling one operation carried over the
 *   street.
 *
 * There is deliberately no single blended "traffic score". Operations are a count and throttling is a
 * duration; a number mixing them would have no unit and no way to be checked against anything the
 * capacity reported. Two honest channels beat one invented one — even now that only one of them is
 * drawn.
 *
 * Interactive and background operations travel as different vehicles — cars and freight — because
 * they queue at different gates and genuinely take different routes. The per-street split is carried
 * on {@link StreetLoad} so the scene can draw each stream as its own vehicle rather than one blended
 * flow.
 *
 * The route between two items remains invented — a capacity has no streets — so which street a
 * family's traffic lands on is scenery, and the legend says so. What the traffic is *made of* is not.
 *
 * The ladder that turns the ratio into a colour lives in {@link ./cityTraffic}, so a street and the
 * co-reference road running along it are graded by one rule rather than by two that agree by
 * coincidence.
 */

export interface StreetLoad {
  readonly edgeId: number
  /** Measured operations routed over this street. */
  readonly operations: number
  /** Interactive operations routed here — drawn as cars. */
  readonly carOperations: number
  /** Background operations routed here — drawn as freight. */
  readonly freightOperations: number
  /**
   * Apportioned throttling seconds the journeys crossing this street carried. Like `operations`, this
   * is a per-traversal intensity rather than a divisible share: a street is charged the whole
   * throttling of every leg that crosses it, so summing this across streets is meaningless. The two
   * fields divide cleanly into each other, which is the only use it is put to.
   */
  readonly throttlingSeconds: number
  /** Mean throttling one operation carried over this street, or null when it was never measured. */
  readonly delayPerOperation: number | null
  readonly grade: CongestionGrade
  readonly color: number
  readonly points: ReadonlyArray<{ x: number; z: number }>
}

/** One family's journey through the items it touched, drawn only when that family is selected. */
export interface FamilyTrip {
  readonly familyId: string
  readonly operationClass: OperationClass
  /** Whether this family drives as a car (interactive) or freight (background). */
  readonly mode: TrafficMode
  /** Item ids in visit order. Never a facility: an operation does not drive to the CPU yard. */
  readonly stops: readonly string[]
  readonly edgeIds: readonly number[]
  readonly points: Array<{ x: number; z: number }>
  readonly operations: number
  readonly throttlingSeconds: number
}

export interface WorkloadTraffic {
  /** Loaded streets, keyed by graph edge id. Streets nothing routed over are absent, not zero. */
  readonly streets: ReadonlyMap<number, StreetLoad>
  readonly trips: ReadonlyMap<string, FamilyTrip>
  /** Largest operation count on any one street, for scaling. */
  readonly busiest: number
  /** Families with an item on this page but no journey to make from it. */
  readonly resident: readonly string[]
  /** Families whose items could not be placed on the street network. */
  readonly unroutable: readonly string[]
  readonly note: string
}

const EMPTY: WorkloadTraffic = {
  streets: new Map(),
  trips: new Map(),
  busiest: 0,
  resident: [],
  unroutable: [],
  note: 'No ranked operation family could be routed through this page, so no traffic is drawn.',
}

export { congestionFromDelay }

/**
 * A family's estimated importance per item, used only to pick where its journey starts.
 *
 * Capacity Metrics names the primary item a family is attributed to first in `itemIds`; the rest are
 * co-touched lineage endpoints. So the journey starts at the primary item — the item the family is
 * really about — which {@link visitOrder} reads off this map. No finer per-item cost breakdown exists
 * in the source, so this is a rank, not a measurement, and it is used for ordering alone.
 */
function primaryShares(family: OperationFamily): Map<string, number> {
  const shares = new Map<string, number>()
  family.itemIds.forEach((itemId, index) => shares.set(itemId, index === 0 ? 1 : 0))
  return shares
}

/**
 * A family's measured throttling seconds, split evenly across the items it touched.
 *
 * **The even split is a model, and it is the only defensible one.** Capacity Metrics reports a single
 * throttling figure per operation family and never attributes it to individual items, so there is no
 * measured breakdown to spread. Weighting it by anything — operation count, storage, guesswork —
 * would invent a per-item claim the source never made. An even split invents no ranking; it says only
 * "this much throttling happened somewhere along this family's journey", which is exactly what was
 * measured. Returns null seconds against every item when the family's throttling was not measured, so
 * an unmeasured family never contributes a zero that reads as measured.
 */
function throttlingByItem(family: OperationFamily): { seconds: Map<string, number>; measured: boolean } {
  const seconds = new Map<string, number>()
  const measured = family.throttlingSeconds !== null && Number.isFinite(family.throttlingSeconds)
  const total = measured ? (family.throttlingSeconds as number) : 0
  const ids = family.itemIds
  const each = ids.length > 0 && total > 0 ? total / ids.length : 0
  for (const id of ids) seconds.set(id, each)
  return { seconds, measured }
}

/**
 * Orders a family's items into the journey it makes.
 *
 * Capacity Metrics hands back the items a family touched as a set, so an order has to be chosen. It
 * starts at the primary item — the one the family is attributed to — and walks to the nearest item it
 * has not visited yet. That produces a journey across town rather than a scribble, and it is fixed by
 * the data rather than by chance, so the same family always drives the same way.
 */
export function visitOrder(
  itemIds: readonly string[],
  shares: ReadonlyMap<string, number>,
  positionOf: (itemId: string) => { x: number; z: number } | null,
): string[] {
  const placed = itemIds
    .filter(itemId => positionOf(itemId) !== null)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (placed.length < 2) return placed

  let start = placed[0]
  let best = shares.get(start) ?? 0
  for (const itemId of placed) {
    const share = shares.get(itemId) ?? 0
    if (share > best) {
      best = share
      start = itemId
    }
  }

  const remaining = new Set(placed)
  remaining.delete(start)
  const order = [start]
  let current = positionOf(start)!
  while (remaining.size > 0) {
    let nearest: string | null = null
    let nearestDistance = Number.POSITIVE_INFINITY
    for (const itemId of remaining) {
      const point = positionOf(itemId)!
      const distance = (point.x - current.x) ** 2 + (point.z - current.z) ** 2
      // Ties resolve by id so the walk never depends on set iteration order.
      if (distance < nearestDistance || (distance === nearestDistance && nearest !== null && itemId < nearest)) {
        nearestDistance = distance
        nearest = itemId
      }
    }
    if (nearest === null) break
    remaining.delete(nearest)
    order.push(nearest)
    current = positionOf(nearest)!
  }
  return order
}

function toNumber(value: string | null | undefined): number {
  if (value === null || value === undefined || value.trim() === '') return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function assignWorkloadTraffic(
  plan: CityPlan,
  families: readonly OperationFamily[],
): WorkloadTraffic {
  if (families.length === 0) return EMPTY

  const nodeByObject = new Map<string, number | null>()
  const nodeFor = (itemId: string): number | null => {
    const cached = nodeByObject.get(itemId)
    if (cached !== undefined) return cached
    const lot = plan.lots.get(itemId)
    const nearest = lot
      ? plan.intersections.get(nearestIntersectionId(plan, lot.accessX, lot.accessZ))
      : undefined
    const node = nearest ? nearest.col : null
    nodeByObject.set(itemId, node)
    return node
  }
  const positionOf = (itemId: string): { x: number; z: number } | null => {
    const lot = plan.lots.get(itemId)
    return lot && nodeFor(itemId) !== null ? { x: lot.accessX, z: lot.accessZ } : null
  }

  const demands: TravelDemand[] = []
  const routed = new Map<
    number,
    { family: OperationFamily; stops: string[]; throttle: Map<string, number>; measured: boolean }
  >()
  const resident: string[] = []
  const unroutable: string[] = []

  families.forEach((family, index) => {
    const operations = toNumber(family.operationCount)
    const ordered = visitOrder(family.itemIds, primaryShares(family), positionOf)
    // Two items can share a kerb, and the assignment collapses repeated stops, so collapse them here
    // too or the legs stop lining up with the items they connect.
    const seen = new Set<number>()
    const stops = ordered.filter(itemId => {
      const node = nodeFor(itemId)!
      if (seen.has(node)) return false
      seen.add(node)
      return true
    })
    if (stops.length === 0) {
      unroutable.push(family.familyId)
      return
    }
    if (stops.length < 2) {
      // One item on this page: the family's throttling belongs to that item, and it does, but there is
      // no journey to spread over the streets.
      resident.push(family.familyId)
      return
    }
    if (operations <= 0) {
      resident.push(family.familyId)
      return
    }

    const throttle = throttlingByItem(family)
    routed.set(index, { family, stops, throttle: throttle.seconds, measured: throttle.measured })
    const nodeIds = stops.map(itemId => nodeFor(itemId)!)
    for (const demand of tourDemands(String(index), nodeIds, operations)) demands.push(demand)
  })

  if (demands.length === 0) {
    return { ...EMPTY, resident, unroutable, note: note(0, 0, resident.length, unroutable.length) }
  }

  const assignment = assignTraffic(plan.graph, plan.roadProperties, demands)
  const edgeById = new Map(plan.graph.edges.map(edge => [edge.id, edge]))

  for (const key of assignment.unroutable) {
    const index = Number.parseInt(key.split(':')[0], 10)
    const entry = routed.get(index)
    if (entry && !unroutable.includes(entry.family.familyId)) unroutable.push(entry.family.familyId)
  }

  const operationsByEdge = new Map<number, number>()
  const carByEdge = new Map<number, number>()
  const freightByEdge = new Map<number, number>()
  const throttleByEdge = new Map<number, number>()
  const measuredByEdge = new Map<number, boolean>()
  const tripEdges = new Map<number, number[]>()
  const tripPoints = new Map<number, Array<{ x: number; z: number }>>()

  for (const trip of assignment.trips) {
    const index = Number.parseInt(trip.key.split(':')[0], 10)
    const entry = routed.get(index)
    if (!entry) continue

    // Which leg this is, so the throttling of the two items it connects can be charged to it.
    const legIndex = trip.key.includes(':')
      ? Number.parseInt(trip.key.slice(trip.key.indexOf(':') + 1), 10)
      : 0
    // Each item's apportioned throttling is spread across the legs that touch it: the two end stops
    // have one adjacent leg each and take it whole, an interior stop has two and splits it evenly.
    // Summed over the legs this returns the family's apportioned total exactly, so the street charges
    // reconcile with the items the way every other total in this codebase does. Halving both ends
    // instead would quietly discard the outer halves of the first and last stop.
    const legCount = entry.stops.length - 1
    const shareOf = (stopIndex: number): number => {
      const itemId = entry.stops[stopIndex]
      const throttle = entry.throttle.get(itemId) ?? 0
      const adjacentLegs = stopIndex === 0 || stopIndex === legCount ? 1 : 2
      return throttle / adjacentLegs
    }
    const legThrottle = shareOf(legIndex) + shareOf(legIndex + 1)
    const mode = trafficModeForClass(entry.family.operationClass)

    for (const edgeId of trip.route.edgeIds) {
      operationsByEdge.set(edgeId, (operationsByEdge.get(edgeId) ?? 0) + trip.trips)
      if (mode === 'car') carByEdge.set(edgeId, (carByEdge.get(edgeId) ?? 0) + trip.trips)
      else if (mode === 'freight') freightByEdge.set(edgeId, (freightByEdge.get(edgeId) ?? 0) + trip.trips)
      throttleByEdge.set(edgeId, (throttleByEdge.get(edgeId) ?? 0) + legThrottle)
      if (entry.measured) measuredByEdge.set(edgeId, true)
    }

    const edges = tripEdges.get(index) ?? []
    edges.push(...trip.route.edgeIds)
    tripEdges.set(index, edges)

    const points = tripPoints.get(index) ?? []
    const leg = trip.route.path.map(point => ({ x: point.x, z: point.z }))
    points.push(...leg)
    tripPoints.set(index, points)
  }

  const streets = new Map<number, StreetLoad>()
  let busiest = 0
  for (const [edgeId, operations] of operationsByEdge) {
    const edge = edgeById.get(edgeId)
    if (!edge || operations <= 0) continue
    const throttlingSeconds = throttleByEdge.get(edgeId) ?? 0
    const measured = measuredByEdge.get(edgeId) ?? false
    const delayPerOperation = throttlingSeconds / operations
    // A street no measured family routed over is graded unknown and drawn grey: unmeasured, not clear.
    // A measured street with zero throttling is genuinely free-flowing, so it grades free, not grey.
    const grade = measured ? congestionFromDelay(delayPerOperation) : 'unknown'
    busiest = Math.max(busiest, operations)
    streets.set(edgeId, {
      edgeId,
      operations,
      carOperations: carByEdge.get(edgeId) ?? 0,
      freightOperations: freightByEdge.get(edgeId) ?? 0,
      throttlingSeconds,
      delayPerOperation: measured ? delayPerOperation : null,
      grade,
      color: CONGESTION_COLORS[grade],
      points: edge.points,
    })
  }

  const trips = new Map<string, FamilyTrip>()
  for (const [index, entry] of routed) {
    const points = tripPoints.get(index)
    if (!points || points.length === 0) continue
    let throttlingSeconds = 0
    for (const value of entry.throttle.values()) throttlingSeconds += value
    const first = plan.lots.get(entry.stops[0])!
    const last = plan.lots.get(entry.stops[entry.stops.length - 1])!
    // The assigned route runs junction to junction; bookend it with the kerb each item is entered
    // from, so the drawn journey meets its doors and not the nearest corner.
    trips.set(entry.family.familyId, {
      familyId: entry.family.familyId,
      operationClass: entry.family.operationClass,
      mode: trafficModeForClass(entry.family.operationClass),
      stops: entry.stops,
      edgeIds: tripEdges.get(index) ?? [],
      points: dedupePoints([
        { x: first.accessX, z: first.accessZ },
        ...points,
        { x: last.accessX, z: last.accessZ },
      ]),
      operations: toNumber(entry.family.operationCount),
      throttlingSeconds,
    })
  }

  return {
    streets,
    trips,
    busiest,
    resident,
    unroutable,
    note: note(streets.size, trips.size, resident.length, unroutable.length),
  }
}

function note(streets: number, trips: number, resident: number, unroutable: number): string {
  if (trips === 0) {
    return (
      'No ranked family touches two items on this page, so there is no traffic to spread over the streets. ' +
      'Throttling apportioned to individual items is unaffected.'
    )
  }
  const parts = [
    `${trips.toLocaleString()} ranked operation families are driven through the items they touched, ` +
    `once per measured operation, loading ${streets.toLocaleString()} streets.`,
  ]
  if (resident > 0) {
    parts.push(
      `${resident.toLocaleString()} more reach only one item here and make no journey; their throttling still lands on that item.`,
    )
  }
  if (unroutable > 0) {
    parts.push(`${unroutable.toLocaleString()} name no item this page draws.`)
  }
  parts.push(
    'Operations and throttling seconds are measured. Which street they were driven along is not: a capacity has no streets.',
  )
  return parts.join(' ')
}
