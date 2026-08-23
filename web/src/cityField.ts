import { mulberry32 } from './citySeed'
import { stableHash } from './atlasLayout'

/**
 * The direction field the streets of a city grow along.
 *
 * Every previous attempt at this map started from a lattice and then tried to disguise it — bowing
 * the roads between junctions, jittering the junctions themselves, cutting diagonals across the
 * result. All of them failed the same way, because a lattice that has been disturbed is still a
 * lattice: the eye reconstructs the underlying rows and columns from the parts that survived, and
 * reads the disturbance as noise applied to graph paper rather than as a city.
 *
 * So there is no lattice here at all. Streets are traced as *streamlines* of a tensor field, which
 * is the standard approach for this problem (Chen, Esch, Wonka, Müller & Zhang, "Interactive
 * Procedural Street Modeling", SIGGRAPH 2008). It is worth being precise about why a tensor rather
 * than an ordinary vector field, because that choice is doing all the work:
 *
 * - A **vector** field has one direction per point, so it grows one family of roads. Cross streets
 *   would have to come from somewhere else and would meet the first family at arbitrary angles.
 * - A **tensor** field has two *perpendicular* eigenvector directions per point. Trace the major
 *   eigenvector and you get one family of streets; trace the minor and you get the cross streets —
 *   and because the two eigenvectors of a symmetric tensor are orthogonal *by construction*, those
 *   families meet at right angles everywhere, while both curve freely.
 *
 * That combination is the whole trick, and it is exactly what a real street network looks like from
 * above: corners are square, but no two streets anywhere are parallel for long. A grid gets square
 * corners by being rigid. A city gets them locally while curving globally, and only a field can do
 * both at once.
 *
 * The other reason to use tensors is the radial element below. A single radial basis field produces
 * concentric rings on one eigenvector and spokes converging on the centre on the other — which is,
 * structurally, London or Tokyo. Ring roads and radial arterials are not special-cased anywhere in
 * this codebase; they fall out of the field.
 *
 * Everything here is decoration. The field is seeded from the database id and nothing measured is
 * ever consulted, so the shape of a city is a pure function of its identity — but it is not, and
 * must never be read as, a statement about the database.
 */

/**
 * A symmetric traceless 2x2 tensor, stored by its two free components.
 *
 * The full matrix is `[[a, b], [b, -a]]`. Writing `a = R·cos 2θ` and `b = R·sin 2θ` makes the
 * geometry explicit: `R` is the strength and `θ` is the major eigenvector's angle. The doubled angle
 * is not a trick, it is the mathematics of a *direction* as opposed to a vector — a street running
 * north-south is identical to one running south-north, so the representation has to be invariant
 * under a half turn, and `2θ` is what makes it so.
 *
 * Storing tensors instead of angles is also what makes blending work. Averaging two angles is
 * ill-defined (what is the mean of 5° and 175°?) while adding two tensors is ordinary addition, and
 * it does the right thing: near-perpendicular fields cancel toward a degenerate point rather than
 * landing on some meaningless intermediate direction.
 */
export interface Tensor {
  readonly a: number
  readonly b: number
}

export const ZERO_TENSOR: Tensor = { a: 0, b: 0 }

/** Tensor whose major eigenvector points along `theta`, with strength `magnitude`. */
export function gridTensor(theta: number, magnitude = 1): Tensor {
  return { a: magnitude * Math.cos(2 * theta), b: magnitude * Math.sin(2 * theta) }
}

/**
 * Tensor of the radial basis field about a centre, evaluated at `(x, z)`.
 *
 * With `d = p - centre`, the matrix is `[[d.z² - d.x², -2·d.x·d.z], [-2·d.x·d.z, d.x² - d.z²]]`.
 * Its major eigenvector runs *tangentially* — so tracing the major family draws the ring roads, and
 * tracing the minor family draws the spokes that converge on the centre.
 *
 * The magnitude grows as the square of the distance, which is why callers pair this with an
 * exponential decay: undamped, a radial element would dominate the far corners of the map, and the
 * rings would swallow the whole city instead of organising its middle.
 */
export function radialTensor(x: number, z: number, centreX: number, centreZ: number): Tensor {
  const dx = x - centreX
  const dz = z - centreZ
  return { a: dz * dz - dx * dx, b: -2 * dx * dz }
}

