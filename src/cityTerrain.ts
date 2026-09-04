import { mulberry32 } from './citySeed'
import { stableHash } from './atlasLayout'
import type { CityBlockField } from './cityBlocks'
import type { Point } from './cityStreamlines'

/**
 * Landform and land use for one capacity city.
 *
 * **Evidence boundary — read this first.** Nothing in this file is measured, and nothing in it may
 * ever become measured. The river, the hills, the parks, the woodland, the plazas and the
 * neighbourhood characters are *scenery*: deterministic decoration derived from the capacity's own
 * id, exactly like the block shapes in `cityPlan`. They exist because a map with nothing but
 * buildings reads as a spreadsheet, and a map you cannot navigate by is a map nobody reads.
 *
 * The rule that keeps that honest is simple and absolute: **scenery is never derived from a
 * measurement.** A park does not mean an item is small. A river does not mean a workspace is cold. A
 * commercial neighbourhood does not mean anything about the items standing in it. Because the
 * inputs are only the seed and the seeded block geometry, no measurement *can* leak into the scenery,
 * and no reader can back one out of it. The legend says so in as many words.
 *
 * The two things scenery must never do are also enforced here rather than left to convention:
 *
 * - **It never floods a building.** The river is traced before the streets are, and every block its
 *   channel reaches is withheld from placement in `cityPlan`, so no lot is ever put on water and no
 *   building is ever hidden by decoration.
 * - **It never tilts a measurement.** Relief is clamped to zero on any block carrying a building or a
 *   facility, so every building still stands on y = 0 and two buildings' heights stay directly
 *   comparable by eye. Hills happen out at the edges, where there is nothing to distort.
 */

export type { Point }

/**
 * What occupies a block.
 *
 * `built` and `facility` are placed by `cityPlan` from real items and facilities. Everything else is
 * an empty block — genuinely empty, meaning nothing measured is there — dressed as something worth
 * looking at.
 */
export type LandUse =
  | 'built'
  | 'facility'
  | 'water'
  | 'park'
  | 'greenway'
  | 'woodland'
  | 'orchard'
  | 'plaza'
  | 'parking'
  | 'yard'

/** Every land use that is scenery rather than a placed item or facility. */
export const SCENERY_USES: readonly LandUse[] = [
  'water',
  'park',
  'greenway',
  'woodland',
  'orchard',
  'plaza',
  'parking',
  'yard',
]

/**
 * Styling family for a workspace's neighbourhood.
 *
 * Drawn from the workspace id's hash and nothing else. It tints facades and picks which street furniture
 * appears, the way a real basemap distinguishes a retail high street from a warehouse district. It is
 * not a claim about the workspace.
 */
export type DistrictCharacter = 'residential' | 'commercial' | 'industrial' | 'civic'

export const DISTRICT_CHARACTERS: readonly DistrictCharacter[] = [
  'residential',
  'commercial',
  'industrial',
  'civic',
]

export interface TerrainBlock {
  /** The block's id. Named `col` so consumers written for the lattice keep working; `row` is 0. */
  readonly col: number
  readonly row: number
  readonly key: string
  readonly use: LandUse
  /** Block centre in world units. */
  readonly x: number
  readonly z: number
  /** Side length of the block interior, i.e. the lot size. */
  readonly size: number
  /** Stable per-block seed, for decorative scatter inside the block. */
  readonly seed: number
  /** 0 at the built core, rising toward the map edge. Drives hills in 3D only. */
  readonly relief: number
}

/** One sampled point along the river centreline, carrying the half-width the ribbon has there. */
export interface RiverNode {
  readonly x: number
  readonly z: number
  readonly halfWidth: number
}

