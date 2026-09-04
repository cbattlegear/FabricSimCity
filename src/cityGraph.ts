import { polylineLength, type Point, type Streamline, type StreamlineFamily } from './cityStreamlines'

/**
 * Turns a bundle of traced curves into an actual street network.
 *
 * A streamline is a curve, not a road: it has no junctions, it does not know what it crosses, and
 * nothing in it says where one block ends and the next begins. This module supplies all three. It
 * takes the curves, finds every place two of them cross, welds the ends that stop just short of a
 * neighbour into genuine T-junctions, and then reads the *faces* of the resulting planar graph — the
 * enclosed regions — which are the city blocks.
 *
 * Faces are what make an organic street plan usable. On a lattice a block is a pair of integers, so
 * every downstream question — where does this building stand, what colour is this ground, which
 * street does this door open onto — has an arithmetic answer. Once the streets stop being a lattice
 * none of those shortcuts survive, and the blocks have to be recovered as real polygons from the
 * graph. Everything downstream then works from polygons instead of from indices, which is both more
 * code and the entire point: a polygon can be any shape, and city blocks are.
 */

export interface GraphNode {
  readonly id: number
  readonly x: number
  readonly z: number
}

export interface GraphEdge {
  readonly id: number
  readonly fromId: number
  readonly toId: number
  /** Curved centre line, from `fromId` to `toId` inclusive. */
  readonly points: readonly Point[]
  readonly length: number
  /** The streamline this edge was cut from, so a road can be reassembled from its pieces. */
  readonly streamlineId: string
  readonly family: StreamlineFamily
  readonly centrality: number
}

export interface PlanarGraph {
  readonly nodes: ReadonlyMap<number, GraphNode>
  readonly edges: readonly GraphEdge[]
  /** Edge ids incident to each node. */
  readonly incident: ReadonlyMap<number, readonly number[]>
}

export interface GraphOptions {
  /** Two points closer than this are the same junction. */
  readonly weldRadius: number
  /** How far a street may be extended to reach a neighbour it stopped short of. */
  readonly snapRadius: number
  /** Dead-end stubs shorter than this are swept up; longer ones are kept as cul-de-sacs. */
  readonly minStub: number
}

/* ------------------------------------------------------------------ *
 * Building the graph
 * ------------------------------------------------------------------ */

export function buildPlanarGraph(
  streamlines: readonly Streamline[],
  options: GraphOptions,
): PlanarGraph {
  const extended = extendToNeighbours(streamlines, options.snapRadius)
  const split = splitAtCrossings(extended)
  return weld(split, options)
}

/**
 * Pushes each dangling end onto the street it stopped beside.
 *
 * The tracer halts as soon as a street comes within half a separation of an existing one, which
 * leaves it *near* its neighbour rather than joined to it. Left alone, every one of those becomes a
 * road that stops in mid-air a few metres short of a junction — the single most obvious tell of a
 * generated street plan, and worse than cosmetic here, because a road that does not meet the network
 * cannot carry a route.
 *
 * Extending the end to the nearest point on the nearest other street is Parish & Müller's "snap to
 * an existing road" local constraint, and it is what turns the loose bundle of curves into a
 * connected network of T-junctions.
 */
function extendToNeighbours(
  streamlines: readonly Streamline[],
  snapRadius: number,
): Array<{ line: Streamline; points: Point[] }> {
  const result = streamlines.map(line => ({ line, points: line.points.map(p => ({ x: p.x, z: p.z })) }))
  const segments = new SegmentIndex(snapRadius * 2)
  for (let index = 0; index < result.length; index += 1) {
    const points = result[index].points
    for (let step = 1; step < points.length; step += 1) {
      segments.add(index, step - 1, points[step - 1], points[step])
    }
  }

  for (let index = 0; index < result.length; index += 1) {
    const points = result[index].points
    if (points.length < 2) continue
    for (const end of ['start', 'finish'] as const) {
      const tip = end === 'start' ? points[0] : points[points.length - 1]
      const nearest = segments.nearestExcluding(tip, snapRadius, index)
      if (nearest === null) continue
      if (nearest.distance < 1e-6) continue
      if (end === 'start') points.unshift(nearest.point)
      else points.push(nearest.point)
    }
  }
  return result
}

