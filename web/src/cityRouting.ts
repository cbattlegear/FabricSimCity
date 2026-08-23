import type { GraphEdge, PlanarGraph } from './cityGraph'
import type { Point } from './cityStreamlines'

/**
 * Road hierarchy, speed limits and route finding.
 *
 * Two things are going on here and it is worth separating them.
 *
 * The **hierarchy** is discovered, not declared. Every street starts equal, and the arterials are
 * found by measuring which streets the most journeys would have to use — betweenness centrality over
 * the network. That is how real road hierarchies came about: a lane becomes a main road because it is
 * on the way to somewhere, and the traffic it then carries is what justifies widening it. Painting a
 * few streets "arterial" by rule would put main roads where the network does not want them, and the
 * eye notices, because a main road that leads nowhere in particular looks wrong even when you cannot
 * say why.
 *
 * The **routing** is then travel time rather than distance. Distance-only routing sends journeys down
 * whatever back street happens to be marginally shorter, which produces exactly the wrong picture:
 * traffic spread evenly over every street, with no arterials carrying more than their neighbours. A
 * real satnav weighs speed limits and penalises turns, and the result is that journeys collect onto
 * the main roads and stay there until they are close to their destination.
 *
 * Everything in this module is decoration. Road class and speed limit are cartographic properties of
 * a *drawn* street, derived from the seeded geometry alone; they say nothing about the database, and
 * no measured quantity is read here. What routes *along* these streets — the query traffic — is the
 * measurement, and it is untouched.
 */

export type RoadClass = 'motorway' | 'primary' | 'secondary' | 'tertiary' | 'residential' | 'service'

export interface RoadProperties {
  readonly roadClass: RoadClass
  /**
   * Design speed in map units per second.
   *
   * Ratios follow the usual urban ladder — a primary road roughly twice a residential street — so
   * that routes prefer main roads by about the margin they do in life. The absolute values are
   * arbitrary because the map has no real scale; only the ratios reach the screen.
   */
  readonly speedLimit: number
  /** Carriageway width in map units, before any traffic ribbon is drawn on top. */
  readonly width: number
  /** Share of all shortest paths through the network that use this street, in `[0, 1]`. */
  readonly betweenness: number
}

/**
 * Speed and width per class.
 *
 * The speed ladder is the OSM urban convention compressed into map units: motorway 100, primary 60,
 * secondary 50, tertiary 40, residential 30, service 20 km/h, scaled so a residential street runs at
 * roughly one map unit per second.
 */
const CLASS_PROPERTIES: Record<RoadClass, { speed: number; width: number }> = {
  motorway: { speed: 3.4, width: 3.6 },
  primary: { speed: 2.0, width: 2.8 },
  secondary: { speed: 1.7, width: 2.2 },
  tertiary: { speed: 1.35, width: 1.7 },
  residential: { speed: 1.0, width: 1.3 },
  service: { speed: 0.68, width: 0.95 },
}

/**
 * Share of the network in each class, counted from the busiest street down.
 *
 * Classification is by *rank*, not by betweenness relative to the busiest street, and the difference
 * matters more than it looks. A threshold on relative betweenness assumes the distribution has a
 * clear peak — one dominant arterial everything funnels through — and gives a clean hierarchy when
 * it does. A city built from overlapping district grains has no such peak: centrality is spread over
 * many roughly equal cross-town routes, they all sit near the maximum, and a third of the network is
 * promoted to arterial. A third of the streets being main roads is not a hierarchy, and the map
 * stops being readable from the weight of its lines, which is the one job the classification has.
 *
 * Fixing the proportions instead guarantees the ladder reads on any network, from a six-table
 * database to a six-thousand-table one, and it is honest about what betweenness measures: not an
 * absolute importance but a ranking. "This street is in the busiest three per cent" is exactly the
 * claim the algorithm supports.
 *
 * The proportions are roughly those of a real road network — arterials are a few per cent of the
 * length and carry most of the traffic, which is what makes a road atlas legible at a glance.
 */
