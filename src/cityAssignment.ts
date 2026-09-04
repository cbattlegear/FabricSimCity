/**
 * Loading the street network with the workload the capacity actually ran.
 *
 * Every other module here builds a city from a seed. This one is the point where measurement meets
 * it: an operation family is a journey repeated `operationCount` times between the items it touches,
 * and those items are buildings at known addresses. So the workload is a genuine origin–destination
 * matrix, and the streets can be loaded with it the way a transport model loads a real network.
 *
 * Why bother, when a single shortest path per family would draw a line just the same? Because a city
 * where every journey takes the theoretical quickest way looks wrong. In life the quickest way stops
 * being the quickest once everyone is on it, and the traffic spreads onto parallel streets; that
 * spreading is most of what makes a traffic map legible, because it is what puts different journeys
 * on different roads instead of stacking them all on one. Assigning incrementally reproduces it: the
 * busiest families are loaded first and take the main roads, later ones find those roads already
 * slow and divert, exactly as a navigation app sends the tenth caller a different way from the
 * first.
 *
 * ## What is evidence here and what is not
 *
 * The demand is measured. `operationCount` and the item ids a family touched come from Capacity Metrics
 * and are used verbatim — nothing is scaled, smoothed or invented, and a family with no executions
 * generates no trips.
 *
 * The *path* is not evidence and never was. Fabric capacities have no streets; the route drawn between two
 * buildings has always been a cartographic convenience, and this module only makes it a better one.
 * Congestion, capacity and travel time are all properties of the invented network, so they can never
 * be mistaken for a measurement of the capacity. The legend says so.
 *
 * Street geometry and road class stay purely seed-derived and are *not* touched by the assignment.
 * That is deliberate: a city whose roads changed width every time the workload shifted would be a
 * different city on every refresh, and the promise that the same capacity always draws the same map
 * would be gone. Traffic moves over the city; it does not rebuild it.
 */

import type { PlanarGraph } from './cityGraph'
import type { RoadProperties, Route } from './cityRouting'
import { RoadRouter } from './cityRouting'

/** One journey repeated `trips` times, between two junctions of the street network. */
export interface TravelDemand {
  /** Caller's identifier for the journey — an operation family id — echoed back on the assigned trip. */
  readonly key: string
  readonly fromNodeId: number
  readonly toNodeId: number
  /** How many times the journey was made. Measured; usually a family's execution count. */
  readonly trips: number
}

export interface AssignedTrip {
  readonly key: string
  readonly trips: number
  readonly route: Route
}

export interface Assignment {
  /** One entry per demand that could be routed, in the order the demands were supplied. */
  readonly trips: readonly AssignedTrip[]
  /** Trips per street, summed over every journey that used it. Keyed by edge id. */
  readonly flow: ReadonlyMap<number, number>
  /** Flow as a share of the street's capacity. Above one the street is over capacity. */
  readonly saturation: ReadonlyMap<number, number>
  /** Travel-time multiplier the assignment settled on, ≥ 1. Useful for colouring congestion. */
  readonly delay: ReadonlyMap<number, number>
  /** Demands whose endpoints were not on the network, so nothing could be routed. */
  readonly unroutable: readonly string[]
}

export interface AssignmentOptions {
  /**
   * How many slices the demand is loaded in.
   *
   * One wave is all-or-nothing shortest path with no spreading at all. Very many waves converge on
   * the mathematical equilibrium but cost a full re-routing each, and the last few move almost
   * nothing. Four is the usual practical choice and is what transport practice settled on long
   * before it was worth arguing about.
   */
  readonly waves?: number
  /** BPR coefficient: how much delay a street at exactly capacity suffers. */
  readonly alpha?: number
  /** BPR exponent: how sharply delay grows past capacity. */
  readonly beta?: number
  /**
   * Trips a single lane absorbs before the street is at capacity.
   *
   * Arbitrary, like every other absolute in the network — only the ratio between this and the
   * workload's trip counts matters, and the module normalises the workload before using it, so a
   * capacity running a million operations an hour congests its streets exactly as much as one running
   * a thousand. What would be dishonest is the reverse: letting raw operation counts decide how red
   * the map looks, so that a busy capacity appeared permanently gridlocked and a quiet one empty.
   */
  readonly capacityPerLane?: number
  /**
   * Saturation past which a street stops getting any slower.
   *
   * Some ceiling is needed because the BPR curve is quartic: a street carrying a hundred times its
   * capacity would come out tens of millions of times slower, and one absurd flow would make a whole
   * quarter of the city unreachable. The ceiling is applied to the *load* rather than to the
   * resulting delay, which matters more than it sounds. Clamping the delay makes every
   * badly-congested street cost exactly the same, so the routing can no longer tell them apart and
   * quietly reverts to picking the shortest path — the opposite of what the congestion was for.
   * Clamping the load keeps the ordering intact right up to the ceiling and only flattens beyond it.
   *
   * Three times capacity is where the analogy gives out anyway: a street that oversubscribed is a
   * car park, and how much worse it could theoretically get is not an interesting question.
   */
  readonly maxSaturation?: number
}

