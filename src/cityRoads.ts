/**
 * Line pattern for a road.
 *
 * Declared here rather than beside the traffic model because the pattern is a property of how a
 * road is *drawn*, and the geometry needs it without needing anything else about traffic.
 */
export type RoadPattern = 'solid' | 'dashed' | 'sparse'

export type Point = { x: number; z: number }
export type DashPattern = { on: number; off: number }
export type RoadSpan = { ax: number; az: number; bx: number; bz: number }

/**
 * Dash lengths in world units per confidence pattern. A confirmed reference is one unbroken ribbon;
 * a weaker reference is broken up, and the shorter the dash the weaker the claim. Dash lengths are
 * fixed distances, not fractions of a leg, so a long road and a short road read the same way.
 */
export const DASH_PATTERNS: Readonly<Record<RoadPattern, DashPattern | null>> = {
  solid: null,
  dashed: { on: 11, off: 6 },
  sparse: { on: 4, off: 9 },
}

/** Ceiling on dashes emitted for one polyline leg, so a degenerate pattern cannot spin forever. */
export const MAX_DASHES_PER_SEGMENT = 400

/** Sideways spacing between roads sharing a street. Three lanes each way fit inside an arterial. */
export const LANE_PITCH = 4.2
export const MAX_LANE = 6

/** Lane 0 keeps the street centre line; the rest alternate to either side of it. */
export function laneOffset(lane: number): number {
  if (lane <= 0) return 0
  const step = Math.ceil(lane / 2)
  return (lane % 2 === 1 ? 1 : -1) * step * LANE_PITCH
}

/**
 * The street legs a route runs along, one key per leg, so two routes sharing a leg can be told apart.
 *
 * A leg is named by the unordered pair of intersections it joins. The lattice could map a point back
 * to the grid line it belonged to, but an organic street bows away from any such line, so two routes
 * sharing one bent leg used to quantise to a different key at every step, both claim lane 0, and draw
 * straight through each other. The intersection pair is the same whichever way either route drives the
 * leg, so a shared leg always collides in the lane map and the routes are nudged apart.
 */
export function corridorKeys(nodeIds: readonly string[]): string[] {
  const keys: string[] = []
  for (let i = 1; i < nodeIds.length; i += 1) {
    const a = nodeIds[i - 1]
    const b = nodeIds[i]
    keys.push(a < b ? `${a}~${b}` : `${b}~${a}`)
  }
  return keys
}

/**
 * Lowest lane free on every leg this road uses, so roads sharing a street never draw on top of each
 * other. Beyond `MAX_LANE` the road would be off the pavement, so lanes wrap back to the centre.
 */
export function claimLane(taken: Map<string, Set<number>>, corridors: readonly string[]): number {
  let lane = 0
  while (lane <= MAX_LANE && corridors.some(key => taken.get(key)?.has(lane))) lane += 1
  const claimed = lane > MAX_LANE ? 0 : lane
  for (const key of corridors) {
    const lanes = taken.get(key)
    if (lanes) lanes.add(claimed)
    else taken.set(key, new Set([claimed]))
  }
  return claimed
}

/**
 * Shifts a polyline sideways by `offset` world units, mitring the corners so the shifted legs still
 * meet. This is what puts a road in its own lane instead of stacked on the street centre line, where
 * overlapping roads hide each other.
 */
export function offsetPolyline(points: readonly Point[], offset: number): Point[] {
  const line = points.map(point => ({ x: point.x, z: point.z }))
  if (offset === 0 || line.length < 2) return line

  const normals: Point[] = []
  for (let i = 1; i < line.length; i += 1) {
    const dx = line[i].x - line[i - 1].x
    const dz = line[i].z - line[i - 1].z
    const length = Math.hypot(dx, dz)
    normals.push(length < 1e-6 ? { x: 0, z: 0 } : { x: -dz / length, z: dx / length })
  }

  return line.map((point, index) => {
    const before = normals[index - 1]
    const after = normals[index]
    const seed = before && after ? { x: before.x + after.x, z: before.z + after.z } : before ?? after
    if (!seed) return point
    const length = Math.hypot(seed.x, seed.z)
    if (length < 1e-6) return point
    const unit = { x: seed.x / length, z: seed.z / length }
    // Miter length grows as the turn tightens; clamped so a hairpin cannot fling the joint away.
    const reference = before ?? after ?? unit
    const scale = offset / Math.max(0.35, unit.x * reference.x + unit.z * reference.z)
    return { x: point.x + unit.x * scale, z: point.z + unit.z * scale }
  })
}

/**
 * Splits a polyline into the stretches that should actually be drawn. A null pattern draws the whole
 * polyline; otherwise the on/off pattern repeats by distance travelled and the phase carries across
 * corners, so a dashed road reads as one route rather than one gap per leg.
 */
export function dashSpans(points: readonly Point[], dash: DashPattern | null): RoadSpan[] {
  const spans: RoadSpan[] = []
  if (points.length < 2) return spans
  const period = dash === null ? 0 : dash.on + dash.off
  const solid = dash === null || dash.on <= 0 || period <= dash.on

  let travelled = 0
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]
    const b = points[i]
    const dx = b.x - a.x
    const dz = b.z - a.z
    const length = Math.hypot(dx, dz)
    if (length < 1e-6) continue
    if (solid) {
      spans.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z })
      continue
    }

    const ux = dx / length
    const uz = dz / length
    let cursor = 0
    let guard = 0
    while (cursor < length - 1e-6 && guard < MAX_DASHES_PER_SEGMENT) {
      guard += 1
      const phase = (travelled + cursor) % period
      if (phase < dash!.on) {
        const run = Math.min(dash!.on - phase, length - cursor)
        spans.push({
          ax: a.x + ux * cursor,
          az: a.z + uz * cursor,
          bx: a.x + ux * (cursor + run),
          bz: a.z + uz * (cursor + run),
        })
        cursor += run
      } else {
        cursor += Math.min(period - phase, length - cursor)
      }
    }
    travelled += length
  }
  return spans
}
