import { describe, expect, it } from 'vitest'
import { planField } from './cityField'
import { traceStreamlines } from './cityStreamlines'
import { breakCrossings, buildPlanarGraph, connectComponents, extractFaces, signedArea } from './cityGraph'
import { buildBlocks, containsPoint, inset, squareCapacity } from './cityBlocks'
import { classifyRoads, edgeBetweenness, RoadRouter, type RoadClass } from './cityRouting'

const SEPARATION = 62
const GRAPH_OPTIONS = {
  weldRadius: SEPARATION * 0.12,
  snapRadius: SEPARATION * 1.25,
  minStub: SEPARATION * 0.6,
}
const radius = 700
const LINES = traceStreamlines({
  field: planField({ seed: 'db:sales', centreX: 0, centreZ: 0, radius }),
  minX: -radius * 1.1,
  maxX: radius * 1.1,
  minZ: -radius * 1.1,
  maxZ: radius * 1.1,
  separation: SEPARATION,
  edgeSeparationScale: 2.3,
  minLength: 90,
  maxStreamlines: 700,
})
const GRAPH = breakCrossings(
  buildPlanarGraph(LINES, GRAPH_OPTIONS),
  {
    seed: 7,
    targetCrossroadShare: 0.24,
    protectLength: SEPARATION * 7,
    maxRemovalShare: 0.3,
    maxMergedBlocks: 3,
    maxBlockArea: SEPARATION * SEPARATION * 7,
  },
  GRAPH_OPTIONS,
)
const FACES = extractFaces(GRAPH)
const FIELD = buildBlocks(GRAPH, FACES, { setback: 5, minCapacity: 10 })
// Blocks come from the traced streets; routing additionally gets link roads into any stranded
// pocket, which is why the two are taken from the graph at different stages.
const ROUTING_GRAPH = connectComponents(GRAPH)

const SQUARE = [
  { x: 0, z: 0 },
  { x: 100, z: 0 },
  { x: 100, z: 100 },
  { x: 0, z: 100 },
]

describe('inset', () => {
  it('pulls a square in by the setback on every side', () => {
    const result = inset(SQUARE, 10)
    expect(result).toHaveLength(4)
    for (const point of result) {
      expect(Math.min(point.x, 100 - point.x)).toBeCloseTo(10, 6)
      expect(Math.min(point.z, 100 - point.z)).toBeCloseTo(10, 6)
    }
  })

  /*
   * Offsetting the edges rather than scaling about the centroid is the whole point: scaling takes
   * far more off the ends of a long block than off its sides, which would show up as buildings
   * crowding one kerb and standing well back from another.
   */
  it('keeps the setback even on a long thin block', () => {
    const strip = [
      { x: 0, z: 0 },
      { x: 400, z: 0 },
      { x: 400, z: 40 },
      { x: 0, z: 40 },
    ]
    const result = inset(strip, 8)
    for (const point of result) {
      expect(Math.min(point.x, 400 - point.x)).toBeCloseTo(8, 6)
      expect(Math.min(point.z, 40 - point.z)).toBeCloseTo(8, 6)
    }
  })

  it('reports no buildable ground when the block is thinner than twice the setback', () => {
    expect(inset(SQUARE, 60)).toEqual([])
  })

  it('always shrinks the ring', () => {
    const result = inset(SQUARE, 10)
    expect(Math.abs(signedArea(result))).toBeLessThan(Math.abs(signedArea(SQUARE)))
  })
})

describe('squareCapacity', () => {
  it('measures the largest square that fits', () => {
    expect(squareCapacity(SQUARE, { x: 50, z: 50 })).toBeCloseTo(50 * Math.SQRT2, 6)
  })

  it('is zero when the centre is outside the ring', () => {
    expect(squareCapacity(SQUARE, { x: 300, z: 300 })).toBe(0)
  })
})