export interface CityTerrain {
  readonly blocks: ReadonlyMap<string, TerrainBlock>
  /** Smoothed river centreline, or empty when the city was too small to route one. */
  readonly river: readonly RiverNode[]
  /** Workspace id to the neighbourhood character its buildings are dressed in. */
  readonly characters: ReadonlyMap<string, DistrictCharacter>
  /** Coefficients for {@link reliefAt}; stored rather than closed over so terrain stays comparable. */
  readonly relief: ReliefField
  readonly bounds: { readonly maxX: number; readonly maxZ: number }
}

export interface ReliefField {
  readonly amplitude: number
  readonly waves: readonly ReliefWave[]
}

interface ReliefWave {
  readonly frequencyX: number
  readonly frequencyZ: number
  readonly phaseX: number
  readonly phaseZ: number
  readonly weight: number
}

/**
 * The landform: the relief field and the river, both of which have to exist before the streets do.
 *
 * The streets are traced to avoid the water, so the water cannot be read off the finished street
 * network the way it was on the lattice — it has to be laid down first and handed to the street
 * generator as ground to keep out of. That is the whole reason landform is split from the rest of the
 * terrain: this half runs first, the block dressing runs last.
 */
export interface Landform {
  readonly relief: ReliefField
  readonly river: readonly RiverNode[]
}

/** Everything {@link planLandform} needs, kept minimal so it can be unit-tested on its own. */
export interface LandformInput {
  readonly seed: string
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
  /** Carriageway width, which the river's narrowest reach is sized against. */
  readonly streetWidth: number
  /** Block cell size, which the river's widest reach is sized against. */
  readonly cell: number
}

/** Everything the block-dressing half of terrain needs. Pure in its input. */
export interface TerrainInput {
  readonly field: CityBlockField
  readonly landform: Landform
  /** Block ids carrying a building. */
  readonly occupied: ReadonlySet<number>
  /** Block ids carrying a civic facility. */
  readonly facilities: ReadonlySet<number>
  /** Block ids the river channel reaches, which are drawn as open water. */
  readonly water: ReadonlySet<number>
  readonly districtIds: readonly string[]
  readonly seed: string
}

/** Base half-width of the river, as a fraction of the street corridor it runs beside. */
const RIVER_BASE_HALF_WIDTH = 0.62

/** How far the river may widen in the open country at the city edge, as a fraction of the cell. */
const RIVER_MAX_WIDENING = 0.46

/**
 * Smallest city, as a multiple of the cell, that gets a river at all. Below this the water swallows
 * too much of a small town for it still to read as a town.
 */
const MIN_RIVER_SPAN_CELLS = 10

/** Steps taken across the city while tracing the channel, and points smoothed in per step. */
const RIVER_TRACE_STEPS = 44
const RIVER_SAMPLES_PER_LEG = 6

/** How far, as a fraction of the crossing width, the channel may slew toward lower ground per step. */
const RIVER_SLEW_FRACTION = 0.05

/** Perpendicular offsets tried each step when the channel looks for lower ground, either side of straight. */
const RIVER_PROBE = 3

/** Coarse regions the empty ground is dressed in, across the widest span of the city. */
const REGION_BUCKETS = 6

export function blockKey(id: number): string {
  return `${id}`
}

/**
 * Builds the relief field and the river.
 *
 * Runs before the streets, because the street generator is told to keep out of the water. Pure in its
 * input: the same {@link LandformInput} always produces an identical landform, which is part of what
 * lets the same capacity render byte-identically anywhere.
 */
export function planLandform(input: LandformInput): Landform {
  // A generator of its own, seeded from the capacity id with a distinct salt. Landform must not
  // consume from the placement stream, or adding a river would move every building in the city.
  const rng = mulberry32(stableHash(`${input.seed}::terrain`))
  const relief = buildRelief(rng)
  const river = traceRiver(input, relief, rng)
  return { relief, river }
}

/**
 * Builds the block-dressing layer once the streets, blocks and placement are all known.
 *
 * Pure in its input: the same {@link TerrainInput} always produces an identical {@link CityTerrain}.
 */
