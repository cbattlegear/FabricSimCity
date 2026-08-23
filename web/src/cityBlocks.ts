import { polygonCentroid, signedArea, type Face, type PlanarGraph } from './cityGraph'
import type { Point } from './cityStreamlines'

/**
 * City blocks: the ground between the streets, and where a building may stand on it.
 *
 * The lattice this replaces answered three questions with arithmetic — where is block (col, row),
 * how big is it, and which blocks touch it — and the answers were the same for every block, which is
 * precisely why the map read as graph paper. Here the blocks are whatever shape the street network
 * left behind, so all three questions have to be answered from geometry.
 *
 * The module deliberately keeps the *shape* of the old lattice's interface: a block has an id, a
 * centre a building stands on, a kerb point it is entered from, and a list of neighbours. Everything
 * downstream — neighbourhood growth, land use, the 3D ground — asks the same questions it always
 * did and gets answers that happen to come from a planar face instead of a grid cell.
 *
 * Nothing here is a measurement. Block shapes come from the seeded street network; which building
 * stands on which block is a placement decision, and the building's own footprint and height are
 * untouched by it.
 */

export interface CityBlock {
  readonly id: number
  /** Boundary along the street centre lines: the block plus the half-carriageway around it. */
  readonly polygon: readonly Point[]
  /** The boundary pulled in off the kerb, which is the ground a building may actually occupy. */
  readonly buildable: readonly Point[]
  readonly centroid: Point
  readonly area: number
  /**
   * Side of the largest square that fits inside the block, centred on its centroid.
   *
   * This is the block's capacity. Because building footprints are measured and may not be adjusted,
   * a block that cannot hold its building is a real problem rather than a cosmetic one, so capacity
   * is computed up front and buildings are matched to blocks that can take them.
   */
  readonly capacity: number
  /** Graph edge the building fronts; the route from anywhere in the city ends on it. */
  readonly frontageEdgeId: number
  /** Point on that street's kerb the building is entered from. */
  readonly frontage: Point
  /** Y rotation turning a +Z-facing model toward its frontage. */
  readonly heading: number
  /** Blocks sharing a street with this one, which is how a neighbourhood grows contiguously. */
  readonly neighbours: readonly number[]
  /** Distance from the city centre as a fraction of its radius. Position on the map, nothing more. */
  readonly centrality: number
}

export interface CityBlockField {
  readonly blocks: readonly CityBlock[]
  block(id: number): CityBlock | undefined
  /** Block containing a world point, or the nearest one if it fell in the street. */
  blockAt(x: number, z: number): CityBlock | undefined
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
}

export interface BlockOptions {
  /** Half the carriageway plus the pavement: how far a building sits back from the centre line. */
  readonly setback: number
  /** Blocks whose capacity falls below this are slivers, not places, and are dropped. */
  readonly minCapacity: number
}

export function buildBlocks(
  graph: PlanarGraph,
  faces: readonly Face[],
  options: BlockOptions,
): CityBlockField {
  const byEdge = new Map<number, number[]>()
  for (const face of faces) {
    for (const edgeId of face.edgeIds) {
      const bucket = byEdge.get(edgeId)
      if (bucket) bucket.push(face.id)
      else byEdge.set(edgeId, [face.id])
    }
  }

  const candidates: CityBlock[] = []
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const face of faces) {
    const ring = orient(face.polygon)
    const buildable = inset(ring, options.setback)
    if (buildable.length < 3) continue
    const centroid = polygonCentroid(buildable)
    const capacity = squareCapacity(buildable, centroid)
    if (capacity < options.minCapacity) continue

    const frontage = chooseFrontage(graph, face, centroid)
    if (frontage === null) continue

    const neighbours = new Set<number>()
    for (const edgeId of face.edgeIds) {
      for (const other of byEdge.get(edgeId) ?? []) if (other !== face.id) neighbours.add(other)
    }

    for (const point of ring) {
      minX = Math.min(minX, point.x)
      maxX = Math.max(maxX, point.x)
      minZ = Math.min(minZ, point.z)
      maxZ = Math.max(maxZ, point.z)
    }

    candidates.push({
      id: face.id,
      polygon: ring,
      buildable,
      centroid,
      area: Math.abs(signedArea(buildable)),
      capacity,
      frontageEdgeId: frontage.edgeId,
      frontage: frontage.point,
      // atan2(dx, dz) rather than the usual (dz, dx): the model faces +Z, not +X.
      heading: Math.atan2(frontage.point.x - centroid.x, frontage.point.z - centroid.z),
      neighbours: [...neighbours],
      centrality: 0,
    })
  }

  const centreX = (minX + maxX) / 2
  const centreZ = (minZ + maxZ) / 2
  const radius = Math.max(1, Math.hypot(maxX - minX, maxZ - minZ) / 2)
  const blocks = candidates.map(block => ({
    ...block,
    centrality: Math.min(1, Math.hypot(block.centroid.x - centreX, block.centroid.z - centreZ) / radius),
  }))

  const index = new Map<number, CityBlock>()
  for (const block of blocks) index.set(block.id, block)
  // Neighbours are filtered last so a dropped sliver cannot be referenced by the blocks it touched.
  const linked = blocks.map(block => ({
    ...block,
    neighbours: block.neighbours.filter(id => index.has(id)),
  }))
  const finalIndex = new Map<number, CityBlock>()
  for (const block of linked) finalIndex.set(block.id, block)

  const lookup = new BlockLookup(linked)
  return {
    blocks: linked,
    block: id => finalIndex.get(id),
    blockAt: (x, z) => lookup.at(x, z),
    minX, maxX, minZ, maxZ,
  }
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/** Counter-clockwise, so the inward normal of every edge is consistent. */
function orient(ring: readonly Point[]): Point[] {
  const points = dedupe(ring)
  return signedArea(points) < 0 ? [...points].reverse() : points
}

