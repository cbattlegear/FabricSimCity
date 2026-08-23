import { describe, expect, it } from 'vitest'
import { planField } from './cityField'
import { traceStreamlines, type Streamline } from './cityStreamlines'
import {
  breakCrossings,
  buildPlanarGraph,
  extractFaces,
  signedArea,
  type PlanarGraph,
} from './cityGraph'

const SEPARATION = 62
const GRAPH_OPTIONS = {
  weldRadius: SEPARATION * 0.12,
  snapRadius: SEPARATION * 0.75,
  minStub: SEPARATION * 0.35,
}
const CROSSING_OPTIONS = {
  seed: 7,
  targetCrossroadShare: 0.24,
  protectLength: SEPARATION * 7,
  maxRemovalShare: 0.3,
  maxMergedBlocks: 3,
  maxBlockArea: SEPARATION * SEPARATION * 7,
}

function streets(seed: string): Streamline[] {
  const radius = 700
  return traceStreamlines({
    field: planField({ seed, centreX: 0, centreZ: 0, radius }),
    minX: -radius * 1.1,
    maxX: radius * 1.1,
    minZ: -radius * 1.1,
    maxZ: radius * 1.1,
    separation: SEPARATION,
    edgeSeparationScale: 2.3,
    minLength: 90,
    maxStreamlines: 700,
  })
}

const RAW = buildPlanarGraph(streets('db:sales'), GRAPH_OPTIONS)
const GRAPH = breakCrossings(RAW, CROSSING_OPTIONS, GRAPH_OPTIONS)

function degrees(graph: PlanarGraph): number[] {
  const counts = new Map<number, number>()
  for (const edge of graph.edges) {
    counts.set(edge.fromId, (counts.get(edge.fromId) ?? 0) + 1)
    counts.set(edge.toId, (counts.get(edge.toId) ?? 0) + 1)
  }
  return [...counts.values()]
}

function componentCount(graph: PlanarGraph): number {
  const seen = new Set<number>()
  let components = 0
  for (const start of graph.nodes.keys()) {
    if (seen.has(start)) continue
    components += 1
    const queue = [start]
    seen.add(start)
    while (queue.length > 0) {
      const node = queue.pop()!
      for (const edgeId of graph.incident.get(node) ?? []) {
        const edge = graph.edges[edgeId]
        const other = edge.fromId === node ? edge.toId : edge.fromId
        if (seen.has(other)) continue
        seen.add(other)
        queue.push(other)
      }
    }
  }
  return components
}

describe('buildPlanarGraph', () => {
  it('numbers edges by their array index, which the face walk relies on', () => {
    GRAPH.edges.forEach((edge, index) => expect(edge.id).toBe(index))
  })

  it('keeps every edge endpoint in the node table', () => {
    for (const edge of GRAPH.edges) {
      expect(GRAPH.nodes.has(edge.fromId)).toBe(true)
      expect(GRAPH.nodes.has(edge.toId)).toBe(true)
    }
  })

  it('starts and ends every edge on its own endpoints', () => {
    for (const edge of GRAPH.edges) {
      const from = GRAPH.nodes.get(edge.fromId)!
      const to = GRAPH.nodes.get(edge.toId)!
      const first = edge.points[0]
      const last = edge.points[edge.points.length - 1]
      expect(Math.hypot(first.x - from.x, first.z - from.z)).toBeLessThan(1e-6)
      expect(Math.hypot(last.x - to.x, last.z - to.z)).toBeLessThan(1e-6)
    }
  })

  it('lists an edge against both of its endpoints and nowhere else', () => {
    for (const [nodeId, edgeIds] of GRAPH.incident) {
      for (const edgeId of edgeIds) {
        const edge = GRAPH.edges[edgeId]
        expect(edge.fromId === nodeId || edge.toId === nodeId).toBe(true)
      }
    }
  })

  it('is deterministic', () => {
    const again = breakCrossings(
      buildPlanarGraph(streets('db:sales'), GRAPH_OPTIONS),
      CROSSING_OPTIONS,
      GRAPH_OPTIONS,
    )
    expect(again.edges.length).toBe(GRAPH.edges.length)
    expect(again.nodes.size).toBe(GRAPH.nodes.size)
    again.edges.forEach((edge, index) => {
      expect(edge.points).toEqual(GRAPH.edges[index].points)
    })
  })
})

