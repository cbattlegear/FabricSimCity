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
 * Betweenness at which a street is promoted to each class, as a share of the maximum found.
 *
 * Thresholds are relative rather than absolute so the same ladder works for a six-table database and
 * a six-thousand-table one. The shares are steep — the top class needs half the busiest street's
 * centrality — because a road hierarchy in which a third of the streets are arterials is not a
 * hierarchy, and the map has to be readable at a glance from the weight of the lines alone.
 */
const CLASS_THRESHOLDS: ReadonlyArray<{ roadClass: RoadClass; share: number }> = [
  { roadClass: 'motorway', share: 0.52 },
  { roadClass: 'primary', share: 0.32 },
  { roadClass: 'secondary', share: 0.185 },
  { roadClass: 'tertiary', share: 0.085 },
  { roadClass: 'residential', share: 0.018 },
]

export function classifyRoads(graph: PlanarGraph): Map<number, RoadProperties> {
  const betweenness = edgeBetweenness(graph)
  let peak = 0
  for (const value of betweenness.values()) peak = Math.max(peak, value)

  const properties = new Map<number, RoadProperties>()
  for (const edge of graph.edges) {
    const share = peak === 0 ? 0 : (betweenness.get(edge.id) ?? 0) / peak
    /*
     * A dead end is never a through route however the numbers fall. Betweenness already says so, but
     * a cul-de-sac hanging off a very busy street can still pick up a share large enough to promote
     * it, and a four-lane road that stops after thirty metres is the sort of detail that makes a
     * generated map look generated.
     */
    const dangling = (graph.incident.get(edge.fromId)?.length ?? 0) <= 1 ||
      (graph.incident.get(edge.toId)?.length ?? 0) <= 1
    const roadClass = dangling
      ? 'service'
      : CLASS_THRESHOLDS.find(entry => share >= entry.share)?.roadClass ?? 'service'
    const base = CLASS_PROPERTIES[roadClass]
    properties.set(edge.id, {
      roadClass,
      speedLimit: base.speed,
      width: base.width,
      betweenness: share,
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
 * `O(V·E)`, which for a city of a few hundred junctions runs in a handful of milliseconds.
 */
export function edgeBetweenness(graph: PlanarGraph): Map<number, number> {
  const nodeIds = [...graph.nodes.keys()].sort((a, b) => a - b)
  const index = new Map<number, number>()
  nodeIds.forEach((id, position) => index.set(id, position))
  const count = nodeIds.length
  const scores = new Map<number, number>()
  for (const edge of graph.edges) scores.set(edge.id, 0)
  if (count < 2) return scores

  const adjacency: Array<Array<{ to: number; edgeId: number }>> = nodeIds.map(() => [])
  for (const edge of graph.edges) {
    const from = index.get(edge.fromId)
    const to = index.get(edge.toId)
    if (from === undefined || to === undefined) continue
    adjacency[from].push({ to, edgeId: edge.id })
    adjacency[to].push({ to: from, edgeId: edge.id })
  }

  const sigma = new Float64Array(count)
  const delta = new Float64Array(count)
  const distance = new Int32Array(count)
  const queue = new Int32Array(count)
  const stack = new Int32Array(count)

  for (let source = 0; source < count; source += 1) {
    const predecessors: Array<Array<{ from: number; edgeId: number }>> = adjacency.map(() => [])
    sigma.fill(0)
    delta.fill(0)
    distance.fill(-1)
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
      for (const link of adjacency[node]) {
        if (distance[link.to] < 0) {
          distance[link.to] = distance[node] + 1
          queue[tail] = link.to
          tail += 1
        }
        if (distance[link.to] === distance[node] + 1) {
          sigma[link.to] += sigma[node]
          predecessors[link.to].push({ from: node, edgeId: link.edgeId })
        }
      }
    }
    while (depth > 0) {
      depth -= 1
      const node = stack[depth]
      for (const predecessor of predecessors[node]) {
        const contribution = (sigma[predecessor.from] / sigma[node]) * (1 + delta[node])
        delta[predecessor.from] += contribution
        scores.set(predecessor.edgeId, (scores.get(predecessor.edgeId) ?? 0) + contribution)
      }
    }
  }

  // Every pair was counted from both ends.
  for (const [edgeId, value] of scores) scores.set(edgeId, value / 2)
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
  private readonly outgoing = new Map<number, number[]>()
  private readonly properties: ReadonlyMap<number, RoadProperties>
  private readonly fastest: number

  /**
   * @param delay Optional live multiplier on each street's travel time, one entry per edge id, for
   *   routing around traffic. The map is read on every traversal rather than copied, so a caller
   *   loading the network in waves can update it between routes and see the effect immediately.
   *   Values below one are clamped away: the A* heuristic divides the straight-line distance by the
   *   fastest speed limit, and a street that beat its own limit would make that estimate optimistic
   *   and the search no longer guaranteed to find the quickest way.
   */
  constructor(
    private readonly graph: PlanarGraph,
    properties: ReadonlyMap<number, RoadProperties>,
    private readonly delay?: ReadonlyMap<number, number>,
  ) {
    this.properties = properties
    for (const [nodeId, edgeIds] of graph.incident) this.outgoing.set(nodeId, [...edgeIds])
    let fastest = 1
    for (const value of properties.values()) fastest = Math.max(fastest, value.speedLimit)
    this.fastest = fastest
  }

  route(fromNodeId: number, toNodeId: number): Route | null {
    if (!this.graph.nodes.has(fromNodeId) || !this.graph.nodes.has(toNodeId)) return null
    if (fromNodeId === toNodeId) {
      const node = this.graph.nodes.get(fromNodeId)!
      return { nodeIds: [fromNodeId], edgeIds: [], path: [node], distance: 0, travelTime: 0 }
    }

    const target = this.graph.nodes.get(toNodeId)!
    const heuristic = (nodeId: number): number => {
      const node = this.graph.nodes.get(nodeId)!
      return Math.hypot(node.x - target.x, node.z - target.z) / this.fastest
    }

    // A state is "arrived at `nodeId` along `edgeId`", keyed as edgeId*2 + direction.
    const cost = new Map<number, number>()
    const cameFrom = new Map<number, number>()
    const queue = new BinaryHeap()

    for (const edgeId of this.outgoing.get(fromNodeId) ?? []) {
      const edge = this.graph.edges[edgeId]
      const far = edge.fromId === fromNodeId ? edge.toId : edge.fromId
      const state = this.stateFor(edgeId, far)
      const time = this.traversalTime(edge)
      cost.set(state, time)
      queue.push(state, time + heuristic(far))
    }

    let goal: number | null = null
    while (queue.size > 0) {
      const state = queue.pop()!
      const { edgeId, headId } = this.decode(state)
      if (headId === toNodeId) {
        goal = state
        break
      }
      const spent = cost.get(state)!
      const edge = this.graph.edges[edgeId]
      for (const nextId of this.outgoing.get(headId) ?? []) {
        if (nextId === edgeId) continue
        const next = this.graph.edges[nextId]
        const far = next.fromId === headId ? next.toId : next.fromId
        const nextState = this.stateFor(nextId, far)
        const total = spent + this.traversalTime(next) + this.turnCost(edge, next, headId)
        if (total >= (cost.get(nextState) ?? Infinity)) continue
        cost.set(nextState, total)
        cameFrom.set(nextState, state)
        queue.push(nextState, total + heuristic(far))
      }
    }
    if (goal === null) return null

    const edgeIds: number[] = []
    for (let state: number | undefined = goal; state !== undefined; state = cameFrom.get(state)) {
      edgeIds.push(this.decode(state).edgeId)
    }
    edgeIds.reverse()
    return this.assemble(fromNodeId, edgeIds, cost.get(goal)!)
  }

  private stateFor(edgeId: number, headId: number): number {
    const edge = this.graph.edges[edgeId]
    return edgeId * 2 + (edge.toId === headId ? 1 : 0)
  }

  private decode(state: number): { edgeId: number; headId: number } {
    const edgeId = state >> 1
    const edge = this.graph.edges[edgeId]
    return { edgeId, headId: (state & 1) === 1 ? edge.toId : edge.fromId }
  }

  private traversalTime(edge: GraphEdge): number {
    const speed = this.properties.get(edge.id)?.speedLimit ?? 1
    const congestion = Math.max(1, this.delay?.get(edge.id) ?? 1)
    return (edge.length / speed) * congestion
  }

  /**
   * Charge for the change of heading between arriving on one street and leaving on the next.
   *
   * Headings are taken from the *vertices next to the junction*, not from the far ends of the two
   * streets: on curved roads those differ by tens of degrees, and a route would be charged for a
   * turn it never makes while following a bend.
   */
  private turnCost(from: GraphEdge, to: GraphEdge, atId: number): number {
    const incoming = headingInto(from, atId)
    const outgoing = headingOutOf(to, atId)
    let change = Math.abs(outgoing - incoming)
    while (change > Math.PI) change = Math.abs(change - Math.PI * 2)
    const uTurn = change > Math.PI * 0.78 ? U_TURN_PENALTY : 0
    return (change / (Math.PI / 2)) * TURN_PENALTY + uTurn
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

function headingInto(edge: GraphEdge, atId: number): number {
  const points = edge.toId === atId ? edge.points : [...edge.points].reverse()
  const last = points[points.length - 1]
  const previous = points[points.length - 2]
  return Math.atan2(last.z - previous.z, last.x - previous.x)
}

function headingOutOf(edge: GraphEdge, atId: number): number {
  const points = edge.fromId === atId ? edge.points : [...edge.points].reverse()
  return Math.atan2(points[1].z - points[0].z, points[1].x - points[0].x)
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