function dedupe(ring: readonly Point[]): Point[] {
  const out: Point[] = []
  for (const point of ring) {
    const last = out[out.length - 1]
    if (last && Math.hypot(last.x - point.x, last.z - point.z) < 1e-6) continue
    out.push(point)
  }
  while (out.length > 1) {
    const first = out[0]
    const last = out[out.length - 1]
    if (Math.hypot(first.x - last.x, first.z - last.z) >= 1e-6) break
    out.pop()
  }
  return out
}

/**
 * Pulls a ring inward by `distance`, by offsetting each edge and re-intersecting the neighbours.
 *
 * Offsetting the *edges* rather than moving the vertices toward the centroid is what keeps the
 * setback even. Scaling a long thin block about its centroid takes far more off its ends than off
 * its sides, which on this map would show up as buildings crowding the kerb on one street and
 * standing well back from another.
 *
 * At a sharp corner two offset edges meet a long way from the original vertex, so the join is capped;
 * and a block narrower than twice the setback inverts, which is detected by the area changing sign
 * and reported as an empty ring for the caller to discard.
 */
export function inset(ring: readonly Point[], distance: number): Point[] {
  if (ring.length < 3 || distance <= 0) return [...ring]
  const count = ring.length
  const lines: Array<{ x: number; z: number; nx: number; nz: number }> = []
  for (let index = 0; index < count; index += 1) {
    const a = ring[index]
    const b = ring[(index + 1) % count]
    const dx = b.x - a.x
    const dz = b.z - a.z
    const length = Math.hypot(dx, dz)
    if (length < 1e-9) return []
    // Left normal of a counter-clockwise ring points inward.
    const nx = -dz / length
    const nz = dx / length
    lines.push({ x: a.x + nx * distance, z: a.z + nz * distance, nx, nz })
  }

  const corners: Point[] = []
  for (let index = 0; index < count; index += 1) {
    const previous = lines[(index + count - 1) % count]
    const current = lines[index]
    const original = ring[index]
    const point = intersectLines(previous, current)
    const drift = point === null
      ? Infinity
      : Math.hypot(point.x - original.x, point.z - original.z)
    // A near-parallel pair meets far away, or not at all; capping keeps a spike out of the block and
    // keeps one corner per original vertex, which the direction check below relies on.
    corners.push(point !== null && drift <= distance * 6 ? point : {
      x: original.x + (current.nx + previous.nx) * distance * 0.5,
      z: original.z + (current.nz + previous.nz) * distance * 0.5,
    })
  }

  /*
   * A ring narrower than twice the setback turns inside out rather than vanishing: the offset of one
   * side crosses the offset of the opposite side and the intersections trace a small polygon in the
   * middle, which for a symmetric shape even keeps the original winding, so an area test alone does
   * not catch it. Each offset edge is by construction parallel to the edge it came from, so an edge
   * that has reversed direction is exactly the signature of that over-run.
   *
   * Only edges long enough for their direction to be meaningful are tested. A block boundary follows
   * a curved street and is made of many very short segments whose direction is numerical noise.
   */
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count
    const originalX = ring[next].x - ring[index].x
    const originalZ = ring[next].z - ring[index].z
    if (Math.hypot(originalX, originalZ) < distance * 0.5) continue
    const insetX = corners[next].x - corners[index].x
    const insetZ = corners[next].z - corners[index].z
    if (originalX * insetX + originalZ * insetZ < 0) return []
  }

  const cleaned = dedupe(corners)
  if (cleaned.length < 3) return []
  if (signedArea(cleaned) <= 0) return []
  return cleaned
}