const CLASS_SHARES: ReadonlyArray<{ roadClass: RoadClass; upTo: number }> = [
  { roadClass: 'motorway', upTo: 0.03 },
  { roadClass: 'primary', upTo: 0.09 },
  { roadClass: 'secondary', upTo: 0.19 },
  { roadClass: 'tertiary', upTo: 0.35 },
  { roadClass: 'residential', upTo: 0.8 },
]

/**
 * Junctions a network needs before it may have a motorway.
 *
 * The top class of a nine-street village is still a village street. Without a floor, rank-based
 * classification hands the busiest edge of any network the widest road on the map, and a hamlet gets
 * a four-lane bypass through the middle of it.
 */
const MOTORWAY_MIN_EDGES = 60

/**
 * Above this many junctions the betweenness sweep samples its sources rather than running from
 * every one. Three hundred and twenty sources is comfortably enough for a stable ranking — the
 * estimator's error falls with the square root of the sample, and the bands are wide.
 */
const BETWEENNESS_MAX_SOURCES = 320

export function classifyRoads(graph: PlanarGraph): Map<number, RoadProperties> {
  const betweenness = edgeBetweenness(graph)
  let peak = 0
  for (const value of betweenness.values()) peak = Math.max(peak, value)

  /*
   * A dead end is never a through route however the numbers fall. Betweenness already says so, but a
   * cul-de-sac hanging off a very busy street can still rank high enough to be promoted, and a
   * four-lane road that stops after thirty metres is the sort of detail that makes a generated map
   * look generated. They are set aside before ranking so they do not consume arterial places either.
   */
  const dangling = new Set<number>()
  for (const edge of graph.edges) {
    if ((graph.incident.get(edge.fromId)?.length ?? 0) <= 1 ||
        (graph.incident.get(edge.toId)?.length ?? 0) <= 1) {
      dangling.add(edge.id)
    }
  }

  const ranked = graph.edges
    .filter(edge => !dangling.has(edge.id))
    .map(edge => ({ id: edge.id, score: betweenness.get(edge.id) ?? 0 }))
    .sort((a, b) => b.score - a.score || a.id - b.id)

  const properties = new Map<number, RoadProperties>()
  const total = ranked.length
  ranked.forEach((entry, rank) => {
    const position = total === 0 ? 1 : rank / total
    let roadClass: RoadClass = CLASS_SHARES.find(band => position < band.upTo)?.roadClass ?? 'service'
    if (roadClass === 'motorway' && graph.edges.length < MOTORWAY_MIN_EDGES) roadClass = 'primary'
    const base = CLASS_PROPERTIES[roadClass]
    properties.set(entry.id, {
      roadClass,
      speedLimit: base.speed,
      width: base.width,
      betweenness: peak === 0 ? 0 : entry.score / peak,
    })
  })

  for (const edgeId of dangling) {
    const base = CLASS_PROPERTIES.service
    properties.set(edgeId, {
      roadClass: 'service',
      speedLimit: base.speed,
      width: base.width,
      betweenness: peak === 0 ? 0 : (betweenness.get(edgeId) ?? 0) / peak,
    })
  }
  return properties
}

/**
 * Brandes' algorithm for edge betweenness, unweighted.
 *
 * Counts, for every pair of junctions, how many of the shortest routes between them run along each
 * street, which is the standard measure of how central a street is to getting about. Unweighted —
 * hops rather than metres — deliberately: weighting by length would make the hierarchy depend on the
 * arbitrary scale of the city and would rank a single long suburban road above the short busy streets
 * of a centre that everything actually passes through.
 *
 * Exact betweenness is `O(V·E)`, and a six-thousand-table database draws a city with five thousand
 * junctions, so the exact figure costs several seconds of a blocked main thread. Above
 * `BETWEENNESS_MAX_SOURCES` junctions the sweep runs from a sample of sources and the totals are
 * scaled back up, which is the standard estimator for this measure (Brandes and Pich, 2007). The
 * approximation is very cheap here because the result is only ever used as a *ranking*: an edge
 * needs to land in the right band of the hierarchy, not to carry a correct absolute figure, and the
 * band boundaries are quantiles of the same sampled distribution. The sample is a fixed stride
 * through the junctions rather than a random draw, so it is spread evenly and, more importantly,
 * identical on every run — the same database must always draw the same city.
 */