export function addTensor(left: Tensor, right: Tensor): Tensor {
  return { a: left.a + right.a, b: left.b + right.b }
}

export function scaleTensor(tensor: Tensor, scale: number): Tensor {
  return { a: tensor.a * scale, b: tensor.b * scale }
}

/** Strength `R`. Near zero the direction is undefined and the point is degenerate. */
export function tensorMagnitude(tensor: Tensor): number {
  return Math.hypot(tensor.a, tensor.b)
}

/** Angle of the major eigenvector. Undefined — and returned as 0 — at a degenerate point. */
export function majorAngle(tensor: Tensor): number {
  if (tensorMagnitude(tensor) < DEGENERATE_EPSILON) return 0
  return Math.atan2(tensor.b, tensor.a) / 2
}

export interface Direction {
  readonly x: number
  readonly z: number
}

/** Unit vector along the major eigenvector; the ring-road family of the radial element. */
export function majorDirection(tensor: Tensor): Direction {
  const angle = majorAngle(tensor)
  return { x: Math.cos(angle), z: Math.sin(angle) }
}

/** Unit vector along the minor eigenvector, always exactly perpendicular to the major one. */
export function minorDirection(tensor: Tensor): Direction {
  const angle = majorAngle(tensor) + Math.PI / 2
  return { x: Math.cos(angle), z: Math.sin(angle) }
}

/**
 * Below this strength a tensor has no meaningful direction.
 *
 * These points are the field's *degenerate points*, and they are features rather than faults: they
 * are where the street grain reorganises itself, and they read on the finished map as the irregular
 * junctions and odd-angled forks that a surveyed grid never produces. Tracing has to stop at them,
 * because past a degenerate point the eigenvector can flip and the road would double back on itself.
 */
export const DEGENERATE_EPSILON = 1e-6

export type FieldElementKind = 'radial' | 'grid'

/**
 * One contribution to the field.
 *
 * `decay` is in units of inverse squared distance, applied as `exp(-decay · |p - centre|²)`, so a
 * larger value makes an element more local. `weight` scales it against its neighbours after its own
 * magnitude has been normalised, which matters because a radial element's raw magnitude grows with
 * distance while a grid element's is constant.
 */
export interface FieldElement {
  readonly kind: FieldElementKind
  readonly x: number
  readonly z: number
  /** Major eigenvector angle, for `grid` elements only. */
  readonly theta: number
  readonly weight: number
  readonly decay: number
}

/**
 * A watercourse or coastline the streets should run alongside rather than across.
 *
 * Real embankment roads hug the water because the water was there first, and a street plan that
 * ignores its river is one of the loudest tells that a map was generated rather than surveyed. This
 * element aligns the local grain with the nearest stretch of the polyline, falling off quickly with
 * distance so it shapes the banks and nothing further inland.
 */
export interface BoundaryElement {
  readonly path: ReadonlyArray<{ x: number; z: number }>
  readonly weight: number
  readonly decay: number
}

export interface CityField {
  readonly elements: readonly FieldElement[]
  readonly boundaries: readonly BoundaryElement[]
  /** Amplitude, in radians, of the smooth warp applied to the blended direction. */
  readonly noiseAmplitude: number
  /** World-space wavelength of that warp. */
  readonly noiseScale: number
  readonly noiseSeed: number
  readonly centreX: number
  readonly centreZ: number
  readonly radius: number
}

/**
 * Samples the blended field.
 *
 * Contributions are summed as tensors — never as angles — and each is normalised to unit strength
 * before weighting so that a radial element far from its centre does not drown out everything else
 * purely because its raw magnitude scales with distance squared.
 */