interface SplitPolyline {
  readonly line: Streamline
  readonly points: readonly Point[]
  /** Indices into `points` that must become graph nodes: the ends plus every crossing. */
  readonly breaks: readonly number[]
}

/**
 * Inserts a vertex into both polylines wherever two of them cross.
 *
 * Without this every intersection is a visual illusion: the two roads are drawn over each other and
 * the graph has no node there, so no route can turn from one onto the other and no block is closed.
 */
function splitAtCrossings(
  input: ReadonlyArray<{ line: Streamline; points: Point[] }>,
): SplitPolyline[] {
  // Per polyline, per segment: the parameters along that segment where a crossing happens.
  const cuts: Array<Map<number, number[]>> = input.map(() => new Map())
  const index = new SegmentIndex(averageSegmentLength(input) * 2 + 1)
  for (let line = 0; line < input.length; line += 1) {
    const points = input[line].points
    for (let step = 1; step < points.length; step += 1) {
      index.add(line, step - 1, points[step - 1], points[step])
    }
  }

  for (let line = 0; line < input.length; line += 1) {
    const points = input[line].points
    for (let step = 1; step < points.length; step += 1) {
      const a = points[step - 1]
      const b = points[step]
      for (const other of index.candidates(a, b)) {
        // Each unordered pair is tested once, and a polyline never crosses itself here: a
        // self-crossing streamline is a ring closing, which the welder handles by coincidence.
        if (other.line < line || (other.line === line && other.segment <= step - 1)) continue
        if (other.line === line && Math.abs(other.segment - (step - 1)) <= 1) continue
        const otherPoints = input[other.line].points
        const hit = intersect(a, b, otherPoints[other.segment], otherPoints[other.segment + 1])
        if (hit === null) continue
        pushCut(cuts[line], step - 1, hit.t)
        pushCut(cuts[other.line], other.segment, hit.u)
      }
    }
  }

  return input.map((entry, line) => {
    const points: Point[] = []
    const breaks: number[] = []
    const source = entry.points
    breaks.push(0)
    points.push({ x: source[0].x, z: source[0].z })
    for (let step = 1; step < source.length; step += 1) {
      const a = source[step - 1]
      const b = source[step]
      const parameters = (cuts[line].get(step - 1) ?? []).slice().sort((p, q) => p - q)
      for (const t of parameters) {
        if (t <= 1e-9 || t >= 1 - 1e-9) continue
        breaks.push(points.length)
        points.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t })
      }
      points.push({ x: b.x, z: b.z })
    }
    breaks.push(points.length - 1)
    return { line: entry.line, points, breaks: dedupeSorted(breaks) }
  })
}

function pushCut(map: Map<number, number[]>, segment: number, t: number): void {
  const bucket = map.get(segment)
  if (bucket) bucket.push(t)
  else map.set(segment, [t])
}

function dedupeSorted(values: number[]): number[] {
  const sorted = values.slice().sort((a, b) => a - b)
  const out: number[] = []
  for (const value of sorted) if (out.length === 0 || out[out.length - 1] !== value) out.push(value)
  return out
}

/** Merges coincident junction points and emits the final node and edge lists. */
function weld(split: readonly SplitPolyline[], options: GraphOptions): PlanarGraph {
  const welder = new PointWelder(options.weldRadius)
  const nodeOf: number[][] = split.map(entry => entry.breaks.map(at => welder.intern(entry.points[at])))

  const nodes = new Map<number, GraphNode>()
  for (const [id, point] of welder.points()) nodes.set(id, { id, x: point.x, z: point.z })

  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  for (let line = 0; line < split.length; line += 1) {
    const entry = split[line]
    for (let step = 1; step < entry.breaks.length; step += 1) {
      const fromId = nodeOf[line][step - 1]
      const toId = nodeOf[line][step]
      if (fromId === toId) continue
      const key = fromId < toId ? `${fromId}:${toId}` : `${toId}:${fromId}`
      if (seen.has(key)) continue

      const slice = entry.points.slice(entry.breaks[step - 1], entry.breaks[step] + 1)
      if (slice.length < 2) continue
      // The drawn line must start and end exactly on the welded junctions, or roads meeting at a
      // corner would each stop a weld radius short of it and leave a visible nick in the tarmac.
      const points = [nodes.get(fromId)!, ...slice.slice(1, -1), nodes.get(toId)!].map(p => ({ x: p.x, z: p.z }))
      seen.add(key)
      edges.push({
        id: edges.length,
        fromId,
        toId,
        points,
        length: polylineLength(points),
        streamlineId: entry.line.id,
        family: entry.line.family,
        centrality: entry.line.centrality,
      })
    }
  }

  return finalise(nodes, edges, options)
}