function intersectLines(
  a: { x: number; z: number; nx: number; nz: number },
  b: { x: number; z: number; nx: number; nz: number },
): Point | null {
  // Direction of each offset line is its normal turned a quarter turn.
  const adx = a.nz
  const adz = -a.nx
  const bdx = b.nz
  const bdz = -b.nx
  const denominator = adx * bdz - adz * bdx
  if (Math.abs(denominator) < 1e-9) return null
  const t = ((b.x - a.x) * bdz - (b.z - a.z) * bdx) / denominator
  return { x: a.x + adx * t, z: a.z + adz * t }
}

/**
 * Side of the largest axis-aligned square centred on `centre` that stays inside `ring`.
 *
 * Twice the distance to the nearest boundary edge, which is exact for the inscribed *circle* and a
 * safe under-estimate for the square. Under-estimating is the right way to be wrong: a building that
 * is told it does not fit gets a roomier block, whereas one wrongly told it fits ends up standing in
 * the road.
 */
export function squareCapacity(ring: readonly Point[], centre: Point): number {
  if (!containsPoint(ring, centre)) return 0
  let nearest = Infinity
  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index]
    const b = ring[(index + 1) % ring.length]
    nearest = Math.min(nearest, distanceToSegment(centre, a, b))
  }
  return nearest === Infinity ? 0 : nearest * Math.SQRT2
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const lengthSquared = dx * dx + dz * dz
  if (lengthSquared < 1e-12) return Math.hypot(point.x - a.x, point.z - a.z)
  let t = ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t))
}

export function containsPoint(ring: readonly Point[], point: Point): boolean {
  let inside = false
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[index]
    const b = ring[previous]
    const straddles = a.z > point.z !== b.z > point.z
    if (straddles && point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

/**
 * The street a block's building fronts, and the point on it the door opens onto.
 *
 * The longest bounding street wins. A building addresses the street that gives it the most frontage,
 * which is both what actually happens and what makes the map legible: the entrance faces the road
 * the eye is already following, rather than a two-metre corner splay.
 */
function chooseFrontage(
  graph: PlanarGraph,
  face: Face,
  centroid: Point,
): { edgeId: number; point: Point } | null {
  let best: { edgeId: number; point: Point; length: number } | null = null
  for (const edgeId of face.edgeIds) {
    const edge = graph.edges[edgeId]
    if (!edge) continue
    if (best !== null && edge.length <= best.length) continue
    best = { edgeId, point: nearestOnPolyline(edge.points, centroid), length: edge.length }
  }
  return best === null ? null : { edgeId: best.edgeId, point: best.point }
}

function nearestOnPolyline(points: readonly Point[], from: Point): Point {
  let best = points[0]
  let bestDistance = Infinity
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index]
    const b = points[index + 1]
    const dx = b.x - a.x
    const dz = b.z - a.z
    const lengthSquared = dx * dx + dz * dz
    let t = lengthSquared < 1e-12 ? 0 : ((from.x - a.x) * dx + (from.z - a.z) * dz) / lengthSquared
    t = Math.max(0, Math.min(1, t))
    const candidate = { x: a.x + dx * t, z: a.z + dz * t }
    const distance = Math.hypot(candidate.x - from.x, candidate.z - from.z)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return best
}

/** Uniform grid over the blocks so "which block is this point in" does not scan them all. */
class BlockLookup {
  private readonly cells = new Map<string, number[]>()
  private readonly size: number

  private readonly blocks: readonly CityBlock[]

  constructor(blocks: readonly CityBlock[]) {
    this.blocks = blocks
    const mean = blocks.length === 0
      ? 1
      : blocks.reduce((total, block) => total + Math.sqrt(Math.max(block.area, 1)), 0) / blocks.length
    this.size = Math.max(1, mean)
    blocks.forEach((block, index) => {
      let minX = Infinity
      let maxX = -Infinity
      let minZ = Infinity
      let maxZ = -Infinity
      for (const point of block.polygon) {
        minX = Math.min(minX, point.x)
        maxX = Math.max(maxX, point.x)
        minZ = Math.min(minZ, point.z)
        maxZ = Math.max(maxZ, point.z)
      }
      for (let cx = Math.floor(minX / this.size); cx <= Math.floor(maxX / this.size); cx += 1) {
        for (let cz = Math.floor(minZ / this.size); cz <= Math.floor(maxZ / this.size); cz += 1) {
          const key = `${cx}:${cz}`
          const bucket = this.cells.get(key)
          if (bucket) bucket.push(index)
          else this.cells.set(key, [index])
        }
      }
    })
  }

  at(x: number, z: number): CityBlock | undefined {
    const key = `${Math.floor(x / this.size)}:${Math.floor(z / this.size)}`
    let fallback: CityBlock | undefined
    let fallbackDistance = Infinity
    for (const index of this.cells.get(key) ?? []) {
      const block = this.blocks[index]
      if (containsPoint(block.polygon, { x, z })) return block
      const distance = Math.hypot(block.centroid.x - x, block.centroid.z - z)
      if (distance < fallbackDistance) {
        fallbackDistance = distance
        fallback = block
      }
    }
    return fallback
  }
}