export function sampleField(field: CityField, x: number, z: number): Tensor {
  let a = 0
  let b = 0

  for (const element of nearbyElements(field, x, z)) {
    const dx = x - element.x
    const dz = z - element.z
    const distanceSquared = dx * dx + dz * dz
    const falloff = Math.exp(-element.decay * distanceSquared)
    if (falloff < FALLOFF_EPSILON) continue

    const raw = element.kind === 'radial'
      ? radialTensor(x, z, element.x, element.z)
      : gridTensor(element.theta, 1)
    const magnitude = tensorMagnitude(raw)
    if (magnitude < DEGENERATE_EPSILON) continue

    const scale = (element.weight * falloff) / magnitude
    a += raw.a * scale
    b += raw.b * scale
  }

  for (const boundary of field.boundaries) {
    const near = nearestOnPolyline(boundary.path, x, z)
    if (near === null) continue
    const falloff = Math.exp(-boundary.decay * near.distanceSquared)
    if (falloff < FALLOFF_EPSILON) continue
    const raw = gridTensor(near.angle, 1)
    const scale = boundary.weight * falloff
    a += raw.a * scale
    b += raw.b * scale
  }

  const blended = { a, b }
  if (field.noiseAmplitude === 0) return blended

  /*
   * The warp is applied to the *blended* direction rather than added as another element.
   *
   * Adding a noise tensor would fight the structure — it would weaken the field wherever it
   * disagreed, scattering spurious degenerate points through the middle of otherwise coherent
   * districts. Rotating the result instead preserves strength everywhere and bends the grain, which
   * is the thing that stops long straight runs from surviving without dissolving the plan.
   */
  const magnitude = tensorMagnitude(blended)
  if (magnitude < DEGENERATE_EPSILON) return blended
  const turn = smoothNoise(field, x, z) * field.noiseAmplitude
  return gridTensor(majorAngle(blended) + turn, magnitude)
}

const FALLOFF_EPSILON = 1e-4

/*
 * Every element's influence dies smoothly but is *cut off* hard at FALLOFF_EPSILON, so it reaches a
 * finite distance: exp(-decay·d²) < ε when d² > ln(1/ε)/decay. That radius is what makes an index
 * possible at all — without the cutoff, every element would touch every sample.
 */
const FALLOFF_REACH_SQUARED = Math.log(1 / FALLOFF_EPSILON)

/*
 * Sampling is the innermost loop of the whole generator: the tracer asks for a direction at every
 * step of every street, hundreds of thousands of times, and a large city carries a couple of hundred
 * district elements. Scanning them all per sample makes tracing cost districts × steps, which grows
 * with the *square* of the city — the exact shape of cost that made a 6000-table instance stutter.
 *
 * So each element is stamped into every cell of a uniform grid its reach touches, and a sample reads
 * back one cell. The stamping is in element order, so a cell's list is a subsequence of the full
 * element list; because a skipped element contributes exactly zero, the surviving terms are summed in
 * the same order as before and the result is bit-for-bit what the full scan produced.
 *
 * The index is cached beside the field rather than stored in it, so CityField stays a plain readonly
 * value that tests can write by hand.
 */
interface ElementIndex {
  readonly cellX: number
  readonly cellZ: number
  readonly minX: number
  readonly minZ: number
  readonly columns: number
  readonly rows: number
  readonly buckets: ReadonlyArray<readonly FieldElement[]>
}

const ELEMENT_INDEX = new WeakMap<CityField, ElementIndex | null>()

function nearbyElements(field: CityField, x: number, z: number): readonly FieldElement[] {
  let index = ELEMENT_INDEX.get(field)
  if (index === undefined) {
    index = buildElementIndex(field)
    ELEMENT_INDEX.set(field, index)
  }
  if (index === null) return field.elements

  const column = Math.floor((x - index.minX) / index.cellX)
  const row = Math.floor((z - index.minZ) / index.cellZ)
  if (column < 0 || row < 0 || column >= index.columns || row >= index.rows) return EMPTY_ELEMENTS
  return index.buckets[row * index.columns + column]
}

const EMPTY_ELEMENTS: readonly FieldElement[] = []