describe('breakCrossings', () => {
  /*
   * This is the test the whole redesign turns on. Two families of streamlines crossing produce a
   * quadrilateral mesh, which is a grid however much the streets curve, and the user reported
   * exactly that. Real street networks are dominated by T-junctions.
   */
  it('brings the crossroad share down to what real networks show', () => {
    const before = degrees(RAW)
    const after = degrees(GRAPH)
    const shareBefore = before.filter(d => d >= 4).length / before.length
    const shareAfter = after.filter(d => d >= 4).length / after.length
    expect(shareBefore).toBeGreaterThan(0.5)
    expect(shareAfter).toBeLessThan(0.3)
  })

  it('leaves more T-junctions than crossroads', () => {
    const after = degrees(GRAPH)
    expect(after.filter(d => d === 3).length).toBeGreaterThan(after.filter(d => d >= 4).length)
  })

  it('holds mean junction degree in the range real cities occupy', () => {
    const after = degrees(GRAPH)
    const mean = after.reduce((total, value) => total + value, 0) / after.length
    expect(mean).toBeGreaterThan(2.5)
    expect(mean).toBeLessThan(3.2)
  })

  it('does not break the network into more pieces than it started with', () => {
    expect(componentCount(GRAPH)).toBeLessThanOrEqual(componentCount(RAW))
  })
})

describe('extractFaces', () => {
  const faces = extractFaces(GRAPH)

  it('finds the city blocks', () => {
    expect(faces.length).toBeGreaterThan(80)
  })

  it('returns closed rings of at least three distinct points', () => {
    for (const face of faces) {
      expect(face.polygon.length).toBeGreaterThanOrEqual(3)
      expect(face.area).toBeGreaterThan(0)
    }
  })

  it('winds every bounded face the same way', () => {
    const signs = new Set(faces.map(face => Math.sign(signedArea(face.polygon))))
    expect(signs.size).toBe(1)
  })

  it('discards the unbounded outer face', () => {
    let spanX = 0
    let spanZ = 0
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const node of GRAPH.nodes.values()) {
      minX = Math.min(minX, node.x)
      maxX = Math.max(maxX, node.x)
      minZ = Math.min(minZ, node.z)
      maxZ = Math.max(maxZ, node.z)
    }
    spanX = maxX - minX
    spanZ = maxZ - minZ
    // The outer face would enclose the whole city; no block should come close to that.
    for (const face of faces) expect(face.area).toBeLessThan(spanX * spanZ * 0.25)
  })

  it('names only edges that exist', () => {
    for (const face of faces) {
      for (const edgeId of face.edgeIds) expect(GRAPH.edges[edgeId]).toBeDefined()
    }
  })

  it('partitions the ground rather than overlapping', () => {
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const node of GRAPH.nodes.values()) {
      minX = Math.min(minX, node.x)
      maxX = Math.max(maxX, node.x)
      minZ = Math.min(minZ, node.z)
      maxZ = Math.max(maxZ, node.z)
    }
    // Faces tile the interior exactly once, so their areas can never sum past the bounding box.
    const total = faces.reduce((sum, face) => sum + face.area, 0)
    expect(total).toBeLessThanOrEqual((maxX - minX) * (maxZ - minZ))
    // And they should cover a good share of it, or the walk is losing blocks.
    expect(total).toBeGreaterThan((maxX - minX) * (maxZ - minZ) * 0.4)
  })
})