export function edgeBetweenness(
  graph: PlanarGraph,
  options: { maxSources?: number } = {},
): Map<number, number> {
  const maxSources = options.maxSources ?? BETWEENNESS_MAX_SOURCES
  const nodeIds = [...graph.nodes.keys()].sort((a, b) => a - b)
  const index = new Map<number, number>()
  nodeIds.forEach((id, position) => index.set(id, position))
  const count = nodeIds.length
  const scores = new Map<number, number>()
  for (const edge of graph.edges) scores.set(edge.id, 0)
  if (count < 2) return scores

  // Adjacency as a flat compressed row, so the inner loop touches three typed arrays and allocates
  // nothing. The array-of-arrays this replaces cost more in allocation than the search did in work.
  const degree = new Int32Array(count)
  for (const edge of graph.edges) {
    const from = index.get(edge.fromId)
    const to = index.get(edge.toId)
    if (from === undefined || to === undefined) continue
    degree[from] += 1
    degree[to] += 1
  }
  const offset = new Int32Array(count + 1)
  for (let i = 0; i < count; i += 1) offset[i + 1] = offset[i] + degree[i]
  const links = offset[count]
  const linkTo = new Int32Array(links)
  const linkEdge = new Int32Array(links)
  const cursor = offset.slice(0, count)
  for (const edge of graph.edges) {
    const from = index.get(edge.fromId)
    const to = index.get(edge.toId)
    if (from === undefined || to === undefined) continue
    linkTo[cursor[from]] = to
    linkEdge[cursor[from]] = edge.id
    cursor[from] += 1
    linkTo[cursor[to]] = from
    linkEdge[cursor[to]] = edge.id
    cursor[to] += 1
  }

  const sigma = new Float64Array(count)
  const delta = new Float64Array(count)
  const distance = new Int32Array(count)
  const queue = new Int32Array(count)
  const stack = new Int32Array(count)
  // A node's predecessors on shortest paths are always a subset of its neighbours, so they fit in
  // the space the adjacency already reserved for it and the buffer can be reused for every source.
  const predNode = new Int32Array(links)
  const predEdge = new Int32Array(links)
  const predCount = new Int32Array(count)
  const totals = new Float64Array(graph.edges.length)

  const stride = count > maxSources ? Math.floor(count / maxSources) : 1
  let sampled = 0

  for (let source = 0; source < count; source += stride) {
    sampled += 1
    sigma.fill(0)
    delta.fill(0)
    distance.fill(-1)
    predCount.fill(0)
    sigma[source] = 1
    distance[source] = 0
    let tail = 0
    let read = 0
    let depth = 0
    queue[tail] = source
    tail += 1
    while (read < tail) {
      const node = queue[read]
      read += 1
      stack[depth] = node
      depth += 1
      const next = distance[node] + 1
      for (let i = offset[node]; i < offset[node + 1]; i += 1) {
        const to = linkTo[i]
        if (distance[to] < 0) {
          distance[to] = next
          queue[tail] = to
          tail += 1
        }
        if (distance[to] === next) {
          sigma[to] += sigma[node]
          const slot = offset[to] + predCount[to]
          predNode[slot] = node
          predEdge[slot] = linkEdge[i]
          predCount[to] += 1
        }
      }
    }
    while (depth > 0) {
      depth -= 1
      const node = stack[depth]
      const share = (1 + delta[node]) / sigma[node]
      for (let i = offset[node]; i < offset[node] + predCount[node]; i += 1) {
        const from = predNode[i]
        const contribution = sigma[from] * share
        delta[from] += contribution
        totals[predEdge[i]] += contribution
      }
    }
  }

  // Every pair was counted from both ends. A sampled sweep saw `sampled` of the `count` sources, so
  // scaling by the shortfall keeps the figures comparable with an exact run on a smaller city.
  const scale = count / (sampled * 2)
  for (const edge of graph.edges) scores.set(edge.id, totals[edge.id] * scale)
  return scores
}

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

export interface RouteRequest {
  readonly fromNodeId: number
  readonly toNodeId: number
}

