import {
  DEGENERATE_EPSILON,
  majorDirection,
  minorDirection,
  noiseAt,
  sampleField,
  tensorMagnitude,
  type CityField,
  type Direction,
} from './cityField'

/**
 * Turns the direction field into actual roads.
 *
 * A tensor field says which way the grain runs at every point; it does not say where the streets
 * are. Streets are *streamlines* of that field — curves that follow the grain — and the problem of
 * choosing them is the problem of covering the plane evenly without ever letting two streets of the
 * same family run so close together that the block between them is unusable.
 *
 * The algorithm is Jobard & Lefer's evenly-spaced streamlines ("Creating Evenly-Spaced Streamlines
 * of Steady 2D Vector Fields", 1997), which is what Chen et al. use for street modelling. The shape
 * of it is:
 *
 *   1. Trace a streamline from a seed, integrating in both directions until it has to stop.
 *   2. Drop candidate seeds along it, one separation distance out to either side.
 *   3. Take the next candidate that is still at least a separation distance from everything traced
 *      so far, and go back to 1.
 *
 * Two adaptations matter for streets specifically. The first is that a tensor field has *two*
 * perpendicular eigenvector families, so the whole process runs twice — once for the major
 * eigenvector, once for the minor — and separation is enforced only within a family. That is what
 * lets the cross streets cross: they are allowed to come arbitrarily close to the streets they
 * intersect, and are kept apart only from their own kind.
 *
 * The second is that separation varies across the map rather than being a constant. Real cities have
 * small blocks downtown and large ones at the edge, and holding the separation fixed produces a city
 * of uniform grain that reads as machine-made no matter how organic each individual street is.
 */

export type StreamlineFamily = 'major' | 'minor'

export interface Point {
  readonly x: number
  readonly z: number
}

export interface Streamline {
  readonly id: string
  readonly family: StreamlineFamily
  /** Ordered centre line, already simplified to remove integration steps that added nothing. */
  readonly points: readonly Point[]
  readonly length: number
  /**
   * How far the streamline's midpoint sits from the city centre, as a fraction of the city radius.
   *
   * Carried because road hierarchy is assigned from it later: the long streamlines through the
   * middle of the map become the arterials. It is a position on the map and says nothing whatever
   * about the database.
   */
  readonly centrality: number
}

export interface StreamlineOptions {
  readonly field: CityField
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
  /** Separation between neighbouring streets of one family at the city centre. */
  readonly separation: number
  /** Multiplier applied to that separation at the edge of the built-up area. */
  readonly edgeSeparationScale: number
  /** Streets shorter than this are dropped: a stub that bounds nothing is not a street. */
  readonly minLength: number
  /** Hard ceiling on streamlines per family, so a pathological field still terminates. */
  readonly maxStreamlines: number
  /** Regions the streets must not enter, such as open water. */
  readonly excluded?: (x: number, z: number) => boolean
}

/**
 * Integration step, as a fraction of the local separation.
 *
 * Small enough that a road curves smoothly rather than in visible facets, and small enough that the
 * proximity test cannot step straight over a neighbouring street between samples. The polyline is
 * simplified afterwards, so a fine step costs geometry during generation and nothing at all in the
 * finished plan.
 */
const STEP_FRACTION = 0.22

/**
 * How near a streamline may come to an existing one of its own family before it must stop.
 *
 * Held well below the full separation because this test fires *while tracing*, and a streamline that
 * stopped the instant it broke the separation rule would leave the block it was bounding open at one
 * end. Letting it run in to half the separation means it reliably reaches the street it is
 * approaching, where the graph builder can weld the two together into a junction.
 */
const STOP_FRACTION = 0.5

/**
 * How strongly street spacing varies from place to place, independent of distance from the centre,
 * and over what fraction of the city radius that variation plays out.
 *
 * `0.34` spans roughly a factor of two between the tightest and loosest quarters, which is about the
 * contrast between a Victorian terraced grid and post-war suburbia. Pushing it much further starts
 * to produce blocks too small to hold a building beside blocks too large to reach from the street.
 */