export function planTerrain(input: TerrainInput): CityTerrain {
  const blocks = classifyBlocks(input)
  const characters = assignCharacters(input.districtIds)
  return {
    blocks,
    river: input.landform.river,
    characters,
    relief: input.landform.relief,
    bounds: { maxX: input.field.maxX, maxZ: input.field.maxZ },
  }
}

/**
 * A few summed sine waves, which is plenty for ground that should read as gently rolling rather than
 * as terrain. Deliberately low frequency: the point is a soft horizon, not a landscape.
 */
function buildRelief(rng: () => number): ReliefField {
  const waves: ReliefWave[] = []
  for (let index = 0; index < 3; index += 1) {
    waves.push({
      frequencyX: 0.0016 + rng() * 0.0034,
      frequencyZ: 0.0016 + rng() * 0.0034,
      phaseX: rng() * Math.PI * 2,
      phaseZ: rng() * Math.PI * 2,
      weight: 1 / (index + 1),
    })
  }
  return { amplitude: 14 + rng() * 10, waves }
}

/** Raw relief in world units at a point, before any flattening. Range is roughly `-amplitude..amplitude`. */
export function reliefAt(field: ReliefField, x: number, z: number): number {
  let total = 0
  let weight = 0
  for (const wave of field.waves) {
    total +=
      wave.weight *
      Math.sin(x * wave.frequencyX + wave.phaseX) *
      Math.cos(z * wave.frequencyZ + wave.phaseZ)
    weight += wave.weight
  }
  return weight === 0 ? 0 : (total / weight) * field.amplitude
}

/**
 * Traces the river across the city, following the lowest ground it can find.
 *
 * The lattice version ran the river down street corridors, because those were the one part of the
 * grid known to be free of buildings. There is no lattice to run down any more, and the streets do
 * not even exist yet, so instead the channel is traced first and the streets are kept out of it: it
 * steps across the city one span at a time and slews toward whichever neighbouring ground is lowest,
 * which produces a meander rather than a straight cut. The deterministic search — fixed probe order,
 * strict improvement only — keeps the same seed on the same channel forever.
 */
function traceRiver(input: LandformInput, relief: ReliefField, rng: () => number): RiverNode[] {
  const width = input.maxX - input.minX
  const depth = input.maxZ - input.minZ
  if (Math.min(width, depth) < input.cell * MIN_RIVER_SPAN_CELLS) return []

  // West-to-east or north-to-south, so a city is not always crossed the same way.
  const eastWest = rng() < 0.5
  const alongMin = eastWest ? input.minX : input.minZ
  const alongMax = eastWest ? input.maxX : input.maxZ
  const crossSpan = eastWest ? depth : width
  const crossOrigin = eastWest ? input.minZ : input.minX
  // Entry and exit are kept off the extreme edge so the river reads as crossing the city, not as
  // tracing its boundary.
  const crossMin = crossOrigin + crossSpan * 0.14
  const crossMax = crossOrigin + crossSpan * 0.86
  const maxSlew = crossSpan * RIVER_SLEW_FRACTION

  const pointOf = (along: number, cross: number): Point =>
    eastWest ? { x: along, z: cross } : { x: cross, z: along }

  let cross = crossMin + rng() * (crossMax - crossMin)
  const raw: Point[] = [pointOf(alongMin, cross)]
  for (let step = 1; step <= RIVER_TRACE_STEPS; step += 1) {
    const along = alongMin + ((alongMax - alongMin) * step) / RIVER_TRACE_STEPS
    let bestCross = cross
    let bestHeight = Infinity
    for (let probe = -RIVER_PROBE; probe <= RIVER_PROBE; probe += 1) {
      const candidate = clamp(cross + (probe / RIVER_PROBE) * maxSlew, crossMin, crossMax)
      const here = pointOf(along, candidate)
      const height = reliefAt(relief, here.x, here.z)
      if (height < bestHeight - 1e-9) {
        bestHeight = height
        bestCross = candidate
      }
    }
    cross = bestCross
    raw.push(pointOf(along, cross))
  }

  const smoothed = smoothPolyline(raw, RIVER_SAMPLES_PER_LEG)
  return widenRiver(smoothed, input)
}