export interface Route {
  readonly nodeIds: readonly number[]
  readonly edgeIds: readonly number[]
  /** Sampled centre line of the whole journey, ready to draw or to drive along. */
  readonly path: readonly Point[]
  readonly distance: number
  readonly travelTime: number
}

/**
 * Extra seconds charged for changing direction at a junction, at a right angle.
 *
 * Turn penalties are what stop a route zig-zagging block by block toward its destination when the
 * staircase happens to measure a metre shorter than going along and then up. Every satnav applies
 * them and every route looks wrong without them. Charged in proportion to how sharp the turn is, so
 * following a road as it bends costs nothing.
 */
const TURN_PENALTY = 3.2

/** Extra charge for turning back the way you came, on top of the right-angle penalty. */
const U_TURN_PENALTY = 22

/**
 * Travel-time routing over the street network, as a satnav would do it.
 *
 * A* with states on *directed edges* rather than on junctions. That costs a little more memory and
 * is the only way to charge for turns at all: at a junction you have no idea which way the journey
 * arrived, so there is nothing to compare the departure against. With edge states the previous
 * heading is part of the state and the penalty falls out naturally.
 */
export class RoadRouter {
  private readonly fastest: number

  // Everything the inner loop needs, precomputed once per router and indexed by edge id. The search
  // relaxes hundreds of thousands of edges on a large city, and doing this work per relaxation cost
  // more than the search itself — `headingInto` in particular copied and reversed a whole polyline
  // every time it was asked about an edge from the far end.
  private readonly freeFlow: Float64Array
  private readonly headIntoTo: Float64Array
  private readonly headIntoFrom: Float64Array
  private readonly headOutOfFrom: Float64Array
  private readonly headOutOfTo: Float64Array
  // Search scratch, reused between routes. `stamp` records which route last wrote each state, so a
  // new search never has to clear arrays that are two entries per edge long.
  private readonly cost: Float64Array
  private readonly graph: PlanarGraph
  private readonly delay?: ReadonlyMap<number, number>
  private readonly cameFrom: Int32Array
  private readonly stamp: Int32Array
  private readonly nodeIndex = new Map<number, number>()
  private readonly nodeX: Float64Array
  private readonly nodeZ: Float64Array
  private readonly outOffset: Int32Array
  private readonly outEdge: Int32Array
  private generation = 0

  /**
   * @param delay Optional live multiplier on each street's travel time, one entry per edge id, for
   *   routing around traffic. The map is read on every traversal rather than copied, so a caller
   *   loading the network in waves can update it between routes and see the effect immediately.
   *   Values below one are clamped away: the A* heuristic divides the straight-line distance by the
   *   fastest speed limit, and a street that beat its own limit would make that estimate optimistic
   *   and the search no longer guaranteed to find the quickest way.
   */
  constructor(
    graph: PlanarGraph,
    properties: ReadonlyMap<number, RoadProperties>,
    delay?: ReadonlyMap<number, number>,
  ) {
    this.graph = graph
    this.delay = delay
    let fastest = 1
    for (const value of properties.values()) fastest = Math.max(fastest, value.speedLimit)
    this.fastest = fastest

    const size = graph.edges.length
    this.freeFlow = new Float64Array(size)
    this.headIntoTo = new Float64Array(size)
    this.headIntoFrom = new Float64Array(size)
    this.headOutOfFrom = new Float64Array(size)
    this.headOutOfTo = new Float64Array(size)
    for (const edge of graph.edges) {
      const speed = properties.get(edge.id)?.speedLimit ?? 1
      this.freeFlow[edge.id] = edge.length / speed
      const heading = headingsOf(edge)
      this.headIntoTo[edge.id] = heading.intoTo
      this.headOutOfTo[edge.id] = heading.outOfTo
      this.headIntoFrom[edge.id] = heading.intoFrom
      this.headOutOfFrom[edge.id] = heading.outOfFrom
    }
    this.cost = new Float64Array(size * 2)
    this.cameFrom = new Int32Array(size * 2)
    this.stamp = new Int32Array(size * 2)

    // Junctions and their incident streets, flattened the same way, so that following the network
    // costs an array index rather than two hash lookups per street considered.
    const nodeIds = [...graph.nodes.keys()]
    const nodeCount = nodeIds.length
    this.nodeX = new Float64Array(nodeCount)
    this.nodeZ = new Float64Array(nodeCount)
    this.outOffset = new Int32Array(nodeCount + 1)
    nodeIds.forEach((id, position) => {
      this.nodeIndex.set(id, position)
      const node = graph.nodes.get(id)!
      this.nodeX[position] = node.x
      this.nodeZ[position] = node.z
      this.outOffset[position + 1] = (graph.incident.get(id)?.length ?? 0)
    })
    for (let i = 0; i < nodeCount; i += 1) this.outOffset[i + 1] += this.outOffset[i]
    this.outEdge = new Int32Array(this.outOffset[nodeCount])
    nodeIds.forEach((id, position) => {
      const incident = graph.incident.get(id) ?? []
      let slot = this.outOffset[position]
      for (const edgeId of incident) {
        this.outEdge[slot] = edgeId
        slot += 1
      }
    })
  }