describe('buildBlocks', () => {
  it('recovers a block for most faces', () => {
    expect(FIELD.blocks.length).toBeGreaterThan(FACES.length * 0.6)
  })

  it('stands every building on ground it owns', () => {
    for (const block of FIELD.blocks) {
      expect(containsPoint(block.buildable, block.centroid)).toBe(true)
    }
  })

  it('sets a building back from the street it fronts', () => {
    for (const block of FIELD.blocks) {
      // The frontage sits on the kerb line, so it is outside the buildable ring by construction.
      expect(containsPoint(block.buildable, block.frontage)).toBe(false)
    }
  })

  it('turns each building toward its own frontage', () => {
    for (const block of FIELD.blocks) {
      const expected = Math.atan2(
        block.frontage.x - block.centroid.x,
        block.frontage.z - block.centroid.z,
      )
      expect(block.heading).toBeCloseTo(expected, 9)
    }
  })

  it('fronts a street that actually bounds the block', () => {
    const byId = new Map(FACES.map(face => [face.id, face]))
    for (const block of FIELD.blocks) {
      expect(byId.get(block.id)!.edgeIds).toContain(block.frontageEdgeId)
    }
  })

  /*
   * Neighbourhoods grow over this adjacency, so an asymmetric link would let a schema claim ground
   * it cannot reach and leave its tables scattered - which is the thing the user asked to fix.
   */
  it('records adjacency symmetrically', () => {
    const byId = new Map(FIELD.blocks.map(block => [block.id, block]))
    for (const block of FIELD.blocks) {
      for (const neighbour of block.neighbours) {
        expect(byId.get(neighbour)!.neighbours).toContain(block.id)
      }
    }
  })

  it('never lists a dropped sliver as a neighbour', () => {
    const ids = new Set(FIELD.blocks.map(block => block.id))
    for (const block of FIELD.blocks) {
      for (const neighbour of block.neighbours) expect(ids.has(neighbour)).toBe(true)
    }
  })

  it('gives blocks a wide range of sizes', () => {
    const capacities = FIELD.blocks.map(block => block.capacity).sort((a, b) => a - b)
    const small = capacities[Math.floor(capacities.length * 0.1)]
    const large = capacities[Math.floor(capacities.length * 0.9)]
    expect(large / small).toBeGreaterThan(1.8)
  })

  it('drops blocks too small to build on', () => {
    for (const block of FIELD.blocks) expect(block.capacity).toBeGreaterThanOrEqual(10)
  })

  it('finds the block a point sits in', () => {
    for (const block of FIELD.blocks.slice(0, 40)) {
      expect(FIELD.blockAt(block.centroid.x, block.centroid.z)?.id).toBe(block.id)
    }
  })
})

describe('edgeBetweenness', () => {
  const scores = edgeBetweenness(GRAPH)

  it('scores every edge', () => {
    expect(scores.size).toBe(GRAPH.edges.length)
  })

  it('never scores below zero', () => {
    for (const value of scores.values()) expect(value).toBeGreaterThanOrEqual(0)
  })

  /*
   * A cul-de-sac is on no journey but its own, so it must score near nothing. If dead ends came out
   * central, the measure is wrong and the hierarchy built on it would be nonsense.
   */
  it('scores dead ends far below through routes', () => {
    const dangling: number[] = []
    const through: number[] = []
    for (const edge of GRAPH.edges) {
      const isDangling = (GRAPH.incident.get(edge.fromId)?.length ?? 0) <= 1 ||
        (GRAPH.incident.get(edge.toId)?.length ?? 0) <= 1
      ;(isDangling ? dangling : through).push(scores.get(edge.id) ?? 0)
    }
    expect(dangling.length).toBeGreaterThan(0)
    const meanDangling = dangling.reduce((a, b) => a + b, 0) / dangling.length
    const meanThrough = through.reduce((a, b) => a + b, 0) / through.length
    expect(meanDangling).toBeLessThan(meanThrough * 0.25)
  })

  /*
   * Above a few hundred junctions the sweep samples its sources instead of running from all of them,
   * and the whole hierarchy rests on the result. What has to survive sampling is the *ordering* —
   * the classifier only ever asks which band an edge falls in — so this checks the sampled ranking
   * against the exact one on a graph large enough to trigger it. Spearman's rank correlation is the
   * right measure precisely because it ignores the magnitudes the estimator is allowed to get wrong.
   */
  it('keeps the ranking when it samples its sources', () => {
    const big = 1500
    const lines = traceStreamlines({
      field: planField({ seed: 'db:big', centreX: 0, centreZ: 0, radius: big }),
      minX: -big * 1.1,
      maxX: big * 1.1,
      minZ: -big * 1.1,
      maxZ: big * 1.1,
      separation: SEPARATION,
      edgeSeparationScale: 2.3,
      minLength: 90,
      maxStreamlines: 4000,
    })
    const graph = buildPlanarGraph(lines, GRAPH_OPTIONS)
    expect(graph.nodes.size).toBeGreaterThan(320)

    const sampled = edgeBetweenness(graph)
    const exact = edgeBetweenness(graph, { maxSources: Number.POSITIVE_INFINITY })

    const rank = (scores: Map<number, number>): Map<number, number> => {
      const order = [...scores.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0])
      return new Map(order.map(([edgeId], position) => [edgeId, position]))
    }
    const sampledRank = rank(sampled)
    const exactRank = rank(exact)
    const n = graph.edges.length
    let sumSquares = 0
    for (const edge of graph.edges) {
      const difference = (sampledRank.get(edge.id) ?? 0) - (exactRank.get(edge.id) ?? 0)
      sumSquares += difference * difference
    }
    const spearman = 1 - (6 * sumSquares) / (n * (n * n - 1))
    expect(spearman).toBeGreaterThan(0.95)

    // And the point of it all: the busiest streets are the same streets.
    const top = (scores: Map<number, number>): Set<number> =>
      new Set(
        [...scores.entries()]
          .sort((a, b) => b[1] - a[1] || a[0] - b[0])
          .slice(0, Math.round(n * 0.09))
          .map(([edgeId]) => edgeId),
      )
    const sampledTop = top(sampled)
    const exactTop = top(exact)
    let shared = 0
    for (const edgeId of sampledTop) if (exactTop.has(edgeId)) shared += 1
    expect(shared / sampledTop.size).toBeGreaterThan(0.8)
  })
})