function buildElementIndex(field: CityField): ElementIndex | null {
  // Below this an index costs more than it saves, and the grid would mostly be empty cells.
  if (field.elements.length < 24) return null

  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  let reachTotal = 0
  const reaches = new Float64Array(field.elements.length)
  for (let i = 0; i < field.elements.length; i += 1) {
    const element = field.elements[i]
    if (!(element.decay > 0)) return null // An element with no falloff reaches everywhere.
    const reach = Math.sqrt(FALLOFF_REACH_SQUARED / element.decay)
    reaches[i] = reach
    reachTotal += reach
    minX = Math.min(minX, element.x - reach)
    maxX = Math.max(maxX, element.x + reach)
    minZ = Math.min(minZ, element.z - reach)
    maxZ = Math.max(maxZ, element.z + reach)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minZ)) return null

  /*
   * Cell size tracks the mean reach. Smaller cells filter harder but multiply the stamping, and an
   * element covers (2·reach/cell)² of them — at one mean reach per cell the typical element lands in
   * about nine, which is the point where the two costs balance.
   */
  const cell = Math.max(reachTotal / field.elements.length, 1e-6)
  const columns = Math.max(1, Math.min(512, Math.ceil((maxX - minX) / cell)))
  const rows = Math.max(1, Math.min(512, Math.ceil((maxZ - minZ) / cell)))
  const spanX = Math.max((maxX - minX) / columns, 1e-6)
  const spanZ = Math.max((maxZ - minZ) / rows, 1e-6)

  const buckets: FieldElement[][] = Array.from({ length: columns * rows }, () => [])
  for (let i = 0; i < field.elements.length; i += 1) {
    const element = field.elements[i]
    const reach = reaches[i]
    const fromColumn = Math.max(0, Math.floor((element.x - reach - minX) / spanX))
    const toColumn = Math.min(columns - 1, Math.floor((element.x + reach - minX) / spanX))
    const fromRow = Math.max(0, Math.floor((element.z - reach - minZ) / spanZ))
    const toRow = Math.min(rows - 1, Math.floor((element.z + reach - minZ) / spanZ))
    for (let row = fromRow; row <= toRow; row += 1) {
      for (let column = fromColumn; column <= toColumn; column += 1) {
        buckets[row * columns + column].push(element)
      }
    }
  }

  return { cellX: spanX, cellZ: spanZ, minX, minZ, columns, rows, buckets }
}

/** Perpendicular distance from a point to a polyline, plus the direction of the nearest stretch. */
export function nearestOnPolyline(
  path: ReadonlyArray<{ x: number; z: number }>,
  x: number,
  z: number,
): { distanceSquared: number; angle: number } | null {
  if (path.length < 2) return null
  let best = Number.POSITIVE_INFINITY
  let angle = 0
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1]
    const to = path[index]
    const dx = to.x - from.x
    const dz = to.z - from.z
    const lengthSquared = dx * dx + dz * dz
    if (lengthSquared < DEGENERATE_EPSILON) continue
    const t = clamp01(((x - from.x) * dx + (z - from.z) * dz) / lengthSquared)
    const px = from.x + dx * t
    const pz = from.z + dz * t
    const distanceSquared = (x - px) ** 2 + (z - pz) ** 2
    if (distanceSquared < best) {
      best = distanceSquared
      angle = Math.atan2(dz, dx)
    }
  }
  return best === Number.POSITIVE_INFINITY ? null : { distanceSquared: best, angle }
}

/**
 * Smooth deterministic value noise in `[-1, 1]`.
 *
 * Bilinear interpolation of hashed lattice corners with a smoothstep fade, summed over two octaves.
 * It has to be smooth rather than merely random: a streamline integrates through this field, so a
 * discontinuity in the noise would put a kink in a road.
 */
export function smoothNoise(field: CityField, x: number, z: number): number {
  return noiseAt(field.noiseSeed, field.noiseScale, x, z)
}

/**
 * Two-octave smooth value noise in `[-1, 1]`, addressable without a field.
 *
 * Exposed separately because street *spacing* wants noise too, from an independent seed: a city
 * whose blocks are all the same size reads as machine-made however organic the individual streets
 * are, and varying the spacing is the cheapest way to give it a mixture of tight old quarters and
 * loose new ones.
 */
export function noiseAt(seed: number, scale: number, x: number, z: number): number {
  const span = scale <= 0 ? 1 : scale
  return (
    valueNoise(seed, x / span, z / span) * 0.68 +
    valueNoise(seed ^ 0x9e3779b9, (x / span) * 2.7, (z / span) * 2.7) * 0.32
  )
}