const DEFAULT_WAVES = 4
const DEFAULT_ALPHA = 0.15
const DEFAULT_BETA = 4
const DEFAULT_CAPACITY_PER_LANE = 0.06
const DEFAULT_MAX_SATURATION = 3

/**
 * Lanes assumed per class, used only to divide capacity between streets.
 *
 * A motorway is not eight times the width of a service road, but it does carry a great deal more
 * than eight times the traffic before it slows, because capacity comes from lanes and from not
 * having junctions every fifty metres. These numbers stand in for both.
 */
const CLASS_LANES: Record<string, number> = {
  motorway: 6,
  primary: 4,
  secondary: 3,
  tertiary: 2,
  residential: 1,
  service: 0.6,
}

/**
 * Load the network with the workload, spreading traffic off roads as they fill.
 *
 * Demands are loaded busiest first within each wave so the ordering is deterministic and matches the
 * intuition that the dominant flow gets the best road. The returned route for each demand is a final
 * pass over the settled conditions, so every journey is drawn along the way it would actually be
 * sent given the traffic already there.
 */
export function assignTraffic(
  graph: PlanarGraph,
  properties: ReadonlyMap<number, RoadProperties>,
  demands: readonly TravelDemand[],
  options: AssignmentOptions = {},
): Assignment {
  const waves = Math.max(1, Math.round(options.waves ?? DEFAULT_WAVES))
  const alpha = options.alpha ?? DEFAULT_ALPHA
  const beta = options.beta ?? DEFAULT_BETA
  const capacityPerLane = options.capacityPerLane ?? DEFAULT_CAPACITY_PER_LANE
  const maxSaturation = options.maxSaturation ?? DEFAULT_MAX_SATURATION

  const flow = new Map<number, number>()
  const delay = new Map<number, number>()
  const saturation = new Map<number, number>()
  for (const edge of graph.edges) {
    flow.set(edge.id, 0)
    delay.set(edge.id, 1)
    saturation.set(edge.id, 0)
  }

  const usable: TravelDemand[] = []
  const unroutable: string[] = []
  for (const demand of demands) {
    const ok =
      demand.trips > 0 &&
      demand.fromNodeId !== demand.toNodeId &&
      graph.nodes.has(demand.fromNodeId) &&
      graph.nodes.has(demand.toNodeId)
    if (ok) usable.push(demand)
    else unroutable.push(demand.key)
  }

  const router = new RoadRouter(graph, properties, delay)
  if (usable.length === 0) return { trips: [], flow, saturation, delay, unroutable }

  /*
   * Trips are normalised to a unit total before they are loaded. Capacity is in arbitrary units and
   * the workload is not, so without this the amount of congestion on the map would be decided by how
   * busy the capacity happens to be — which is a real measurement, but not one about the streets, and
   * showing it as gridlock would be inventing a meaning it does not have.
   */
  let totalTrips = 0
  for (const demand of usable) totalTrips += demand.trips
  const share = (demand: TravelDemand): number => demand.trips / totalTrips

  const capacity = new Map<number, number>()
  for (const edge of graph.edges) {
    const lanes = CLASS_LANES[properties.get(edge.id)?.roadClass ?? 'residential'] ?? 1
    capacity.set(edge.id, Math.max(1e-6, lanes * capacityPerLane))
  }

  const order = [...usable].sort((a, b) => b.trips - a.trips || (a.key < b.key ? -1 : 1))
  const slice = 1 / waves
  const taken = new Map<TravelDemand, Map<string, { route: Route; waves: number; first: number }>>()

  const recost = (edgeId: number): void => {
    const ratio = (flow.get(edgeId) ?? 0) / capacity.get(edgeId)!
    saturation.set(edgeId, ratio)
    const charged = Math.min(maxSaturation, ratio)
    delay.set(edgeId, 1 + alpha * Math.pow(charged, beta))
  }

  /*
   * Costs are updated after every single journey rather than once per wave. Textbook incremental
   * assignment does it per wave, which is enough to converge on the equilibrium flows, but it has a
   * side effect that shows badly on a map: two journeys between the same two places, loaded in the
   * same wave, see identical conditions and are drawn on top of each other. Recosting as we go means
   * the second one already finds the first one's traffic there and goes round, which is both what
   * happens in life and what makes the traffic legible when it is drawn.
   */
  for (let wave = 0; wave < waves; wave += 1) {
    for (const demand of order) {
      const route = router.route(demand.fromNodeId, demand.toNodeId)
      if (route === null) continue
      const ways = taken.get(demand) ?? new Map()
      taken.set(demand, ways)
      const signature = route.edgeIds.join(',')
      const seen = ways.get(signature)
      if (seen === undefined) ways.set(signature, { route, waves: 1, first: wave })
      else seen.waves += 1

      const load = share(demand) * slice
      for (const edgeId of route.edgeIds) {
        flow.set(edgeId, (flow.get(edgeId) ?? 0) + load)
        recost(edgeId)
      }
    }
  }

  /*
   * The loaded flows above are shares of the workload; report them back in the caller's own units so
   * a consumer can say "this street carries 40,000 executions" without having to undo the
   * normalisation. Saturation and delay stay dimensionless, because that is all they ever were.
   */
  for (const edge of graph.edges) flow.set(edge.id, (flow.get(edge.id) ?? 0) * totalTrips)

  /*
   * A journey that got split across several ways is drawn along the one it used most, ties going to
   * whichever it found first.
   *
   * The obvious alternative — route everything once more at the end, over the settled traffic — is
   * wrong in a way that takes a moment to see. By then a journey's own trips are on the road, and a
   * family big enough to fill a street would be diverted around traffic that is entirely its own,
   * ending up drawn on a back street while the main road it actually put the traffic on sits empty.
   * Taking the modal way keeps the load where it belongs and still lets a genuinely contested route
   * shift onto the parallel street that most of its trips really used.
   */
  const trips: AssignedTrip[] = []
  for (const demand of usable) {
    const ways = taken.get(demand)
    if (ways === undefined || ways.size === 0) {
      unroutable.push(demand.key)
      continue
    }
    let best: { route: Route; waves: number; first: number } | null = null
    for (const way of ways.values()) {
      if (best === null || way.waves > best.waves || (way.waves === best.waves && way.first < best.first)) {
        best = way
      }
    }
    trips.push({ key: demand.key, trips: demand.trips, route: best!.route })
  }

  return { trips, flow, saturation, delay, unroutable }
}

/**
 * Turn an operation family into the journeys it implies.
 *
 * A family that touches three items is not three journeys from a depot — it is a tour, and the
 * traffic it puts on the streets is the traffic of going between those items. Consecutive pairs
 * along the tour are used rather than every pair, because a family touching twelve items would
 * otherwise generate sixty-six journeys and swamp a family touching two, purely from the shape of
 * the operation rather than from how often it ran.
 *
 * The tour is walked in the order the caller supplied the addresses. Callers should sort that order
 * however the map already groups buildings — by neighbourhood, say — so the tour reads as one trip
 * across town rather than a scribble.
 */
export function tourDemands(
  key: string,
  nodeIds: readonly number[],
  trips: number,
): TravelDemand[] {
  const stops = nodeIds.filter((id, index) => nodeIds.indexOf(id) === index)
  if (stops.length < 2) return []
  const demands: TravelDemand[] = []
  for (let index = 0; index + 1 < stops.length; index += 1) {
    demands.push({
      key: stops.length === 2 ? key : `${key}:${index}`,
      fromNodeId: stops[index],
      toNodeId: stops[index + 1],
      trips,
    })
  }
  return demands
}