  route(fromNodeId: number, toNodeId: number): Route | null {
    if (!this.graph.nodes.has(fromNodeId) || !this.graph.nodes.has(toNodeId)) return null
    if (fromNodeId === toNodeId) {
      const node = this.graph.nodes.get(fromNodeId)!
      return { nodeIds: [fromNodeId], edgeIds: [], path: [node], distance: 0, travelTime: 0 }
    }

    const target = this.graph.nodes.get(toNodeId)!
    const targetX = target.x
    const targetZ = target.z
    const inverseSpeed = 1 / this.fastest
    const edges = this.graph.edges
    const { cost, cameFrom, stamp, nodeX, nodeZ, outOffset, outEdge, nodeIndex } = this
    this.generation += 1
    const generation = this.generation

    const heuristic = (nodeId: number): number => {
      const at = nodeIndex.get(nodeId)!
      return Math.hypot(nodeX[at] - targetX, nodeZ[at] - targetZ) * inverseSpeed
    }

    // A state is "arrived at `nodeId` along `edgeId`", keyed as edgeId*2 + direction.
    const queue = new BinaryHeap()

    const start = nodeIndex.get(fromNodeId)!
    for (let i = outOffset[start]; i < outOffset[start + 1]; i += 1) {
      const edgeId = outEdge[i]
      const edge = edges[edgeId]
      const far = edge.fromId === fromNodeId ? edge.toId : edge.fromId
      const state = edgeId * 2 + (edge.toId === far ? 1 : 0)
      const time = this.traversalTime(edgeId)
      cost[state] = time
      cameFrom[state] = -1
      stamp[state] = generation
      queue.push(state, time + heuristic(far))
    }

    let goal = -1
    while (queue.size > 0) {
      const state = queue.pop()!
      const edgeId = state >> 1
      const edge = edges[edgeId]
      const headId = (state & 1) === 1 ? edge.toId : edge.fromId
      if (headId === toNodeId) {
        goal = state
        break
      }
      const spent = cost[state]
      const incoming = edge.toId === headId ? this.headIntoTo[edgeId] : this.headIntoFrom[edgeId]
      const head = nodeIndex.get(headId)!
      for (let i = outOffset[head]; i < outOffset[head + 1]; i += 1) {
        const nextId = outEdge[i]
        if (nextId === edgeId) continue
        const next = edges[nextId]
        const far = next.fromId === headId ? next.toId : next.fromId
        const nextState = nextId * 2 + (next.toId === far ? 1 : 0)
        const leaving =
          next.fromId === headId ? this.headOutOfFrom[nextId] : this.headOutOfTo[nextId]
        const total = spent + this.traversalTime(nextId) + turnCost(incoming, leaving)
        if (stamp[nextState] === generation && total >= cost[nextState]) continue
        cost[nextState] = total
        cameFrom[nextState] = state
        stamp[nextState] = generation
        queue.push(nextState, total + heuristic(far))
      }
    }
    if (goal < 0) return null

    const edgeIds: number[] = []
    for (let state = goal; state >= 0; state = cameFrom[state]) edgeIds.push(state >> 1)
    edgeIds.reverse()
    return this.assemble(fromNodeId, edgeIds, cost[goal])
  }