function valueNoise(seed: number, x: number, z: number): number {
  const x0 = Math.floor(x)
  const z0 = Math.floor(z)
  const fx = fade(x - x0)
  const fz = fade(z - z0)
  const c00 = latticeValue(seed, x0, z0)
  const c10 = latticeValue(seed, x0 + 1, z0)
  const c01 = latticeValue(seed, x0, z0 + 1)
  const c11 = latticeValue(seed, x0 + 1, z0 + 1)
  return lerp(lerp(c00, c10, fx), lerp(c01, c11, fx), fz)
}

function latticeValue(seed: number, x: number, z: number): number {
  let hash = (seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1)) >>> 0
  hash = Math.imul(hash ^ (hash >>> 15), hash | 1) >>> 0
  hash ^= hash + Math.imul(hash ^ (hash >>> 7), hash | 61)
  return ((hash ^ (hash >>> 14)) >>> 0) / 2147483648 - 1
}

function fade(t: number): number {
  return t * t * (3 - 2 * t)
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

export interface CityFieldOptions {
  readonly seed: string
  readonly centreX: number
  readonly centreZ: number
  /** Radius of the built-up area, which sets both element spread and the noise wavelength. */
  readonly radius: number
  /** The watercourse, if this city has one. */
  readonly river?: ReadonlyArray<{ x: number; z: number }>
}

/**
 * How many district-scale elements the field carries, per unit of city area.
 *
 * This constant is the single most important one in the file, and the reason is worth writing down
 * because the first attempt got it badly wrong.
 *
 * A field built from one dominant radial centre produces a *bullseye*: a dozen perfectly concentric
 * rings crossed by spokes converging on a point. It is organic in the sense of having no straight
 * lines, and completely wrong in every other sense, because real cities do not have twelve ring
 * roads. London has three or four; everything else inside them is local street grain that owes
 * nothing to the centre.
 *
 * What produces that local grain in a real city is history: each district was laid out at a
 * different time, by different people, to different intentions, so each has its *own* orientation,
 * and the seams between them are where the odd junctions are. A field with many overlapping
 * district-scale elements reproduces exactly that — a patchwork of local grains — and, as the
 * comment in `planField` explains, that patchwork is left to organise the largest scale on its own,
 * because every attempt to impose a centre on top of it drew a bullseye. Scaling the count with area
 * keeps the *size* of a district roughly constant, so a big city gets more districts rather than
 * larger ones.
 */
const DISTRICTS_PER_UNIT_AREA = 26 / (Math.PI * 1000 * 1000)
const DISTRICTS_MIN = 7
/**
 * A ceiling only against absurdity, not a working limit.
 *
 * It has to stay well clear of what a real city asks for, because clamping the count is the one way
 * to defeat the whole scheme: the point of scaling with area is to hold a district's *size* constant,
 * so a clamp that bites makes every district larger, and a district large enough is a city-wide
 * element again — which is precisely the bullseye the design goes to such lengths to avoid. A
 * six-thousand-table city wants about 126 districts, and a clamp of 40 gave it a nautilus wound
 * through the middle of the map.
 */
const DISTRICTS_MAX = 260

/**
 * Weight of the one planned quarter.
 *
 * Almost every real city has a patch that *was* surveyed — a Manhattan, an Eixample, a New Town —
 * and its regularity is what makes the surrounding tangle read as organic rather than as an
 * accident. Keeping exactly one strong grid element is a deliberate contrast: the grid becomes a
 * district you can point at, instead of the substrate the whole city was built on.
 */
const PLANNED_QUARTER_WEIGHT = 1.5

export function planField(options: CityFieldOptions): CityField {
  const rng = mulberry32(stableHash(`${options.seed}::field`))
  const { centreX, centreZ, radius } = options
  const elements: FieldElement[] = []

  /*
   * There is deliberately no city-wide element here, and that is the hardest-won line in the module.
   *
   * The obvious way to give a city a centre is one strong radial element in the middle. It produces
   * a bullseye: a dozen perfectly concentric rings crossed by spokes. Peaking that element on a
   * circle instead of a point — an orbital where the walls used to be — fixes the whirlpool at the
   * very centre and still leaves four or five concentric rings sitting on the ring line, because a
   * field cannot say "exactly one ring road". A field gives a direction everywhere and the tracer
   * fills space with streets parallel to it, so asking for a ring always yields a family of rings.
   * Even at a third of a district's weight the nest of arcs is the first thing the eye finds.
   *
   * So the large scale is left to emerge instead. Overlapping district grains already bend the long
   * streets into arcs that cross several quarters, and the betweenness pass in `cityRouting` then
   * finds which of them the network actually depends on and promotes those to arterials. The result
   * has a legible skeleton and a centre without any single element having been told to draw one —
   * which is also how the real thing happened.
   */
  const districts = Math.round(
    clamp(Math.PI * radius * radius * DISTRICTS_PER_UNIT_AREA, DISTRICTS_MIN, DISTRICTS_MAX),
  )
  /*
   * How far apart neighbouring districts fall, which is what their *size* has to be measured
   * against. Sizing a district as a fraction of the city radius instead — which is the obvious thing
   * to write, and was here for a while — quietly undoes the whole scheme: the count grows with area
   * but each grain grows with radius, so a big city gets both more districts *and* districts three
   * times the size, and a grain that large is a city-wide element wearing a different name. It drew
   * exactly the nautilus through the middle of the map that having no centre was supposed to
   * prevent. Deriving the size from the spacing keeps the grain constant at every city size, and
   * self-corrects when either clamp on the count bites.
   */
  const spacing = Math.sqrt((Math.PI * radius * radius) / districts)
  for (let index = 0; index < districts; index += 1) {
    /*
     * Distributed by the square root of a uniform draw, which is what makes the *disc* uniform:
     * sampling the radius linearly would pile districts into the middle, where they only blur the
     * main centre instead of giving the outskirts a grain of their own.
     */
    const angle = rng() * Math.PI * 2
    const distance = radius * 1.02 * Math.sqrt(rng())
    /*
     * Mostly grid elements, and the radial ones are held well below their neighbours' weight. A
     * radial element sweeps its whole footprint into concentric arcs, so at full strength it plants
     * a small bullseye — a village green ringed four times over — which is as artificial at district
     * scale as it was at city scale. Kept faint they do what they are for: bend the surrounding
     * streets around a market place that was there before the streets were.
     */
    const radialDistrict = rng() < 0.2
    /*
     * Districts get finer towards the middle. A medieval core is a mosaic of small parcels laid out
     * one at a time, and a post-war estate on the edge is one plan over a large area; matching that
     * gives the core its tangle and the outskirts their long coherent runs, from one line.
     */
    const extent = spacing * (0.26 + 0.47 * (distance / radius) + rng() * 0.31)
    elements.push({
      kind: radialDistrict ? 'radial' : 'grid',
      x: centreX + Math.cos(angle) * distance,
      z: centreZ + Math.sin(angle) * distance,
      theta: rng() * Math.PI,
      weight: (0.55 + rng() * 0.75) * (radialDistrict ? 0.6 : 1),
      decay: 1 / (extent * extent),
    })
  }

  const quarterAngle = rng() * Math.PI * 2
  const quarterDistance = radius * (0.15 + rng() * 0.3)
  elements.push({
    kind: 'grid',
    x: centreX + Math.cos(quarterAngle) * quarterDistance,
    z: centreZ + Math.sin(quarterAngle) * quarterDistance,
    theta: rng() * Math.PI,
    weight: PLANNED_QUARTER_WEIGHT,
    decay: 15 / (radius * radius),
  })

  const boundaries: BoundaryElement[] = []
  if (options.river && options.river.length >= 2) {
    boundaries.push({
      path: options.river.map(point => ({ x: point.x, z: point.z })),
      weight: 1.5,
      // Falls to about a third of strength one twelfth of a radius from the bank.
      decay: 150 / (radius * radius),
    })
  }

  return {
    elements,
    boundaries,
    /*
     * About twelve degrees. Enough that no street holds a bearing for any distance, small enough
     * that corners stay square and districts stay coherent — past roughly twenty the field starts
     * folding over itself and streamlines wander back through blocks they already bounded.
     */
    noiseAmplitude: 0.21,
    noiseScale: radius * 0.34,
    noiseSeed: stableHash(`${options.seed}::field:noise`) | 0,
    centreX,
    centreZ,
    radius,
  }
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}