/** Drops stubs and orphans, then indexes what survives. */
function finalise(
  nodes: Map<number, GraphNode>,
  edges: GraphEdge[],
  options: GraphOptions,
): PlanarGraph {
  let live = edges
  for (let pass = 0; pass < 6; pass += 1) {
    const degree = new Map<number, number>()
    for (const edge of live) {
      degree.set(edge.fromId, (degree.get(edge.fromId) ?? 0) + 1)
      degree.set(edge.toId, (degree.get(edge.toId) ?? 0) + 1)
    }
    /*
     * A short dead end is an artefact — a street that stopped one step after starting, or a sliver
     * left by a weld. A *long* dead end is a cul-de-sac, which is a real and extremely common
     * feature of residential street plans, so the length test is the whole rule and nothing is
     * removed merely for being a dead end.
     */
    const next = live.filter(edge => {
      const dangling = (degree.get(edge.fromId) ?? 0) <= 1 || (degree.get(edge.toId) ?? 0) <= 1
      return !(dangling && edge.length < options.minStub)
    })
    if (next.length === live.length) break
    live = next
  }

  const incident = new Map<number, number[]>()
  for (const edge of live) {
    pushInto(incident, edge.fromId, edge.id)
    pushInto(incident, edge.toId, edge.id)
  }
  const kept = new Map<number, GraphNode>()
  for (const [id, node] of nodes) if (incident.has(id)) kept.set(id, node)

  // Ids are renumbered so that edge id equals array index, which the face walker relies on.
  const renumbered = live.map((edge, id) => ({ ...edge, id }))
  const reindexed = new Map<number, number[]>()
  for (const edge of renumbered) {
    pushInto(reindexed, edge.fromId, edge.id)
    pushInto(reindexed, edge.toId, edge.id)
  }
  return { nodes: kept, edges: renumbered, incident: reindexed }
}

function pushInto(map: Map<number, number[]>, key: number, value: number): void {
  const bucket = map.get(key)
  if (bucket) bucket.push(value)
  else map.set(key, [value])
}

/* ------------------------------------------------------------------ *
 * Connecting what the tracer left stranded
 * ------------------------------------------------------------------ */

/**
 * Joins every stranded island of streets to the main network with a link road.
 *
 * Tracing can leave a pocket of streets with no way in. It happens where a district's grain turns
 * hard against its neighbour's: streets on both sides stop at the seam rather than crossing it, and
 * if the gap is wider than the snap radius nothing reaches over. On the map it looks like nothing at
 * all, which is the problem — the streets are drawn, the buildings on them are drawn, and only when
 * a query route between two buildings comes back empty does it emerge that one of them cannot be
 * reached from the other. Ribbons silently go missing.
 *
 * Every island is therefore linked to the main network across the shortest gap between them, which
 * is what a real bypass or link road does and is only a longer-range version of the snapping the
 * graph already does. Islands are joined smallest gap first, so a chain of pockets links through its
 * neighbour rather than each reaching separately across the city.
 *
 * The alternative — discarding islands — would throw away their blocks, and with them the ground the
 * buildings stand on, to fix a problem the reader cannot see.
 */