describe('classifyRoads', () => {
  const roads = classifyRoads(GRAPH)

  it('classifies every street', () => {
    expect(roads.size).toBe(GRAPH.edges.length)
  })

  it('builds a hierarchy rather than a flat network', () => {
    const tally = new Map<RoadClass, number>()
    for (const road of roads.values()) tally.set(road.roadClass, (tally.get(road.roadClass) ?? 0) + 1)
    const major = (tally.get('motorway') ?? 0) + (tally.get('primary') ?? 0)
    // Main roads must be a minority or the weight of the lines carries no information.
    expect(major / GRAPH.edges.length).toBeLessThan(0.2)
    expect(major).toBeGreaterThan(0)
    expect(tally.size).toBeGreaterThan(3)
  })

  it('never makes a dead end a main road', () => {
    for (const edge of GRAPH.edges) {
      const dangling = (GRAPH.incident.get(edge.fromId)?.length ?? 0) <= 1 ||
        (GRAPH.incident.get(edge.toId)?.length ?? 0) <= 1
      if (dangling) expect(roads.get(edge.id)!.roadClass).toBe('service')
    }
  })

  it('gives faster roads more width', () => {
    const sorted = [...roads.values()].sort((a, b) => a.speedLimit - b.speedLimit)
    for (let index = 1; index < sorted.length; index += 1) {
      expect(sorted[index].width).toBeGreaterThanOrEqual(sorted[index - 1].width)
    }
  })
})

describe('connectComponents', () => {
  it('leaves an already connected network alone', () => {
    const connected = connectComponents(ROUTING_GRAPH)
    expect(connected.edges.length).toBe(ROUTING_GRAPH.edges.length)
  })

  /*
   * The failure this exists to prevent is invisible on the map: a stranded pocket draws perfectly,
   * and only a query route between two buildings coming back empty reveals that one cannot be
   * reached from the other. So the check is reachability, not appearance.
   */
  it('makes every junction reachable from every other', () => {
    const reached = new Set<number>()
    const start = [...ROUTING_GRAPH.nodes.keys()][0]
    const stack = [start]
    reached.add(start)
    while (stack.length > 0) {
      const at = stack.pop()!
      for (const edgeId of ROUTING_GRAPH.incident.get(at) ?? []) {
        const edge = ROUTING_GRAPH.edges[edgeId]
        const next = edge.fromId === at ? edge.toId : edge.fromId
        if (reached.has(next)) continue
        reached.add(next)
        stack.push(next)
      }
    }
    expect(reached.size).toBe(ROUTING_GRAPH.nodes.size)
  })

  it('keeps every junction and every street, and only adds', () => {
    expect(ROUTING_GRAPH.nodes.size).toBe(GRAPH.nodes.size)
    expect(ROUTING_GRAPH.edges.length).toBeGreaterThanOrEqual(GRAPH.edges.length)
    for (let index = 0; index < GRAPH.edges.length; index += 1) {
      expect(ROUTING_GRAPH.edges[index].streamlineId).toBe(GRAPH.edges[index].streamlineId)
    }
  })

  it('joins two islands across their closest approach', () => {
    // Two squares, far enough apart that nothing in the tracer would have bridged them.
    const square = (ox: number): Point[][] => [
      [{ x: ox, z: 0 }, { x: ox + 100, z: 0 }],
      [{ x: ox + 100, z: 0 }, { x: ox + 100, z: 100 }],
      [{ x: ox + 100, z: 100 }, { x: ox, z: 100 }],
      [{ x: ox, z: 100 }, { x: ox, z: 0 }],
    ]
    const lines = [...square(0), ...square(400)].map((points, index) => ({
      id: `s${index}`,
      family: 'major' as const,
      points,
    }))
    const graph = buildPlanarGraph(lines, { weldRadius: 1, snapRadius: 2, minStub: 1 })
    const connected = connectComponents(graph)
    expect(connected.edges.length).toBe(graph.edges.length + 1)

    const link = connected.edges[connected.edges.length - 1]
    const from = connected.nodes.get(link.fromId)!
    const to = connected.nodes.get(link.toId)!
    // The gap between the squares is 300; anything longer means it did not pick the closest pair.
    expect(Math.hypot(from.x - to.x, from.z - to.z)).toBeCloseTo(300, 5)
  })
})

