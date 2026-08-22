import { mulberry32, seededIndex } from './citySeed'
import { stableHash } from './atlasLayout'
import type { CityWarp } from './cityWarp'

/**
 * Landform and land use for one database city.
 *
 * **Evidence boundary — read this first.** Nothing in this file is measured, and nothing in it may
 * ever become measured. The river, the hills, the parks, the woodland, the plazas and the
 * neighbourhood characters are *scenery*: deterministic decoration derived from the database's own
 * id, exactly like the scatter in `cityPlan`. They exist because a map with nothing but buildings and
 * a square lattice reads as graph paper, and a map you cannot navigate by is a map nobody reads.
 *
 * The rule that keeps that honest is simple and absolute: **scenery is never derived from a
 * measurement.** A park does not mean a table is small. A river does not mean a schema is cold. A
 * commercial neighbourhood does not mean anything about the objects standing in it. Because the
 * inputs are only the seed and the grid geometry, no measurement *can* leak into the scenery, and no
 * reader can back one out of it. The legend says so in as many words.
 *
 * The two things scenery must never do are also enforced here rather than left to convention:
 *
 * - **It never floods a building.** The river is routed along street corridors, never through
 *   occupied blocks, so no lot is ever under water and no building is ever hidden by decoration.
 * - **It never tilts a measurement.** Relief is clamped to zero anywhere near a built or occupied
 *   block, so every building still stands on y = 0 and two buildings' heights stay directly
 *   comparable by eye. Hills happen out at the edges, where there is nothing to distort.
 */

export type Point = { x: number; z: number }

/**
 * What occupies a block.
 *
 * `built` and `facility` are placed by `cityPlan` from real objects. Everything else is an empty
 * block — genuinely empty, meaning no object is there — dressed as something worth looking at.
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

/** Every land use that is scenery rather than a placed object. */
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
 * Styling family for a schema's neighbourhood.
 *
 * Drawn from the schema id's hash and nothing else. It tints facades and picks which street furniture
 * appears, the way a real basemap distinguishes a retail high street from a warehouse district. It is
 * not a claim about the schema.
 */
export type DistrictCharacter = 'residential' | 'commercial' | 'industrial' | 'civic'

export const DISTRICT_CHARACTERS: readonly DistrictCharacter[] = [
  'residential',
  'commercial',
  'industrial',
  'civic',
]