export function connectComponents(graph: PlanarGraph): PlanarGraph {
  const components = findComponents(graph)
  if (components.length <= 1) return graph

  // Largest first: the biggest component is the city, and the rest are pockets to be attached to it.
  components.sort((a, b) => b.length - a.length)
  const main = new Set(components[0])
  const pending = components.slice(1)
  const edges = [...graph.edges]
  const nodes = graph.nodes

  while (pending.length > 0) {
    let bestIsland = 0
    let bestFrom = -1
    let bestTo = -1
    let bestDistance = Infinity
    for (let index = 0; index < pending.length; index += 1) {
      for (const fromId of pending[index]) {
        const from = nodes.get(fromId)!
        for (const toId of main) {
          const to = nodes.get(toId)!
          const distance = (from.x - to.x) ** 2 + (from.z - to.z) ** 2
          if (distance < bestDistance) {
            bestDistance = distance
            bestFrom = fromId
            bestTo = toId
            bestIsland = index
          }
        }
      }
    }
    if (bestFrom < 0) break

    const from = nodes.get(bestFrom)!
    const to = nodes.get(bestTo)!
    edges.push({
      id: edges.length,
      fromId: bestFrom,
      toId: bestTo,
      points: [{ x: from.x, z: from.z }, { x: to.x, z: to.z }],
      length: Math.hypot(from.x - to.x, from.z - to.z),
      streamlineId: `link:${bestFrom}:${bestTo}`,
      family: 'major',
      centrality: 0,
    })
    for (const id of pending[bestIsland]) main.add(id)
    pending.splice(bestIsland, 1)
  }

  const incident = new Map<number, number[]>()
  for (const edge of edges) {
    pushInto(incident, edge.fromId, edge.id)
    pushInto(incident, edge.toId, edge.id)
  }
  return { nodes: graph.nodes, edges, incident }
}

/** Node ids grouped into connected components. */
function findComponents(graph: PlanarGraph): number[][] {
  const seen = new Set<number>()
  const components: number[][] = []
  for (const start of graph.nodes.keys()) {
    if (seen.has(start)) continue
    const component: number[] = []
    const stack = [start]
    seen.add(start)
    while (stack.length > 0) {
      const at = stack.pop()!
      component.push(at)
      for (const edgeId of graph.incident.get(at) ?? []) {
        const edge = graph.edges[edgeId]
        const next = edge.fromId === at ? edge.toId : edge.fromId
        if (seen.has(next)) continue
        seen.add(next)
        stack.push(next)
      }
    }
    components.push(component)
  }
  return components
}

/* ------------------------------------------------------------------ *
 * Breaking crossroads
 * ------------------------------------------------------------------ */

export interface CrossingOptions {
  readonly seed: number
  /**
   * Share of *all* nodes that may remain four-way crossings.
   *
   * Surveys of real street networks put this near 0.23, against roughly 0.57 three-way and 0.15
   * dead ends. Two streamline families crossing freely produce almost the mirror image of that.
   */
  readonly targetCrossroadShare: number
  /** Edges at least this long are through routes and are never broken. */
  readonly protectLength: number
  /** Ceiling on the share of edges that may be removed, whatever the crossroad share does. */
  readonly maxRemovalShare: number
  /** How many original blocks may be merged into one by removing the streets between them. */
  readonly maxMergedBlocks: number
  /** Hard ceiling on the area of a merged block, so no quarter is left without a street. */
  readonly maxBlockArea: number
}

/**
 * Turns crossroads into T-junctions by deleting one arm, until the mix matches a real city.
 *
 * This is the step that decides whether the result reads as a city or as a bent grid, and it is
 * worth being precise about why. Two families of streamlines crossing each other produce a
 * *quadrilateral mesh*: every junction has four arms and every block has four sides. Curving the
 * streets does not change that — it is the same topology as graph paper, and the eye reads topology
 * long before it reads curvature. That is exactly the "wiggly grid" failure, one level up from the
 * one that curvature was supposed to solve.
 *
 * Real street networks are not meshes. Streets *stop* when they meet a bigger street, because they
 * were laid out by whoever was developing that one parcel, and the through road was already there.
 * The result is that T-junctions outnumber crossroads by more than two to one, and that blocks come
 * in wildly different sizes because two would-be blocks share one interior when the street between
 * them was never built.
 *
 * Deleting an arm gets both properties from one operation: the junction loses a degree, and the two
 * faces either side of the deleted edge merge into a single larger block. Minor-family edges are
 * considered first so that side streets terminate at through roads rather than the other way round,
 * and any edge whose removal would disconnect the network is skipped — the walkable-everywhere
 * property matters more to routing than any individual junction does.
 */