const GRAIN_AMPLITUDE = 0.34
const GRAIN_SCALE = 0.42

/** Ceiling on integration steps for a single direction of a single streamline. */
const MAX_STEPS = 900

/**
 * How far along itself a streamline must have travelled before it is allowed to notice its own tail.
 *
 * The ring roads *are* loops, and a loop that is forbidden from closing leaves a seam. This is the
 * arc length that has to separate two points of one streamline before proximity counts as a genuine
 * self-intersection rather than simply the previous few steps.
 */
const SELF_PROXIMITY_ARC = 6

export function traceStreamlines(options: StreamlineOptions): Streamline[] {
  const { field } = options
  const centreX = field.centreX
  const centreZ = field.centreZ
  const radius = Math.max(field.radius, 1)

  /*
   * Separation grows with distance from the centre, which is where the downtown/suburb contrast on
   * the finished map comes from: tight blocks in the middle, loose ones at the edge. Squaring the
   * normalised radius keeps the core genuinely dense instead of easing outward from the first step.
   *
   * On top of that sits a slow noise term. Radial falloff alone gives every block at a given radius
   * the same size, and a city of one grain per ring still reads as machine-made; the noise is what
   * puts a tight old quarter next to a loose new one at the same distance from the middle.
   */
  const grainSeed = field.noiseSeed ^ 0x5bf03635
  const grainScale = radius * GRAIN_SCALE
  const separationAt = (x: number, z: number): number => {
    const t = Math.min(1, Math.hypot(x - centreX, z - centreZ) / radius)
    const radial = 1 + (options.edgeSeparationScale - 1) * t * t
    const grain = 1 + noiseAt(grainSeed, grainScale, x, z) * GRAIN_AMPLITUDE
    return options.separation * radial * grain
  }
  const maxSeparation = options.separation * options.edgeSeparationScale * (1 + GRAIN_AMPLITUDE)

  const inside = (x: number, z: number): boolean =>
    x >= options.minX && x <= options.maxX && z >= options.minZ && z <= options.maxZ &&
    !(options.excluded?.(x, z) ?? false)

  const streamlines: Streamline[] = []
  for (const family of ['major', 'minor'] as const) {
    const index = new ProximityIndex(maxSeparation)
    const seeds: Point[] = initialSeeds(field, options, family)
    let cursor = 0
    let traced = 0

    /*
     * Propagation alone does not cover a radial field.
     *
     * Jobard & Lefer's seeding assumes neighbouring streamlines stay neighbours, which holds for a
     * roughly parallel field and fails badly for a radial one: spokes *diverge*, so the gap between
     * two of them keeps widening with distance and no seed dropped beside either one ever lands in
     * the middle of it. The first render of this city showed exactly that — a dense core and wedges
     * of blank paper between the spokes at the edge.
     *
     * So propagation is run to exhaustion and then the map is *swept* for gaps: any point further
     * than a separation from every street of its family becomes a new seed, and the whole thing runs
     * again. That converges because each pass strictly reduces the uncovered area, and it is
     * indifferent to whether the field converges, diverges or swirls.
     */
    for (let pass = 0; pass < MAX_FILL_PASSES && traced < options.maxStreamlines; pass += 1) {
      while (cursor < seeds.length && traced < options.maxStreamlines) {
        const seed = seeds[cursor]
        cursor += 1
        if (!inside(seed.x, seed.z)) continue
        if (index.hasWithin(seed.x, seed.z, separationAt(seed.x, seed.z) * SEED_CLEARANCE)) continue

        const points = traceBoth(field, family, seed, separationAt, inside, index)
        const length = polylineLength(points)
        if (points.length < 2 || length < options.minLength) continue

        const simplified = simplify(points, options.separation * 0.045)
        for (const point of densify(simplified, options.separation * 0.5)) index.add(point.x, point.z)
        traced += 1

        const midpoint = simplified[Math.floor(simplified.length / 2)]
        streamlines.push({
          id: `${family[0]}${streamlines.length}`,
          family,
          points: simplified,
          length,
          centrality: Math.min(1, Math.hypot(midpoint.x - centreX, midpoint.z - centreZ) / radius),
        })

        for (const candidate of seedsAlong(simplified, separationAt)) seeds.push(candidate)
      }

      const filled = gapSeeds(options, index, separationAt, inside)
      if (filled.length === 0) break
      for (const seed of filled) seeds.push(seed)
    }
  }
  return streamlines
}