/**
 * Gives every sample its own half-width, swelling toward the edge of the city.
 *
 * A river of constant width reads as a canal. A real river is pinched where a town has built up
 * against it and broad out in the open country beyond, so the half-width grows with distance from the
 * centre. The pinch downtown is also what keeps the water off the dense core; the blocks the channel
 * still reaches are withheld from placement, so no width can ever put water under a measured footprint.
 */
function widenRiver(points: readonly Point[], input: LandformInput): RiverNode[] {
  const base = input.streetWidth * RIVER_BASE_HALF_WIDTH
  const room = input.cell * RIVER_MAX_WIDENING
  const centreX = (input.minX + input.maxX) / 2
  const centreZ = (input.minZ + input.maxZ) / 2
  const halfSpan = Math.max(1, Math.max(input.maxX - input.minX, input.maxZ - input.minZ) / 2)
  return points.map(point => {
    const edge = clamp01((Math.hypot(point.x - centreX, point.z - centreZ) / halfSpan - 0.2) / 0.8)
    return { x: point.x, z: point.z, halfWidth: base + room * edge }
  })
}

/**
 * Catmull-Rom through the traced corners, which is what turns a run of straight steps into a meander.
 * The endpoints are duplicated so the curve starts and ends exactly where the trace does.
 */
export function smoothPolyline(points: readonly Point[], samplesPerLeg: number): Point[] {
  if (points.length < 3) return points.map(point => ({ x: point.x, z: point.z }))
  const padded = [points[0], ...points, points[points.length - 1]]
  const result: Point[] = []
  for (let index = 1; index < padded.length - 2; index += 1) {
    const p0 = padded[index - 1]
    const p1 = padded[index]
    const p2 = padded[index + 1]
    const p3 = padded[index + 2]
    for (let step = 0; step < samplesPerLeg; step += 1) {
      const t = step / samplesPerLeg
      result.push({
        x: catmullRom(p0.x, p1.x, p2.x, p3.x, t),
        z: catmullRom(p0.z, p1.z, p2.z, p3.z, t),
      })
    }
  }
  result.push({ x: points[points.length - 1].x, z: points[points.length - 1].z })
  return result
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  )
}

/**
 * Shortest distance from a point to the river, with the half-width and flow direction carried at the
 * closest sample.
 *
 * The tangent is what lets the street network tell a bank from a crossing: a street running with the
 * flow is an embankment road, a street running across it is a bridge.
 */
export function riverProximity(
  river: readonly RiverNode[],
  x: number,
  z: number,
): { distance: number; halfWidth: number; tangent: Point } {
  let best = Number.POSITIVE_INFINITY
  let halfWidth = 0
  let tangent: Point = { x: 1, z: 0 }
  for (let index = 1; index < river.length; index += 1) {
    const a = river[index - 1]
    const b = river[index]
    const dx = b.x - a.x
    const dz = b.z - a.z
    const lengthSquared = dx * dx + dz * dz
    const t = lengthSquared < 1e-9 ? 0 : clamp01(((x - a.x) * dx + (z - a.z) * dz) / lengthSquared)
    const distance = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t))
    if (distance < best) {
      best = distance
      halfWidth = a.halfWidth + (b.halfWidth - a.halfWidth) * t
      const length = Math.sqrt(lengthSquared)
      if (length > 1e-9) tangent = { x: dx / length, z: dz / length }
    }
  }
  return { distance: best, halfWidth, tangent }
}

/**
 * The blocks the river channel reaches, whose centre the water covers.
 *
 * These are withheld from placement in `cityPlan` before a single building is assigned, which is the
 * mechanism behind "never floods a building": a lot is never even offered a block the river runs
 * through. Called once and shared, so the placement pool and the drawn water can never disagree.
 */