export function breakCrossings(
  graph: PlanarGraph,
  options: CrossingOptions,
  graphOptions: GraphOptions,
): PlanarGraph {
  const degree = new Map<number, number>()
  const adjacency = new Map<number, { edgeId: number; other: number }[]>()
  for (const edge of graph.edges) {
    degree.set(edge.fromId, (degree.get(edge.fromId) ?? 0) + 1)
    degree.set(edge.toId, (degree.get(edge.toId) ?? 0) + 1)
    if (!adjacency.has(edge.fromId)) adjacency.set(edge.fromId, [])
    if (!adjacency.has(edge.toId)) adjacency.set(edge.toId, [])
    adjacency.get(edge.fromId)!.push({ edgeId: edge.id, other: edge.toId })
    adjacency.get(edge.toId)!.push({ edgeId: edge.id, other: edge.fromId })
  }

  const removed = new Set<number>()
  const crossroadShare = (): number => {
    let live = 0
    let four = 0
    for (const count of degree.values()) {
      if (count < 1) continue
      live += 1
      if (count >= 4) four += 1
    }
    return live === 0 ? 0 : four / live
  }

  /*
   * Minor-family edges sort ahead of major ones so side streets are the ones that give way, and a
   * seeded hash shuffles within each family so the choice is arbitrary but reproducible.
   */
  const order = graph.edges
    .filter(edge => edge.length < options.protectLength)
    .map(edge => ({
      edge,
      rank: (edge.family === 'minor' ? 0 : 1) + hash01(options.seed, edge.id),
    }))
    .sort((a, b) => a.rank - b.rank)

  const maxRemovals = Math.floor(graph.edges.length * options.maxRemovalShare)

  /*
   * Removing an edge merges the blocks on either side of it, and left unchecked a run of removals
   * along one street merges a whole row into a single strip ten times longer than it is wide. So the
   * merge is tracked in a union-find and refused once a block has swallowed too many neighbours or
   * grown past a plausible size — which is also what stops the city developing quarters with no
   * street frontage at all.
   */
  const walk = walkFaces(graph)
  const parent = walk.faces.map((_, index) => index)
  const merged = walk.faces.map(() => 1)
  const area = walk.faces.map(face => face.area)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root]
    for (let cursor = index; parent[cursor] !== root; ) {
      const next = parent[cursor]
      parent[cursor] = root
      cursor = next
    }
    return root
  }

  for (const { edge } of order) {
    if (removed.size >= maxRemovals) break
    if (crossroadShare() <= options.targetCrossroadShare) break
    const from = degree.get(edge.fromId) ?? 0
    const to = degree.get(edge.toId) ?? 0
    if (from < 4 && to < 4) continue
    // Removing the last arm of a node would strand it; removing the second leaves an orphan stub.
    if (from <= 2 || to <= 2) continue

    const left = walk.halfEdgeFace.get(`${edge.fromId}>${edge.id}`)
    const right = walk.halfEdgeFace.get(`${edge.toId}>${edge.id}`)
    if (left === undefined || right === undefined) continue
    // An edge on the outer boundary has no block on one side; taking it away nibbles the city edge.
    if (walk.winding[left] !== walk.interior || walk.winding[right] !== walk.interior) continue
    const a = find(left)
    const b = find(right)
    // Both sides already in one block means this edge runs *through* a block rather than between
    // two, so removing it would leave a dangling street inside an open space.
    if (a === b) continue
    if (merged[a] + merged[b] > options.maxMergedBlocks) continue
    if (area[a] + area[b] > options.maxBlockArea) continue
    if (!stillConnected(adjacency, removed, edge)) continue

    removed.add(edge.id)
    degree.set(edge.fromId, from - 1)
    degree.set(edge.toId, to - 1)
    parent[b] = a
    merged[a] += merged[b]
    area[a] += area[b]
  }

  const nodes = new Map<number, GraphNode>(graph.nodes)
  const kept = graph.edges.filter(edge => !removed.has(edge.id))
  return finalise(nodes, kept, graphOptions)
}

/**
 * Whether the endpoints of `edge` remain joined once it is gone.
 *
 * Breadth-first from one end looking for the other. An edge whose two ends are still connected
 * without it lies on a cycle, so removing it cannot split the network into pieces; the search stops
 * the moment it finds the far end, which for an edge in the middle of a block is almost immediate.
 */
function stillConnected(
  adjacency: ReadonlyMap<number, { edgeId: number; other: number }[]>,
  removed: ReadonlySet<number>,
  edge: GraphEdge,
): boolean {
  const seen = new Set<number>([edge.fromId])
  const queue = [edge.fromId]
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head]
    for (const link of adjacency.get(node) ?? []) {
      if (link.edgeId === edge.id || removed.has(link.edgeId)) continue
      if (link.other === edge.toId) return true
      if (seen.has(link.other)) continue
      seen.add(link.other)
      queue.push(link.other)
    }
  }
  return false
}