/**
 * How much of the local separation a seed must clear before it is allowed to start a street.
 *
 * Slightly under one, because a candidate dropped exactly one separation from its parent sits on the
 * boundary of the rule and floating-point noise decides the outcome. Relaxing the test lets those
 * seeds through, and the tracer's own proximity check still stops the resulting street from crowding
 * its neighbour.
 */
const SEED_CLEARANCE = 0.92

/** Passes of sweep-and-refill. Two or three normally suffice; the cap is only a backstop. */
const MAX_FILL_PASSES = 6

/**
 * Points of the map that no street of this family has come near, in a fixed scan order.
 *
 * The scan is jittered by a hash of the cell rather than sampled on exact centres, so the streets
 * that grow from it do not inherit the scan's own regularity — an unjittered sweep leaves a faint
 * rectangular signature in the outskirts, which is precisely the artefact this whole module exists
 * to avoid.
 */
function gapSeeds(
  options: StreamlineOptions,
  index: ProximityIndex,
  separationAt: (x: number, z: number) => number,
  inside: (x: number, z: number) => boolean,
): Point[] {
  const step = options.separation * 0.75
  const seeds: Point[] = []
  let cell = 0
  for (let z = options.minZ; z <= options.maxZ; z += step) {
    for (let x = options.minX; x <= options.maxX; x += step) {
      cell += 1
      const jitterX = (hashUnit(cell * 2 + 1) - 0.5) * step
      const jitterZ = (hashUnit(cell * 2) - 0.5) * step
      const px = x + jitterX
      const pz = z + jitterZ
      if (!inside(px, pz)) continue
      if (index.hasWithin(px, pz, separationAt(px, pz) * SEED_CLEARANCE)) continue
      seeds.push({ x: px, z: pz })
    }
  }
  return seeds
}

function hashUnit(value: number): number {
  let hash = Math.imul(value ^ 0x9e3779b9, 0x85ebca6b) >>> 0
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35) >>> 0
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296
}

/**
 * Resamples a polyline so no two consecutive points are further apart than `spacing`.
 *
 * The proximity index stores points, not segments, so a simplified street with a long straight run
 * would be invisible to a proximity query taken in the middle of that run — another street would
 * happily be traced right along it. Densifying before indexing closes that hole without putting the
 * discarded vertices back into the drawn geometry.
 */
function densify(points: readonly Point[], spacing: number): Point[] {
  const out: Point[] = []
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]
    const to = points[index]
    const length = Math.hypot(to.x - from.x, to.z - from.z)
    const steps = Math.max(1, Math.ceil(length / spacing))
    for (let step = 0; step < steps; step += 1) {
      const t = step / steps
      out.push({ x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t })
    }
  }
  const last = points[points.length - 1]
  if (last) out.push({ x: last.x, z: last.z })
  return out
}

/**
 * Where the very first streamline of each family starts.
 *
 * Propagation fills the map outward from whatever it is given, so the first seeds decide what the
 * middle of the city looks like. Ringing them close around the centre puts the densest, most
 * strongly radial part of the field first, which is what makes the core read as a core.
 */