  private traversalTime(edgeId: number): number {
    const congestion = this.delay === undefined ? 1 : Math.max(1, this.delay.get(edgeId) ?? 1)
    return this.freeFlow[edgeId] * congestion
  }

  private assemble(fromNodeId: number, edgeIds: readonly number[], travelTime: number): Route {
    const nodeIds: number[] = [fromNodeId]
    const path: Point[] = []
    let distance = 0
    let at = fromNodeId
    for (const edgeId of edgeIds) {
      const edge = this.graph.edges[edgeId]
      const forward = edge.fromId === at
      const points = forward ? edge.points : [...edge.points].reverse()
      // The first point repeats the previous edge's last, so it is dropped after the opening edge.
      for (const point of path.length === 0 ? points : points.slice(1)) path.push(point)
      distance += edge.length
      at = forward ? edge.toId : edge.fromId
      nodeIds.push(at)
    }
    return { nodeIds, edgeIds, path, distance, travelTime }
  }
}

/**
 * Charge for a change of heading, from the heading arriving at a junction to the one leaving it.
 *
 * Headings are taken from the *vertices next to the junction*, not from the far ends of the two
 * streets: on curved roads those differ by tens of degrees, and a route would be charged for a turn
 * it never makes while following a bend.
 */
function turnCost(incoming: number, outgoing: number): number {
  let change = Math.abs(outgoing - incoming)
  while (change > Math.PI) change = Math.abs(change - Math.PI * 2)
  const uTurn = change > Math.PI * 0.78 ? U_TURN_PENALTY : 0
  return (change / (Math.PI / 2)) * TURN_PENALTY + uTurn
}

/**
 * The four headings a street can be entered or left by, measured at the *vertices next to each
 * junction* rather than at the far ends of the street.
 *
 * On a curved road the two differ by tens of degrees, so taking the far end would charge a route for
 * a turn it never makes while simply following a bend.
 */
function headingsOf(edge: GraphEdge): {
  intoTo: number
  intoFrom: number
  outOfFrom: number
  outOfTo: number
} {
  const points = edge.points
  const last = points[points.length - 1]
  const penultimate = points[points.length - 2]
  return {
    intoTo: Math.atan2(last.z - penultimate.z, last.x - penultimate.x),
    outOfTo: Math.atan2(penultimate.z - last.z, penultimate.x - last.x),
    intoFrom: Math.atan2(points[0].z - points[1].z, points[0].x - points[1].x),
    outOfFrom: Math.atan2(points[1].z - points[0].z, points[1].x - points[0].x),
  }
}

/** Binary min-heap. A linear scan for the cheapest state makes routing quadratic and it shows. */
class BinaryHeap {
  private readonly items: number[] = []
  private readonly priorities: number[] = []

  get size(): number {
    return this.items.length
  }

  push(item: number, priority: number): void {
    this.items.push(item)
    this.priorities.push(priority)
    let index = this.items.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (this.priorities[parent] <= this.priorities[index]) break
      this.swap(parent, index)
      index = parent
    }
  }

  pop(): number | undefined {
    if (this.items.length === 0) return undefined
    const top = this.items[0]
    const lastItem = this.items.pop()!
    const lastPriority = this.priorities.pop()!
    if (this.items.length > 0) {
      this.items[0] = lastItem
      this.priorities[0] = lastPriority
      let index = 0
      for (;;) {
        const left = index * 2 + 1
        const right = left + 1
        let smallest = index
        if (left < this.items.length && this.priorities[left] < this.priorities[smallest]) smallest = left
        if (right < this.items.length && this.priorities[right] < this.priorities[smallest]) smallest = right
        if (smallest === index) break
        this.swap(smallest, index)
        index = smallest
      }
    }
    return top
  }

  private swap(a: number, b: number): void {
    ;[this.items[a], this.items[b]] = [this.items[b], this.items[a]]
    ;[this.priorities[a], this.priorities[b]] = [this.priorities[b], this.priorities[a]]
  }
}