/** Deterministic hash of a seed and an integer into `[0, 1)`. */
function hash01(seed: number, value: number): number {
  let h = (seed ^ (value * 0x9e3779b1)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/* ------------------------------------------------------------------ *
 * Faces
 * ------------------------------------------------------------------ */

export interface Face {
  readonly id: number
  /** Closed ring, counter-clockwise, first point not repeated at the end. */
  readonly polygon: readonly Point[]
  readonly edgeIds: readonly number[]
  readonly area: number
  readonly centroid: Point
}

/**
 * Every enclosed region of the street network: the city blocks.
 *
 * This is the standard planar face traversal. Walk a directed edge to its far node, look at the
 * *reverse* of the edge you arrived on, and leave along the neighbour immediately clockwise from it.
 * Doing that consistently traces each bounded face exactly once, and the unbounded outer face comes
 * out with the opposite winding, which is how it is identified and discarded.
 *
 * Two details are easy to get wrong and both are handled below. A dead-end edge is traversed twice
 * within the same face — once out, once back — because the clockwise rule at a degree-1 node returns
 * the edge you came in on; that is correct and must not be treated as a loop. And with more than one
 * connected component there is more than one outer face, so they are identified by winding rather
 * than by simply dropping the largest.
 */
export function extractFaces(graph: PlanarGraph): Face[] {
  const walk = walkFaces(graph)
  return walk.faces
    .filter((_, index) => walk.winding[index] === walk.interior)
    .map((face, id) => ({ ...face, id }))
}

interface FaceWalk {
  /** Every face including the unbounded outer one, in walk order. */
  readonly faces: Face[]
  readonly winding: number[]
  /** The winding sign that identifies a bounded face. */
  readonly interior: number
  /** `"<fromId>><edgeId>"` to the index in `faces` that claimed that half-edge. */
  readonly halfEdgeFace: ReadonlyMap<string, number>
}

function walkFaces(graph: PlanarGraph): FaceWalk {
  const outgoing = new Map<number, Array<{ edgeId: number; toId: number; angle: number }>>()
  for (const [nodeId, edgeIds] of graph.incident) {
    const node = graph.nodes.get(nodeId)
    if (!node) continue
    const list = edgeIds.map(edgeId => {
      const edge = graph.edges[edgeId]
      const forward = edge.fromId === nodeId
      // The angle of departure is taken from the next *vertex* of the curve, not from the far
      // junction: on a strongly bowed road those differ by tens of degrees and the walk takes the
      // wrong turn.
      const away = forward ? edge.points[1] : edge.points[edge.points.length - 2]
      return {
        edgeId,
        toId: forward ? edge.toId : edge.fromId,
        angle: Math.atan2(away.z - node.z, away.x - node.x),
      }
    })
    list.sort((a, b) => a.angle - b.angle || a.edgeId - b.edgeId)
    outgoing.set(nodeId, list)
  }

  const visited = new Set<string>()
  const halfEdgeFace = new Map<string, number>()
  const faces: Face[] = []
  const winding: number[] = []
  for (const edge of graph.edges) {
    for (const start of [
      { fromId: edge.fromId, toId: edge.toId, edgeId: edge.id },
      { fromId: edge.toId, toId: edge.fromId, edgeId: edge.id },
    ]) {
      const key = `${start.fromId}>${start.edgeId}`
      if (visited.has(key)) continue

      const ring: Point[] = []
      const edgeIds: number[] = []
      const claimed: string[] = []
      let cursor = start
      let guard = 0
      let closed = false
      while (guard < MAX_FACE_WALK) {
        guard += 1
        const stepKey = `${cursor.fromId}>${cursor.edgeId}`
        // Re-entering a half-edge already claimed by another face means the walk has gone wrong;
        // abandoning it is safer than emitting a ring that overlaps one already recorded.
        if (visited.has(stepKey)) break
        visited.add(stepKey)
        claimed.push(stepKey)

        const walked = graph.edges[cursor.edgeId]
        const forward = walked.fromId === cursor.fromId
        const points = forward ? walked.points : [...walked.points].reverse()
        // The last vertex is the next edge's first, so dropping it here avoids duplicates.
        for (let index = 0; index < points.length - 1; index += 1) ring.push(points[index])
        edgeIds.push(cursor.edgeId)

        const next = clockwiseFrom(outgoing, cursor.toId, cursor.fromId, cursor.edgeId)
        if (next === null) break
        cursor = { fromId: cursor.toId, toId: next.toId, edgeId: next.edgeId }
        if (`${cursor.fromId}>${cursor.edgeId}` === key) {
          closed = true
          break
        }
      }

      if (!closed || ring.length < 3) continue
      const area = signedArea(ring)
      if (Math.abs(area) < 1e-6) continue
      const id = faces.length
      for (const half of claimed) halfEdgeFace.set(half, id)
      faces.push({
        id,
        polygon: ring,
        edgeIds,
        area: Math.abs(area),
        centroid: polygonCentroid(ring),
      })
      winding.push(Math.sign(area))
    }
  }

  /*
   * Bounded faces all wind the same way and the outer face of each component winds the other way, so
   * the majority sign identifies the interior. Testing the sign rather than assuming one keeps this
   * correct regardless of whether the caller's z axis points up or down the screen.
   */
  const positive = winding.filter(sign => sign > 0).length
  const interior = positive * 2 >= winding.length ? 1 : -1
  return { faces, winding, interior, halfEdgeFace }
}

const MAX_FACE_WALK = 4000

/** The neighbour immediately clockwise from the edge we arrived on, seen from `at`. */
function clockwiseFrom(
  outgoing: ReadonlyMap<number, Array<{ edgeId: number; toId: number; angle: number }>>,
  at: number,
  cameFrom: number,
  viaEdge: number,
): { edgeId: number; toId: number } | null {
  const list = outgoing.get(at)
  if (!list || list.length === 0) return null
  const position = list.findIndex(entry => entry.edgeId === viaEdge && entry.toId === cameFrom)
  if (position < 0) return null
  // One step *back* through the counter-clockwise ordering is one step clockwise.
  const next = list[(position - 1 + list.length) % list.length]
  return { edgeId: next.edgeId, toId: next.toId }
}

export function signedArea(ring: readonly Point[]): number {
  let total = 0
  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index]
    const b = ring[(index + 1) % ring.length]
    total += a.x * b.z - b.x * a.z
  }
  return total / 2
}

