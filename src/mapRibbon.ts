import * as THREE from 'three'
import { dashSpans, offsetPolyline, type DashPattern } from './cityRoads'

/**
 * Turning a centreline into a drawn road.
 *
 * This is the one piece of geometry both map surfaces have to agree on. A road on the database city
 * and a road on the server atlas are the same object seen from two altitudes, and the thing that
 * makes either of them read as a road rather than as a line on a diagram is the pair of ribbons: a
 * wide casing underneath, a narrower fill on top. Drawn as a plain line — which is what the atlas did
 * — a road has no edge, no hierarchy and no figure against the paper, and the drawing stops being a
 * map.
 *
 * It lived inside the database city's scene until the atlas needed it. Nothing about it was ever
 * specific to a city; it is a polyline, a width, and an optional dash.
 */

/**
 * Triangles for a ribbon of `width` centred on `points`, as a flat XZ position array.
 *
 * Appends into `out` so a whole road network can be accumulated into one buffer and drawn in a single
 * call, which is what makes a map of a hundred towns affordable.
 */
export function ribbonPositions(
  points: ReadonlyArray<{ x: number; z: number }>,
  width: number,
  dash: DashPattern | null,
  offset = 0,
  out: number[] = [],
  y = 0,
): number[] {
  const line = offsetPolyline(points, offset)
  if (line.length < 2) return out
  const half = width / 2
  const push = (
    ax: number,
    az: number,
    bx: number,
    bz: number,
    nx: number,
    nz: number,
  ) => {
    out.push(
      ax + nx, y, az + nz,
      bx + nx, y, bz + nz,
      bx - nx, y, bz - nz,
      ax + nx, y, az + nz,
      bx - nx, y, bz - nz,
      ax - nx, y, az - nz,
    )
  }

  for (const span of dashSpans(line, dash)) {
    const length = Math.hypot(span.bx - span.ax, span.bz - span.az)
    if (length < 1e-6) continue
    const ux = (span.bx - span.ax) / length
    const uz = (span.bz - span.az) / length
    push(span.ax, span.az, span.bx, span.bz, -uz * half, ux * half)
  }

  /*
   * Patch the joints of an unbroken ribbon.
   *
   * Each span is mitre-free, so a bend leaves a wedge of missing ground on the outside of the turn.
   * The old patch was an axis-aligned square, which was exactly right for a lattice that only ever
   * bent at 90° and catastrophically wrong now that streets curve and run diagonally: it fired a
   * square off at every vertex of every bend, which read as white starbursts across the basemap.
   *
   * A disc is the only join that is correct for every angle, and a rounded join is what a printed
   * basemap draws anyway. Endpoints get one too, which closes junctions and the four outer corners
   * of the city without a special case. A dashed ribbon gets none — its dashes carry around the turn
   * on their own, and capping them would fill in the gaps that carry the meaning.
   */
  if (dash === null) {
    for (const point of line) pushDisc(out, point.x, point.z, half, y)
  }
  return out
}

export function pushDisc(out: number[], x: number, z: number, radius: number, y: number, segments = 10) {
  if (radius <= 0) return
  const step = (Math.PI * 2) / segments
  for (let i = 0; i < segments; i += 1) {
    const a = i * step
    const b = a + step
    out.push(
      x, y, z,
      x + Math.cos(a) * radius, y, z + Math.sin(a) * radius,
      x + Math.cos(b) * radius, y, z + Math.sin(b) * radius,
    )
  }
}

export function ribbonGeometry(
  points: ReadonlyArray<{ x: number; z: number }>,
  width: number,
  dash: DashPattern | null,
  offset = 0,
): THREE.BufferGeometry | null {
  const positions = ribbonPositions(points, width, dash, offset)
  if (positions.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return geometry
}

/** Triangles for a closed polygon, fan-triangulated about its centroid. Flat, in XZ, at height `y`. */
export function polygonPositions(
  points: ReadonlyArray<{ x: number; z: number }>,
  y: number,
  out: number[] = [],
): number[] {
  if (points.length < 3) return out
  let cx = 0
  let cz = 0
  for (const point of points) {
    cx += point.x
    cz += point.z
  }
  cx /= points.length
  cz /= points.length
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]
    const b = points[(index + 1) % points.length]
    out.push(cx, y, cz, a.x, y, a.z, b.x, y, b.z)
  }
  return out
}

/**
 * Signed area of a closed polygon in XZ.
 *
 * The atlas leans on this rather than trusting a shape to look right: a town's outline is irregular
 * on purpose, and the only thing keeping it honest is that its area still equals the measurement it
 * was given.
 */
export function polygonArea(points: ReadonlyArray<{ x: number; z: number }>): number {
  if (points.length < 3) return 0
  let total = 0
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]
    const b = points[(index + 1) % points.length]
    total += a.x * b.z - b.x * a.z
  }
  return Math.abs(total) / 2
}

/** Whether a point falls inside a closed polygon, by the even-odd rule. */
export function pointInPolygon(
  points: ReadonlyArray<{ x: number; z: number }>,
  x: number,
  z: number,
): boolean {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i]
    const b = points[j]
    if ((a.z > z) === (b.z > z)) continue
    if (x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

/**
 * Shortest distance from a point to a polyline, and the point on it that is closest.
 *
 * Used to keep buildings off the roads. A town whose buildings sit on a lattice *and* whose roads are
 * drawn over them has two unrelated drawings stacked on one another; clearing a corridor along every
 * street is what turns a field of blocks into a street plan.
 */
export function nearestOnPolyline(
  points: ReadonlyArray<{ x: number; z: number }>,
  x: number,
  z: number,
): { x: number; z: number; distance: number } {
  let best = { x, z, distance: Infinity }
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]
    const b = points[index]
    const dx = b.x - a.x
    const dz = b.z - a.z
    const lengthSquared = dx * dx + dz * dz
    const t =
      lengthSquared < 1e-12
        ? 0
        : Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared))
    const px = a.x + dx * t
    const pz = a.z + dz * t
    const distance = Math.hypot(x - px, z - pz)
    if (distance < best.distance) best = { x: px, z: pz, distance }
  }
  return best
}