function initialSeeds(
  field: CityField,
  options: StreamlineOptions,
  family: StreamlineFamily,
): Point[] {
  const seeds: Point[] = []
  const rings = 4
  for (let ring = 0; ring < rings; ring += 1) {
    const distance = field.radius * (0.08 + (ring / rings) * 0.55)
    const count = 3 + ring * 2
    for (let step = 0; step < count; step += 1) {
      // Offset per ring so successive rings do not line their seeds up along the same bearings.
      const angle = (step / count) * Math.PI * 2 + ring * 0.7 + (family === 'minor' ? 0.35 : 0)
      seeds.push({
        x: field.centreX + Math.cos(angle) * distance,
        z: field.centreZ + Math.sin(angle) * distance,
      })
    }
  }
  /*
   * A ring of seeds outside the built-up area as well. Without them the outskirts are reached only
   * by propagation from the core, and whichever direction propagation happens to run out of budget
   * in ends up conspicuously bare.
   */
  const outer = 14
  for (let step = 0; step < outer; step += 1) {
    const angle = (step / outer) * Math.PI * 2 + (family === 'minor' ? 0.22 : 0)
    seeds.push({
      x: field.centreX + Math.cos(angle) * field.radius * 0.9,
      z: field.centreZ + Math.sin(angle) * field.radius * 0.9,
    })
  }
  return seeds.filter(seed =>
    seed.x >= options.minX && seed.x <= options.maxX &&
    seed.z >= options.minZ && seed.z <= options.maxZ)
}

/** Traces forward from the seed, then backward, and joins the two halves into one street. */
function traceBoth(
  field: CityField,
  family: StreamlineFamily,
  seed: Point,
  separationAt: (x: number, z: number) => number,
  inside: (x: number, z: number) => boolean,
  index: ProximityIndex,
): Point[] {
  const forward = traceOneWay(field, family, seed, 1, separationAt, inside, index)
  // A street that came back to where it started is a complete ring; tracing the other way from the
  // seed would only retrace the same loop backwards.
  if (forward.closed) return forward.points
  const backward = traceOneWay(field, family, seed, -1, separationAt, inside, index)
  const points: Point[] = []
  for (let i = backward.points.length - 1; i >= 1; i -= 1) points.push(backward.points[i])
  for (const point of forward.points) points.push(point)
  return points
}

/**
 * Arc a street must cover before it is allowed to close on its own start, in separations.
 *
 * Without a floor a street that merely doubles back over a block would be closed into a tiny loop.
 * Eight separations is several blocks of travel — far enough that returning to the start really does
 * mean the street went round something.
 */
const RING_MIN_ARC = 8

/**
 * How near the start a street must come to be closed into a ring, in separations.
 *
 * Wider than the stopping distance used against other streets, and deliberately so. A ring traced
 * through a field with any noise in it does not come back to its exact start; it comes back one
 * street's width off, and keeps going, and the next lap is another width in, and the result is a
 * spiral. A spiral does not break any separation rule — each arm is a legal distance from the last —
 * so nothing else in the tracer objects to it, and it is one continuous street where a city would
 * have a ring and the roads that cross it. Closing anything that gets within a street or so of its
 * own start is what turns that spiral back into the ring it was trying to be.
 */
const RING_CLOSE_FRACTION = 1.4

function traceOneWay(
  field: CityField,
  family: StreamlineFamily,
  seed: Point,
  sign: number,
  separationAt: (x: number, z: number) => number,
  inside: (x: number, z: number) => boolean,
  index: ProximityIndex,
): { points: Point[]; closed: boolean } {
  const points: Point[] = [{ x: seed.x, z: seed.z }]
  let reference = directionAt(field, family, seed.x, seed.z, null)
  if (reference === null) return { points, closed: false }
  reference = { x: reference.x * sign, z: reference.z * sign }
  let arc = 0

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const current = points[points.length - 1]
    const separation = separationAt(current.x, current.z)
    const stride = separation * STEP_FRACTION
    const next = integrate(field, family, current, reference, stride)
    if (next === null) break
    if (!inside(next.point.x, next.point.z)) break

    arc += Math.hypot(next.point.x - current.x, next.point.z - current.z)
    if (arc > separation * RING_MIN_ARC) {
      const back = Math.hypot(next.point.x - seed.x, next.point.z - seed.z)
      if (back < separation * RING_CLOSE_FRACTION) {
        points.push(next.point)
        points.push({ x: seed.x, z: seed.z })
        return { points, closed: true }
      }
    }

    /*
     * Stopping *at* an existing street of the same family rather than short of it. The point is
     * still appended, so the streamline reaches into its neighbour's separation zone and the graph
     * builder finds a real crossing to weld instead of two ends a few units apart.
     */
    if (index.hasWithin(next.point.x, next.point.z, separation * STOP_FRACTION)) {
      points.push(next.point)
      break
    }
    if (touchesOwnTail(points, next.point, separation * STOP_FRACTION)) {
      points.push(next.point)
      break
    }

    points.push(next.point)
    reference = next.direction
  }
  return { points, closed: false }
}