export function polygonCentroid(ring: readonly Point[]): Point {
  let area = 0
  let x = 0
  let z = 0
  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index]
    const b = ring[(index + 1) % ring.length]
    const cross = a.x * b.z - b.x * a.z
    area += cross
    x += (a.x + b.x) * cross
    z += (a.z + b.z) * cross
  }
  if (Math.abs(area) < 1e-9) {
    // A degenerate ring still has to report somewhere; the vertex mean is the honest answer.
    let sx = 0
    let sz = 0
    for (const point of ring) {
      sx += point.x
      sz += point.z
    }
    return { x: sx / ring.length, z: sz / ring.length }
  }
  return { x: x / (3 * area), z: z / (3 * area) }
}

/* ------------------------------------------------------------------ *
 * Geometry helpers
 * ------------------------------------------------------------------ */

/** Proper crossing of two segments, as parameters along each. Touching ends are not crossings. */
export function intersect(
  a: Point,
  b: Point,
  c: Point,
  d: Point,
): { t: number; u: number } | null {
  const rx = b.x - a.x
  const rz = b.z - a.z
  const sx = d.x - c.x
  const sz = d.z - c.z
  const denominator = rx * sz - rz * sx
  if (Math.abs(denominator) < 1e-12) return null
  const t = ((c.x - a.x) * sz - (c.z - a.z) * sx) / denominator
  const u = ((c.x - a.x) * rz - (c.z - a.z) * rx) / denominator
  if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return null
  return { t, u }
}

/** Uniform-grid index over segments, for crossing tests and nearest-segment queries. */
class SegmentIndex {
  private readonly buckets = new Map<number, Array<{ line: number; segment: number; a: Point; b: Point }>>()

  private readonly cellSize: number

  constructor(cellSize: number) {
    this.cellSize = cellSize
  }

  add(line: number, segment: number, a: Point, b: Point): void {
    const entry = { line, segment, a, b }
    for (const key of this.keysFor(a, b)) {
      const bucket = this.buckets.get(key)
      if (bucket) bucket.push(entry)
      else this.buckets.set(key, [entry])
    }
  }