export function waterBlocks(field: CityBlockField, river: readonly RiverNode[]): Set<number> {
  const ids = new Set<number>()
  if (river.length < 2) return ids
  for (const block of field.blocks) {
    const { distance, halfWidth } = riverProximity(river, block.centroid.x, block.centroid.z)
    if (distance < halfWidth) ids.add(block.id)
  }
  return ids
}

/**
 * A test that a world point is in the river, for keeping the streets out of the water.
 *
 * The channel is excluded from the street tracer everywhere except in periodic gaps, and a street
 * that crosses at a gap becomes a bridge. The gaps matter: excluding the whole channel would sever
 * the two banks into separate networks, and a river you cannot cross is worse than one you can see
 * streets running into. So the exclusion opens a crossable window every `bridgeSpacing`, wide enough
 * (`bridgeGap`) that several streets get across and both banks stay one reachable city.
 */
export function riverExclusion(
  river: readonly RiverNode[],
  bridgeSpacing: number,
  bridgeGap: number,
): (x: number, z: number) => boolean {
  if (river.length < 2 || bridgeSpacing <= 0) return () => false
  const cumulative = [0]
  for (let index = 1; index < river.length; index += 1) {
    cumulative.push(cumulative[index - 1] + Math.hypot(river[index].x - river[index - 1].x, river[index].z - river[index - 1].z))
  }
  return (x, z) => {
    let best = Number.POSITIVE_INFINITY
    let halfWidth = 0
    let arc = 0
    for (let index = 1; index < river.length; index += 1) {
      const a = river[index - 1]
      const b = river[index]
      const dx = b.x - a.x
      const dz = b.z - a.z
      const lengthSquared = dx * dx + dz * dz
      const t = lengthSquared < 1e-9 ? 0 : clamp01(((x - a.x) * dx + (z - a.z) * dz) / lengthSquared)
      const distance = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t))
      if (distance < best) {
        best = distance
        halfWidth = a.halfWidth + (b.halfWidth - a.halfWidth) * t
        arc = cumulative[index - 1] + t * Math.sqrt(lengthSquared)
      }
    }
    if (best >= halfWidth) return false
    return ((arc % bridgeSpacing) + bridgeSpacing) % bridgeSpacing > bridgeGap
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * Dresses every block.
 *
 * Occupied blocks keep what the plan put there. Empty blocks — and there are a lot of them, since the
 * city deliberately holds more blocks than placed items so the neighbourhoods have room to breathe — get a
 * land use chosen from where they sit: drowned or bankside near the river, wooded and hilly out at the
 * edges, paved and civic near the centre, and ordinary green everywhere else.
 */