/**
 * One fourth-order Runge-Kutta step.
 *
 * RK4 rather than Euler because a ring road is a long integration through a curving field, and
 * Euler's error accumulates until the ring visibly fails to close. The `reference` direction is
 * threaded through every one of the four evaluations for a reason specific to tensor fields:
 * an eigenvector has no inherent sign, so each sample must be flipped into agreement with the
 * direction of travel. Skip that and the road reverses at the first sample whose sign happens to
 * come back the other way.
 */
function integrate(
  field: CityField,
  family: StreamlineFamily,
  from: Point,
  reference: Direction,
  stride: number,
): { point: Point; direction: Direction } | null {
  const k1 = directionAt(field, family, from.x, from.z, reference)
  if (k1 === null) return null
  const k2 = directionAt(field, family, from.x + k1.x * stride * 0.5, from.z + k1.z * stride * 0.5, k1)
  if (k2 === null) return null
  const k3 = directionAt(field, family, from.x + k2.x * stride * 0.5, from.z + k2.z * stride * 0.5, k2)
  if (k3 === null) return null
  const k4 = directionAt(field, family, from.x + k3.x * stride, from.z + k3.z * stride, k3)
  if (k4 === null) return null

  const dx = (k1.x + 2 * k2.x + 2 * k3.x + k4.x) / 6
  const dz = (k1.z + 2 * k2.z + 2 * k3.z + k4.z) / 6
  const magnitude = Math.hypot(dx, dz)
  // The four samples cancelling means the field folds over inside this step; stopping is correct.
  if (magnitude < 0.3) return null

  const direction = { x: dx / magnitude, z: dz / magnitude }
  return {
    point: { x: from.x + direction.x * stride, z: from.z + direction.z * stride },
    direction,
  }
}

/** Unit eigenvector of the requested family, flipped into agreement with `reference`. */
export function directionAt(
  field: CityField,
  family: StreamlineFamily,
  x: number,
  z: number,
  reference: Direction | null,
): Direction | null {
  const tensor = sampleField(field, x, z)
  if (tensorMagnitude(tensor) < DEGENERATE_EPSILON) return null
  const direction = family === 'major' ? majorDirection(tensor) : minorDirection(tensor)
  if (reference === null) return direction
  const alignment = direction.x * reference.x + direction.z * reference.z
  return alignment < 0 ? { x: -direction.x, z: -direction.z } : direction
}

function touchesOwnTail(points: readonly Point[], candidate: Point, radius: number): boolean {
  const limit = points.length - SELF_PROXIMITY_ARC
  const radiusSquared = radius * radius
  for (let index = 0; index < limit; index += 1) {
    const point = points[index]
    if ((point.x - candidate.x) ** 2 + (point.z - candidate.z) ** 2 < radiusSquared) return true
  }
  return false
}

/** Candidate seeds one separation to either side of an accepted streamline. */
function seedsAlong(
  points: readonly Point[],
  separationAt: (x: number, z: number) => number,
): Point[] {
  const seeds: Point[] = []
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]
    const to = points[index]
    const dx = to.x - from.x
    const dz = to.z - from.z
    const length = Math.hypot(dx, dz)
    if (length < DEGENERATE_EPSILON) continue
    const nx = -dz / length
    const nz = dx / length
    for (const side of [1, -1]) {
      /*
       * The offset is measured with the separation *at the seed*, not at its parent. Separation
       * grows outward from the centre, so a seed dropped using the parent's value lands short of
       * where it needs to be, is rejected by its own local rule, and the gap it was meant to fill
       * stays empty. One correction step is enough at these gradients.
       */
      const first = separationAt(to.x + nx * side * separationAt(to.x, to.z), to.z + nz * side * separationAt(to.x, to.z))
      seeds.push({ x: to.x + nx * side * first, z: to.z + nz * side * first })
    }
  }
  return seeds
}