  candidates(a: Point, b: Point): Array<{ line: number; segment: number }> {
    const found = new Map<string, { line: number; segment: number }>()
    for (const key of this.keysFor(a, b)) {
      for (const entry of this.buckets.get(key) ?? []) {
        found.set(`${entry.line}:${entry.segment}`, entry)
      }
    }
    return [...found.values()].sort((p, q) => p.line - q.line || p.segment - q.segment)
  }

  nearestExcluding(
    point: Point,
    radius: number,
    excludeLine: number,
  ): { point: Point; distance: number } | null {
    let best: { point: Point; distance: number } | null = null
    const span = Math.max(1, Math.ceil(radius / this.cellSize))
    const cx = Math.floor(point.x / this.cellSize)
    const cz = Math.floor(point.z / this.cellSize)
    for (let dz = -span; dz <= span; dz += 1) {
      for (let dx = -span; dx <= span; dx += 1) {
        for (const entry of this.buckets.get(cellKey(cx + dx, cz + dz)) ?? []) {
          if (entry.line === excludeLine) continue
          const near = closestOnSegment(point, entry.a, entry.b)
          if (near.distance > radius) continue
          if (best === null || near.distance < best.distance) best = near
        }
      }
    }
    return best
  }

  private keysFor(a: Point, b: Point): number[] {
    const minX = Math.floor(Math.min(a.x, b.x) / this.cellSize)
    const maxX = Math.floor(Math.max(a.x, b.x) / this.cellSize)
    const minZ = Math.floor(Math.min(a.z, b.z) / this.cellSize)
    const maxZ = Math.floor(Math.max(a.z, b.z) / this.cellSize)
    const keys: number[] = []
    for (let z = minZ; z <= maxZ; z += 1) for (let x = minX; x <= maxX; x += 1) keys.push(cellKey(x, z))
    return keys
  }
}

function cellKey(x: number, z: number): number {
  return (x + 100000) * 1000003 + (z + 100000)
}

export function closestOnSegment(point: Point, a: Point, b: Point): { point: Point; distance: number } {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const lengthSquared = dx * dx + dz * dz
  if (lengthSquared < 1e-12) {
    return { point: { x: a.x, z: a.z }, distance: Math.hypot(point.x - a.x, point.z - a.z) }
  }
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared))
  const projected = { x: a.x + dx * t, z: a.z + dz * t }
  return { point: projected, distance: Math.hypot(point.x - projected.x, point.z - projected.z) }
}

/**
 * Union of points that are within a weld radius of each other, keyed to a single id.
 *
 * Interning against the *first* point claimed by a cluster rather than re-averaging keeps this
 * order-independent for a fixed input order, which is what a deterministic plan requires.
 */
class PointWelder {
  private readonly buckets = new Map<number, number[]>()
  private readonly stored: Point[] = []

  private readonly radius: number

  constructor(radius: number) {
    this.radius = radius
  }

  intern(point: Point): number {
    const span = 1
    const cx = Math.floor(point.x / this.cellSize)
    const cz = Math.floor(point.z / this.cellSize)
    const radiusSquared = this.radius * this.radius
    for (let dz = -span; dz <= span; dz += 1) {
      for (let dx = -span; dx <= span; dx += 1) {
        for (const id of this.buckets.get(cellKey(cx + dx, cz + dz)) ?? []) {
          const held = this.stored[id]
          if ((held.x - point.x) ** 2 + (held.z - point.z) ** 2 <= radiusSquared) return id
        }
      }
    }
    const id = this.stored.length
    this.stored.push({ x: point.x, z: point.z })
    const key = cellKey(cx, cz)
    const bucket = this.buckets.get(key)
    if (bucket) bucket.push(id)
    else this.buckets.set(key, [id])
    return id
  }

  points(): Array<[number, Point]> {
    return this.stored.map((point, id) => [id, point] as [number, Point])
  }

  private get cellSize(): number {
    return Math.max(this.radius, 1e-6)
  }
}

function averageSegmentLength(input: ReadonlyArray<{ points: readonly Point[] }>): number {
  let total = 0
  let count = 0
  for (const entry of input) {
    for (let index = 1; index < entry.points.length; index += 1) {
      total += Math.hypot(
        entry.points[index].x - entry.points[index - 1].x,
        entry.points[index].z - entry.points[index - 1].z,
      )
      count += 1
    }
  }
  return count === 0 ? 1 : total / count
}