function classifyBlocks(input: TerrainInput): Map<string, TerrainBlock> {
  const { field, landform } = input
  const blocks = new Map<string, TerrainBlock>()
  const regionGrid = Math.max(1, Math.max(field.maxX - field.minX, field.maxZ - field.minZ) / REGION_BUCKETS)

  // Land use is decided a whole coarse region at a time, then let go of at its edges. A park that
  // covers one block is noise; a park that covers a region is a place, and the blocks that break
  // ranks along its boundary are what stop it looking stamped out. The region a block belongs to is a
  // coarse bucket of its centre, so nearby blocks share a region without any lattice to align to.
  const regions = new Map<string, LandUse>()
  const regionAt = (block: { centroid: Point; centrality: number }): LandUse => {
    const bucketX = Math.floor((block.centroid.x - field.minX) / regionGrid)
    const bucketZ = Math.floor((block.centroid.z - field.minZ) / regionGrid)
    const key = `${bucketX}:${bucketZ}`
    const cached = regions.get(key)
    if (cached !== undefined) return cached
    const radius = block.centrality
    const draw = mulberry32(stableHash(`${input.seed}::region::${key}`))()
    const use: LandUse =
      radius > 0.72
        ? draw < 0.5
          ? 'woodland'
          : draw < 0.8
            ? 'orchard'
            : 'park'
        : radius < 0.32
          ? draw < 0.3
            ? 'plaza'
            : draw < 0.78
              ? 'park'
              : 'parking'
          : draw < 0.44
            ? 'park'
            : draw < 0.7
              ? 'woodland'
              : draw < 0.9
                ? 'yard'
                : 'parking'
    regions.set(key, use)
    return use
  }

  for (const block of field.blocks) {
    const key = blockKey(block.id)
    const x = block.centroid.x
    const z = block.centroid.z
    const radius = block.centrality
    const built = input.occupied.has(block.id)
    const facility = input.facilities.has(block.id)
    const water = input.water.has(block.id)
    const draw = mulberry32(stableHash(`${input.seed}::block::${block.id}`))()

    // Relief is held at zero on any built or occupied block and only allowed to rise toward the edge,
    // so no building is ever tilted or lifted relative to its neighbours. Held at a literal zero
    // rather than a multiplication, so a negative slope cannot leave a measured block sitting at -0.
    const reliefRamp = built || facility ? 0 : clamp01(Math.max(0, radius - 0.55) / 0.45)
    const height = reliefRamp === 0 ? 0 : reliefAt(landform.relief, x, z) * reliefRamp

    blocks.set(key, {
      col: block.id,
      row: 0,
      key,
      use: built
        ? 'built'
        : facility
          ? 'facility'
          : water
            ? 'water'
            : sceneryFor(landform.river, x, z, block.capacity, radius, draw, regionAt(block)),
      x,
      z,
      size: block.capacity,
      seed: stableHash(`${input.seed}::block::${block.id}`),
      relief: height,
    })
  }
  return blocks
}

/**
 * Picks the scenery for one empty block.
 *
 * The ordering matters and is deliberate: the bankside strip near the water comes first, then the
 * land use of the surrounding region, and only where a block breaks ranks does it fall through to its
 * own position in the city. That last case is what gives a region a ragged edge instead of a stamped
 * one. Water itself is decided before this is called, from the shared channel set.
 */
function sceneryFor(
  river: readonly RiverNode[],
  x: number,
  z: number,
  cell: number,
  radius: number,
  draw: number,
  region: LandUse,
): LandUse {
  if (river.length > 1) {
    const { distance, halfWidth } = riverProximity(river, x, z)
    if (distance < halfWidth + cell * 1.25) return draw < 0.72 ? 'greenway' : 'park'
  }

  if (draw < 0.84) return region

  // Out at the edge the city thins into countryside; in the middle it hardens into paving.
  if (radius > 0.78) return draw < 0.55 ? 'woodland' : draw < 0.82 ? 'orchard' : 'park'
  if (radius < 0.3) return draw < 0.32 ? 'plaza' : draw < 0.76 ? 'park' : 'parking'
  if (draw < 0.4) return 'park'
  if (draw < 0.58) return 'woodland'
  if (draw < 0.7) return 'plaza'
  if (draw < 0.8) return 'parking'
  if (draw < 0.92) return 'yard'
  return 'orchard'
}

/**
 * Gives every workspace a neighbourhood character.
 *
 * Hashed from the workspace id alone, so it is stable, decorative, and carries no claim about the
 * workspace. Two workspaces with identical contents can and will look different, which is the tell that
 * this is styling rather than evidence.
 */
function assignCharacters(districtIds: readonly string[]): Map<string, DistrictCharacter> {
  const characters = new Map<string, DistrictCharacter>()
  for (const districtId of districtIds) {
    const index = stableHash(`${districtId}::character`) % DISTRICT_CHARACTERS.length
    characters.set(districtId, DISTRICT_CHARACTERS[index])
  }
  return characters
}