export function polylineLength(points: readonly Point[]): number {
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z)
  }
  return total
}

/**
 * Ramer-Douglas-Peucker simplification.
 *
 * Integration emits a point every fraction of a separation, which is far more detail than a drawn
 * road needs and far more than the graph builder wants to intersect. Dropping the points that lie
 * within `tolerance` of the line they sit on keeps the visible curve identical while cutting the
 * vertex count by roughly an order of magnitude.
 */
export function simplify(points: readonly Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points.map(point => ({ x: point.x, z: point.z }))
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1

  const stack: Array<[number, number]> = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [start, end] = stack.pop()!
    if (end <= start + 1) continue
    let worst = -1
    let worstDistance = tolerance
    for (let index = start + 1; index < end; index += 1) {
      const distance = distanceToSegment(points[index], points[start], points[end])
      if (distance > worstDistance) {
        worstDistance = distance
        worst = index
      }
    }
    if (worst < 0) continue
    keep[worst] = 1
    stack.push([start, worst], [worst, end])
  }

  const result: Point[] = []
  for (let index = 0; index < points.length; index += 1) {
    if (keep[index]) result.push({ x: points[index].x, z: points[index].z })
  }
  return result
}

function distanceToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x
  const dz = to.z - from.z
  const lengthSquared = dx * dx + dz * dz
  if (lengthSquared < DEGENERATE_EPSILON) return Math.hypot(point.x - from.x, point.z - from.z)
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.z - from.z) * dz) / lengthSquared))
  return Math.hypot(point.x - (from.x + dx * t), point.z - (from.z + dz * t))
}

/**
 * Uniform-grid spatial hash over the points of already-accepted streamlines.
 *
 * Proximity is asked on every integration step of every streamline, so a linear scan would make
 * tracing quadratic in the size of the city. Bucketing at the widest separation in use means a query
 * only ever touches the nine buckets around the point, whatever the local density.
 */
export class ProximityIndex {
  private readonly buckets = new Map<number, number[]>()
  private readonly coords: number[] = []

  constructor(private readonly cellSize: number) {}

  add(x: number, z: number): void {
    const handle = this.coords.length / 2
    this.coords.push(x, z)
    const key = this.key(x, z)
    const bucket = this.buckets.get(key)
    if (bucket) bucket.push(handle)
    else this.buckets.set(key, [handle])
  }

  hasWithin(x: number, z: number, radius: number): boolean {
    const radiusSquared = radius * radius
    // A radius wider than one bucket has to sweep every bucket it can reach, not just the ring of 9.
    const span = Math.max(1, Math.ceil(radius / this.cellSize))
    const cx = Math.floor(x / this.cellSize)
    const cz = Math.floor(z / this.cellSize)
    for (let dz = -span; dz <= span; dz += 1) {
      for (let dx = -span; dx <= span; dx += 1) {
        const bucket = this.buckets.get(hashCell(cx + dx, cz + dz))
        if (!bucket) continue
        for (const handle of bucket) {
          const px = this.coords[handle * 2]
          const pz = this.coords[handle * 2 + 1]
          if ((px - x) ** 2 + (pz - z) ** 2 < radiusSquared) return true
        }
      }
    }
    return false
  }

  private key(x: number, z: number): number {
    return hashCell(Math.floor(x / this.cellSize), Math.floor(z / this.cellSize))
  }
}

function hashCell(cx: number, cz: number): number {
  // Cantor-style pairing over the shifted quadrant; collisions only cost an extra distance test.
  return (cx + 32768) * 65536 + (cz + 32768)
}