describe('RoadRouter', () => {
  const roads = classifyRoads(ROUTING_GRAPH)
  const router = new RoadRouter(ROUTING_GRAPH, roads)
  const nodeIds = [...ROUTING_GRAPH.nodes.keys()]

  it('finds a route between arbitrary junctions', () => {
    let found = 0
    for (let index = 0; index < 200; index += 1) {
      const from = nodeIds[(index * 37) % nodeIds.length]
      const to = nodeIds[(index * 101 + 13) % nodeIds.length]
      if (router.route(from, to) !== null) found += 1
    }
    expect(found).toBe(200)
  })

  it('returns a connected path whose ends are the requested junctions', () => {
    const from = nodeIds[0]
    const to = nodeIds[nodeIds.length - 1]
    const route = router.route(from, to)!
    expect(route.nodeIds[0]).toBe(from)
    expect(route.nodeIds[route.nodeIds.length - 1]).toBe(to)
    expect(route.edgeIds.length).toBe(route.nodeIds.length - 1)
    for (let index = 0; index < route.edgeIds.length; index += 1) {
      const edge = ROUTING_GRAPH.edges[route.edgeIds[index]]
      const a = route.nodeIds[index]
      const b = route.nodeIds[index + 1]
      expect(edge.fromId === a && edge.toId === b || edge.fromId === b && edge.toId === a).toBe(true)
    }
  })

  it('draws a path with no gaps in it', () => {
    const route = router.route(nodeIds[3], nodeIds[nodeIds.length - 4])!
    for (let index = 1; index < route.path.length; index += 1) {
      const step = Math.hypot(
        route.path[index].x - route.path[index - 1].x,
        route.path[index].z - route.path[index - 1].z,
      )
      expect(step).toBeLessThan(SEPARATION * 4)
    }
  })

  it('is deterministic', () => {
    // Rebuilt from scratch, including the connectivity pass, so this covers that too.
    const rebuilt = connectComponents(GRAPH)
    const twin = new RoadRouter(rebuilt, classifyRoads(rebuilt))
    for (let index = 0; index < 40; index += 1) {
      const from = nodeIds[(index * 17) % nodeIds.length]
      const to = nodeIds[(index * 61 + 5) % nodeIds.length]
      expect(twin.route(from, to)?.edgeIds).toEqual(router.route(from, to)?.edgeIds)
    }
  })

  /*
   * The point of routing on travel time rather than distance: journeys should collect onto the main
   * roads instead of spreading evenly over the back streets, which is what makes the traffic drawn
   * on top of them legible.
   */
  it('prefers main roads over back streets', () => {
    const used = new Map<number, number>()
    for (let index = 0; index < 300; index += 1) {
      const from = nodeIds[(index * 37) % nodeIds.length]
      const to = nodeIds[(index * 101 + 13) % nodeIds.length]
      for (const edgeId of router.route(from, to)?.edgeIds ?? []) {
        used.set(edgeId, (used.get(edgeId) ?? 0) + 1)
      }
    }
    const mainUse: number[] = []
    const localUse: number[] = []
    for (const edge of GRAPH.edges) {
      const roadClass = roads.get(edge.id)!.roadClass
      const uses = used.get(edge.id) ?? 0
      if (roadClass === 'motorway' || roadClass === 'primary') mainUse.push(uses)
      else if (roadClass === 'residential' || roadClass === 'service') localUse.push(uses)
    }
    const meanMain = mainUse.reduce((a, b) => a + b, 0) / mainUse.length
    const meanLocal = localUse.reduce((a, b) => a + b, 0) / localUse.length
    expect(meanMain).toBeGreaterThan(meanLocal * 3)
  })

  it('routes a junction to itself as a standing start', () => {
    const route = router.route(nodeIds[5], nodeIds[5])!
    expect(route.edgeIds).toEqual([])
    expect(route.distance).toBe(0)
  })

  it('reports no route to a junction that does not exist', () => {
    expect(router.route(nodeIds[0], -1)).toBeNull()
  })
})