export interface TerrainBlock {
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
  /** Smoothed river centreline, or empty when the grid was too small to route one. */
  readonly river: readonly RiverNode[]
  /** Schema id to the neighbourhood character its buildings are dressed in. */
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

/** Everything terrain needs from the plan, kept minimal so it can be unit-tested on its own. */
export interface TerrainInput {
  readonly blockCols: number
  readonly blockRows: number
  readonly pitchX: number
  readonly pitchZ: number
  readonly cell: number
  readonly streetWidth: number
  /** Clear ground between a building's edge and its lot boundary, doubled. See `LOT_MARGIN`. */
  readonly lotMargin: number
  /** `col-row` keys carrying a building. */
  readonly occupied: ReadonlySet<string>
  /** `col-row` keys carrying a civic facility. */
  readonly facilities: ReadonlySet<string>
  /** `col-row` keys drawn into a public square. */
  readonly plazas?: ReadonlySet<string>
  readonly districtIds: readonly string[]
  readonly seed: string
  /**
   * The lattice lines carrying arterials, so land use is decided at the same scale — and on the same
   * irregular rhythm — as the street network. Without it a park is one block wide and the map reads
   * as confetti.
   */
  readonly arterialCols?: readonly number[]
  readonly arterialRows?: readonly number[]
  /**
   * Where the junctions really are.
   *
   * Terrain is drawn on the same warped ground as everything else, so a river that follows a street
   * corridor has to follow the corridor's actual path rather than a straight lattice line.
   */
  readonly warp?: CityWarp
}

/** Base half-width of the river, as a fraction of the street corridor it runs along. */
const RIVER_BASE_HALF_WIDTH = 0.62

/** How far the river may widen into an adjacent empty block, as a fraction of the cell. */
const RIVER_MAX_WIDENING = 0.46

/** Smallest grid that gets a river at all. Below this the water swallows too much of a small town. */
const MIN_RIVER_GRID = 6

/** Points generated per lattice leg when smoothing the river. Enough to read as a curve, not a cost. */
const RIVER_SAMPLES_PER_LEG = 6

export function blockKey(col: number, row: number): string {
  return `${col}-${row}`
}

/**
 * Builds the whole landform and land-use layer for a city.
 *
 * Pure in its input: the same `TerrainInput` always produces an identical `CityTerrain`, which is
 * what lets the same database render byte-identically anywhere.
 */
export function planTerrain(input: TerrainInput): CityTerrain {
  // A generator of its own, seeded from the database id with a distinct salt. Terrain must not
  // consume from the placement stream, or adding a river would move every building in the city.
  const rng = mulberry32(stableHash(`${input.seed}::terrain`))
  const relief = buildRelief(rng)
  const river = routeRiver(input, relief, rng)
  const blocks = classifyBlocks(input, river, relief, rng)
  const characters = assignCharacters(input.districtIds)

  return {
    blocks,
    river,
    characters,
    relief,
    bounds: {
      maxX: input.warp?.maxX ?? input.blockCols * input.pitchX,
      maxZ: input.warp?.maxZ ?? input.blockRows * input.pitchZ,
    },
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
 * Routes the river along the street lattice, following the lowest ground it can find.
 *
 * Running the river down street corridors rather than across blocks is what guarantees it never
 * floods a lot: corridors are the one part of the grid that is known to be free of buildings. It also
 * means every street that crosses the river is a real street that still connects, so the crossing
 * becomes a bridge rather than a hole in the road network.
 *
 * Dijkstra with a cost that rewards low ground produces a meander rather than a straight cut, and the
 * deterministic tie-break keeps the same seed on the same path forever.
 */
function routeRiver(input: TerrainInput, relief: ReliefField, rng: () => number): RiverNode[] {
  const { blockCols, blockRows, pitchX, pitchZ } = input
  // Where the junctions actually are, so the river follows the corridor it was routed down rather
  // than a straight line between two lattice coordinates that no street runs along.
  const at = (col: number, row: number): Point =>
    input.warp?.node(col, row) ?? { x: col * pitchX, z: row * pitchZ }
  if (blockCols < MIN_RIVER_GRID || blockRows < MIN_RIVER_GRID) return []

  // West-to-east or north-to-south, so a city is not always crossed the same way.
  const eastWest = rng() < 0.5
  const spanRows = blockRows + 1
  const spanCols = blockCols + 1
  // Entry and exit are kept off the extreme edge so the river reads as crossing the city, not as
  // tracing its boundary.
  const inset = 1
  const startIndex = inset + seededIndex(rng, Math.max(1, (eastWest ? spanRows : spanCols) - inset * 2))
  const endIndex = inset + seededIndex(rng, Math.max(1, (eastWest ? spanRows : spanCols) - inset * 2))

  const startNode = eastWest ? { col: 0, row: startIndex } : { col: startIndex, row: 0 }
  const endNode = eastWest ? { col: blockCols, row: endIndex } : { col: endIndex, row: blockRows }

  const nodeId = (col: number, row: number) => `${col}:${row}`
  const inBounds = (col: number, row: number) =>
    col >= 0 && col <= blockCols && row >= 0 && row <= blockRows

  // Low ground is cheap, high ground is dear, so the path settles into a valley.
  const nodeCost = (col: number, row: number) => {
    const point = at(col, row)
    const height = reliefAt(relief, point.x, point.z)
    return 1 + (height + relief.amplitude) / (relief.amplitude * 2 + 1e-6)
  }

  const distance = new Map<string, number>([[nodeId(startNode.col, startNode.row), 0]])
  const previous = new Map<string, { col: number; row: number }>()
  const visited = new Set<string>()
  const frontier = new Map<string, { col: number; row: number }>([
    [nodeId(startNode.col, startNode.row), startNode],
  ])

  while (frontier.size > 0) {
    let currentId: string | null = null
    let current: { col: number; row: number } | null = null
    let best = Number.POSITIVE_INFINITY
    for (const id of [...frontier.keys()].sort()) {
      const value = distance.get(id) ?? Number.POSITIVE_INFINITY
      if (value < best) {
        best = value
        currentId = id
        current = frontier.get(id) ?? null
      }
    }
    if (currentId === null || current === null) break
    frontier.delete(currentId)
    visited.add(currentId)
    if (current.col === endNode.col && current.row === endNode.row) break

    const steps = [
      { col: current.col + 1, row: current.row },
      { col: current.col - 1, row: current.row },
      { col: current.col, row: current.row + 1 },
      { col: current.col, row: current.row - 1 },
    ]
    for (const step of steps) {
      if (!inBounds(step.col, step.row)) continue
      const stepId = nodeId(step.col, step.row)
      if (visited.has(stepId)) continue
      const legLength = step.col === current.col ? pitchZ : pitchX
      const candidate = best + (legLength / 100) * nodeCost(step.col, step.row)
      if (candidate < (distance.get(stepId) ?? Number.POSITIVE_INFINITY)) {
        distance.set(stepId, candidate)
        previous.set(stepId, current)
        frontier.set(stepId, step)
      }
    }
  }

  const endId = nodeId(endNode.col, endNode.row)
  if (!visited.has(endId)) return []

  const lattice: Array<{ col: number; row: number }> = [endNode]
  let cursor = endNode
  while (!(cursor.col === startNode.col && cursor.row === startNode.row)) {
    const parent = previous.get(nodeId(cursor.col, cursor.row))
    if (!parent) return []
    lattice.push(parent)
    cursor = parent
  }
  lattice.reverse()

  const corridor = lattice.map(node => at(node.col, node.row))
  const smoothed = smoothPolyline(corridor, RIVER_SAMPLES_PER_LEG)
  return widenRiver(smoothed, input)
}

/**
 * Gives every sample its own half-width, widening wherever the neighbouring blocks are empty.
 *
 * A river of constant width reads as a canal. Letting it swell into open ground and pinch between
 * buildings is what makes it read as water that was there before the city was.
 *
 * The pinch is also the guarantee behind "never flood a building". A block sizes its cell as
 * `footprint + LOT_MARGIN`, so the closest a building edge can ever be to the corridor centre line is
 * `streetWidth / 2 + lotMargin / 2`. Where any neighbouring block is built the half-width is capped
 * just inside that, so no seed can ever put water under a measured footprint.
 */
function widenRiver(points: readonly Point[], input: TerrainInput): RiverNode[] {
  const base = input.streetWidth * RIVER_BASE_HALF_WIDTH
  const room = input.cell * RIVER_MAX_WIDENING
  const builtLimit = input.streetWidth / 2 + input.lotMargin * BUILT_BANK_CLEARANCE
  return points.map(point => {
    // Which block a sample sits in is no longer a division: the spans are irregular and the whole
    // lattice is displaced, so the warp is asked.
    const { col, row } = input.warp
      ? input.warp.nearestNode(point.x, point.z)
      : {
          col: Math.floor(point.x / input.pitchX),
          row: Math.floor(point.z / input.pitchZ),
        }
    let open = 0
    let total = 0
    for (const dc of [0, -1]) {
      for (const dr of [0, -1]) {
        const key = blockKey(col + dc, row + dr)
        total += 1
        if (!input.occupied.has(key) && !input.facilities.has(key)) open += 1
      }
    }
    const openness = total === 0 ? 0 : open / total
    const wanted = base + room * openness
    const halfWidth = openness === 1 ? wanted : Math.min(wanted, builtLimit)
    return { x: point.x, z: point.z, halfWidth }
  })
}

/**
 * How much of the lot margin the water may take on a bank that carries a building, as a fraction.
 * Below 0.5 by a clear margin, because 0.5 is exactly the building edge.
 */
const BUILT_BANK_CLEARANCE = 0.4

/**
 * Catmull-Rom through the lattice corners, which is what turns a staircase of right angles into a
 * meander. The endpoints are duplicated so the curve starts and ends exactly where the corridor does.
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

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * Dresses every block.
 *
 * Occupied blocks keep what the plan put there. Empty blocks — and there are a lot of them, since the
 * grid deliberately runs about half empty so the scatter has room — get a land use chosen from where
 * they sit: drowned or bankside near the river, wooded and hilly out at the edges, paved and civic
 * near the centre, and ordinary green everywhere else.
 */
function classifyBlocks(
  input: TerrainInput,
  river: readonly RiverNode[],
  relief: ReliefField,
  rng: () => number,
): Map<string, TerrainBlock> {
  const { blockCols, blockRows, pitchX, pitchZ, cell, streetWidth } = input
  const blocks = new Map<string, TerrainBlock>()
  const centreCol = (blockCols - 1) / 2
  const centreRow = (blockRows - 1) / 2
  const maxRadius = Math.max(1, Math.hypot(centreCol, centreRow))

  // Draw the whole scatter stream up front, in a fixed grid order, so a block's dressing never
  // depends on how many blocks happened to be classified before it.
  const draws: number[] = []
  for (let index = 0; index < blockCols * blockRows; index += 1) draws.push(rng())

  // Land use is decided a whole arterial cell at a time, then let go of at the edges. A park that
  // covers one block is noise; a park that covers a cell is a place, and the blocks that break ranks
  // along its boundary are what stop it looking stamped out.
  //
  // The cells are the irregular ones the arterials cut, so no two parks are the same size or shape.
  const arterialCols = input.arterialCols ?? [0, blockCols]
  const arterialRows = input.arterialRows ?? [0, blockRows]
  const cellIndex = (lines: readonly number[], at: number) => {
    for (let index = lines.length - 2; index >= 0; index -= 1) if (at >= lines[index]) return index
    return 0
  }
  const regions = new Map<string, LandUse>()
  const regionAt = (col: number, row: number): LandUse | null => {
    if (arterialCols.length < 2 || arterialRows.length < 2) return null
    const cellCol = cellIndex(arterialCols, col)
    const cellRow = cellIndex(arterialRows, row)
    const key = `${cellCol}:${cellRow}`
    const cached = regions.get(key)
    if (cached !== undefined) return cached
    const centre = {
      col: (arterialCols[cellCol] + arterialCols[cellCol + 1] - 1) / 2,
      row: (arterialRows[cellRow] + arterialRows[cellRow + 1] - 1) / 2,
    }
    const radius = Math.hypot(centre.col - centreCol, centre.row - centreRow) / maxRadius
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

  for (let row = 0; row < blockRows; row += 1) {
    for (let col = 0; col < blockCols; col += 1) {
      const key = blockKey(col, row)
      const centre = input.warp
        ? input.warp.blockCenter(col, row)
        : { x: col * pitchX + streetWidth / 2 + cell / 2, z: row * pitchZ + streetWidth / 2 + cell / 2 }
      const x = centre.x
      const z = centre.z
      const draw = draws[row * blockCols + col]
      const radius = Math.hypot(col - centreCol, row - centreRow) / maxRadius
      const built = input.occupied.has(key)
      const facility = input.facilities.has(key)
      const plaza = input.plazas?.has(key) ?? false

      // Relief is held at zero across the built core and only allowed to rise toward the edge, so no
      // building is ever tilted or lifted relative to its neighbours. Held at a literal zero rather
      // than a multiplication, so a negative slope cannot leave a measured block sitting at -0.
      const reliefRamp = built || facility ? 0 : clamp01(Math.max(0, radius - 0.55) / 0.45)
      const height = reliefRamp === 0 ? 0 : reliefAt(relief, x, z) * reliefRamp

      blocks.set(key, {
        col,
        row,
        key,
        use: built
          ? 'built'
          : facility
            ? 'facility'
            : plaza
              ? 'plaza'
              : sceneryFor(river, x, z, cell, radius, draw, regionAt(col, row)),
        x,
        z,
        size: cell,
        seed: stableHash(`${input.seed}::block::${key}`),
        relief: height,
      })
    }
  }
  return blocks
}

/**
 * Picks the scenery for one empty block.
 *
 * The ordering matters and is deliberate: water wins over everything because a block the river runs
 * through is water whatever else it might have been, then the bankside strip, then the land use of
 * the surrounding cell, and only where a block breaks ranks does it fall through to its own position
 * in the city. That last case is what gives a region a ragged edge instead of a stamped one.
 */
function sceneryFor(
  river: readonly RiverNode[],
  x: number,
  z: number,
  cell: number,
  radius: number,
  draw: number,
  region: LandUse | null = null,
): LandUse {
  if (river.length > 1) {
    const { distance, halfWidth } = riverProximity(river, x, z)
    if (distance < halfWidth + cell * 0.18) return 'water'
    if (distance < halfWidth + cell * 1.25) return draw < 0.72 ? 'greenway' : 'park'
  }

  if (region !== null && draw < 0.84) return region

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
 * Gives every schema a neighbourhood character.
 *
 * Hashed from the schema id alone, so it is stable, decorative, and carries no claim about the
 * schema. Two schemas with identical contents can and will look different, which is the tell that
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
