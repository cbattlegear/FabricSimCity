import { stableHash } from './atlasLayout'
import { FACILITY_LABELS, FACILITY_ORDER, type FacilityKind, type FacilitySite } from './cityInfrastructure'
import { mulberry32, seededShuffle } from './citySeed'
import { planWarp, WARP_HEADROOM, type CityWarp, type WarpPlaza } from './cityWarp'
import {
  blockKey as terrainBlockKey,
  planTerrain,
  riverProximity,
  type CityTerrain,
  type Point,
} from './cityTerrain'
import type { DatabaseCityObject, DatabaseCitySchema } from './databaseCityContracts'

/**
 * Deterministic town plan for one database city.
 *
 * The city is *scattered* — buildings and infrastructure are spread across the whole block grid
 * rather than packed into contiguous rectangles — but it is not random. Every position comes from a
 * generator seeded with the database's own id, so the same database produces byte-identical
 * placement on every load, in every browser, on every machine. Scatter is a look, not a lottery.
 *
 * Placement derives only from that seed and from the backend's stable layout ordinals
 * (`layout.neighborhoodOrdinal` / `layout.objectOrdinal`), never from the order rows happen to
 * arrive in. This preserves the architectural rule that database-city layout is deterministic and
 * independent of source row order, and it keeps a building on the same lot when a later bounded page
 * is appended.
 *
 * Only building footprint and height carry a quantity claim (both documented logarithmic mappings of
 * exact 8-KiB page counts). The archetype selected here changes *style* only -- a house and a
 * skyscraper of identical page counts would occupy identical volume -- so decorative geometry never
 * encodes evidence.
 */

/** Style family for a building. Selected from exact reserved page counts; never a quantity claim itself. */
export type BuildingArchetype =
  | 'house'
  | 'rowhouse'
  | 'midrise'
  | 'tower'
  | 'skyscraper'
  | 'civic'
  | 'vacant'

/**
 * Cartographic weight of a street. Never a measurement — road *class* is styling, exactly as it is on
 * a printed basemap, while the quantities a road carries live in its traffic ribbon.
 *
 * `boulevard` is the ring road, `avenue` the diagonals that cut across the lattice, and `riverside`
 * the embankment roads that hug the water. All three are real graph edges, so a route genuinely
 * prefers them when they are genuinely shorter.
 */
export type StreetClass = 'arterial' | 'collector' | 'boulevard' | 'avenue' | 'riverside'

/** Which way a lot fronts. `rotationY` is the Y rotation that turns a +Z-facing model toward its street. */
export type Facing = 'north' | 'south' | 'east' | 'west'

export interface CityIntersection {
  readonly id: string
  readonly col: number
  readonly row: number
  readonly x: number
  readonly z: number
}

export interface CityStreet {
  readonly id: string
  readonly fromId: string
  readonly toId: string
  readonly streetClass: StreetClass
  /** `d` for the diagonal avenues, which belong to neither lattice axis. */
  readonly axis: 'x' | 'z' | 'd'
  readonly width: number
  readonly fromX: number
  readonly fromZ: number
  readonly toX: number
  readonly toZ: number
  /**
   * The drawn centre line, sampled from the street's curve and always starting at `from` and ending
   * at `to`.
   *
   * Streets used to be drawn as the straight line between their endpoints, which is what made the map
   * read as graph paper. They now bow by a seeded amount, and the route, the lane offsets and the
   * dash phase all consume this polyline, so a car, a wait lane and the road under them agree.
   *
   * Curvature is decoration. The endpoints, the connectivity and everything a road *carries* are
   * untouched by it.
   */
  readonly path: readonly Point[]
  /** True where the street crosses open water and is drawn as a bridge deck. */
  readonly bridge: boolean
}

export interface CityLot {
  readonly objectId: string
  readonly districtId: string
  readonly blockId: string
  /** Lattice coordinates of the block this lot sits on, so its frontage can be rebound to a street. */
  readonly blockCol: number
  readonly blockRow: number
  /** Building centre in world units. */
  readonly x: number
  readonly z: number
  /** Y rotation that turns the model's +Z front toward its frontage street. */
  readonly rotationY: number
  readonly facing: Facing
  /** Point on the frontage street kerb that this building is entered from; the GPS route stops here. */
  readonly accessX: number
  readonly accessZ: number
  readonly frontageStreetId: string
  readonly lotSize: number
  /** Documented logarithmic mapping of exact reserved 8-KiB pages, or null when size is unknown. */
  readonly footprint: number | null
  /** Documented logarithmic mapping of exact used 8-KiB pages, or null when size is unknown. */
  readonly height: number | null
  readonly archetype: BuildingArchetype
  /** Stable per-object seed for decorative variation only. */
  readonly seed: number
}

export interface CityDistrict {
  readonly districtId: string
  readonly name: string
  readonly neighborhoodOrdinal: number
  readonly kind: 'schema' | 'civic'
  readonly objectCount: number
  /**
   * The blocks this schema's neighbourhood claims, whether or not a loaded object stands on one.
   *
   * Claimed from the schema's full object count, so the shape of a neighbourhood is settled before
   * its tables arrive and does not shift underneath them as pages load.
   */
  readonly blocks: readonly BlockRef[]
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
  readonly centerX: number
  readonly centerZ: number
  /** Where the neighbourhood's name is written: the middle of the ground it owns. */
  readonly labelX: number
  readonly labelZ: number
}

export interface CityBounds {
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
  readonly centerX: number
  readonly centerZ: number
  readonly width: number
  readonly depth: number
}

export interface CityPlan {
  readonly cell: number
  readonly streetWidth: number
  readonly blockCols: number
  readonly blockRows: number
  readonly districts: readonly CityDistrict[]
  readonly lots: ReadonlyMap<string, CityLot>
  readonly intersections: ReadonlyMap<string, CityIntersection>
  readonly streets: readonly CityStreet[]
  readonly bounds: CityBounds
  /**
   * Landform, water and land use.
   *
   * Entirely decorative and documented as such in `cityTerrain`. It is carried on the plan because
   * every consumer that draws the ground needs it, not because it says anything about the database.
   */
  readonly terrain: CityTerrain
  /**
   * Where the CPU / memory / storage / tempdb / log / lock facilities stand.
   *
   * Facilities are scattered across the grid rather than gathered into one civic quarter, because a
   * single infrastructure block turns into a corner of the map you look at once. Spread out, they
   * become landmarks you navigate by — and a route to a table genuinely passes them.
   */
  readonly facilities: ReadonlyMap<FacilityKind, FacilitySite>
  /**
   * Where every junction in this city actually stands.
   *
   * Carried on the plan because the mapping from lattice coordinates to world coordinates is no
   * longer a multiplication anyone downstream can repeat for themselves. See `cityWarp`.
   */
  readonly warp: CityWarp
  /** Which lattice lines carry the heavy roads. Irregular on purpose. */
  readonly arterials: ArterialRhythm
  /** The public squares, in world coordinates. */
  readonly plazas: readonly WarpPlaza[]
}

/** Options that make a plan reproducible and stable as bounded pages arrive. */
export interface CityPlanOptions {
  /**
   * Seed source for the scatter. The database id, so a database's layout is the same everywhere.
   * Two databases with identical shapes still get different cities, which is the point.
   */
  readonly seed?: string
  /**
   * Total object count for the whole database, from `page.totalObjects`.
   *
   * The grid is sized from this rather than from the loaded count, which is what stops the city
   * from being re-planned — and every building from moving — the moment a second page arrives.
   */
  readonly totalObjects?: string | number | null
  /**
   * All schemas in the database with their full object counts, from `page.schemas`.
   *
   * Every page carries the complete schema list, so these counts give each object a global slot
   * index that does not depend on which page it arrived on. Without them the slot index is derived
   * from the loaded objects alone, which is only stable once everything is loaded.
   */
  readonly schemas?: readonly DatabaseCitySchema[]
}

/**
 * Lots per block. One building stands alone on its own block, ringed by street on every side.
 *
 * Blocks used to hold eight buildings in two back-to-back rows, which read as an undifferentiated
 * mass of geometry: the only thing separating one building from the next was the gap between two
 * boxes. Giving every building its own block moves that separation into the street lattice itself.
 * Neighbourhood tints then do a different job — they group buildings rather than divide them.
 *
 * This costs roughly 1.7x the ground area per building -- a lot plus its share of the surrounding
 * street, rather than a lot plus a shared eighth of one. That is the price of the separation and it
 * is paid deliberately.
 */
export const BLOCK_COLS = 1
export const BLOCK_ROWS = 1
export const CELLS_PER_BLOCK = BLOCK_COLS * BLOCK_ROWS

export const STREET_WIDTH = 15
export const ARTERIAL_WIDTH = 23
/**
 * Clear ground a block keeps around its building, split evenly on all four sides.
 *
 * This is the verge: it holds the pavement, the street trees and the front garden, and it is also the
 * budget every curved road spends. Because `chooseCell` sizes a cell as `footprint + LOT_MARGIN`, a
 * building edge is never nearer a corridor centre line than `STREET_WIDTH / 2 + LOT_MARGIN / 2`, and
 * {@link SAFE_ROAD_SPAN} holds every carriageway inside that.
 */
export const LOT_MARGIN = 16
export const MIN_CELL = 26

/**
 * How far a carriageway's edge may sit from its corridor centre line and still miss every building.
 *
 * One world unit of slack is kept back so the kerb never merely touches a footprint.
 */
const SAFE_ROAD_SPAN = STREET_WIDTH / 2 + LOT_MARGIN / 2 - 1

/** Every Nth lattice line is an arterial, giving the map a legible major-road rhythm. */
export const ARTERIAL_EVERY = 4

/** Footprint and height used for an object whose page counts are unavailable. Nonquantitative by design. */
export const UNKNOWN_FOOTPRINT = 11
export const UNKNOWN_HEIGHT = 8

/** Reserved-page thresholds that select a building's style family. Exact page counts, never rounded. */
export const ARCHETYPE_THRESHOLD_PAGES = {
  house: 128n, // < 1 MiB
  rowhouse: 2048n, // < 16 MiB
  midrise: 32768n, // < 256 MiB
  tower: 524288n, // < 4 GiB
} as const

/**
 * Minimum gap, in blocks, between any two infrastructure facilities.
 *
 * Measured as Chebyshev distance on the block grid, so diagonal neighbours count as adjacent too.
 * Two blocks apart means there is always at least one full block of ordinary city between any pair
 * of facilities — enough that they read as separate districts of the map rather than a campus.
 */
export const MIN_FACILITY_BLOCK_GAP = 2

/**
 * How many blocks the grid holds beyond the strict minimum.
 *
 * A grid packed exactly to size cannot scatter: every block is taken, so the "scatter" is just a
 * permutation of a solid rectangle. The slack buys empty blocks between buildings, which is what
 * makes the result look like a city with streets rather than a filled array.
 */
const GRID_SLACK = 1.9

/**
 * Smallest grid the city is ever planned on.
 *
 * Six facilities two blocks apart need room to breathe; below this the spacing rule starts failing
 * and the fallback runs. A four-table database still gets a plausible small town this way.
 */
const MIN_GRID_SIDE = 7

/**
 * How many seeded attempts to make at a spaced facility layout before falling back.
 *
 * Each attempt is a greedy pass over a freshly shuffled block list, which is a random maximal
 * independent set — usually successful on the first or second try at these grid sizes. The cap
 * exists so an adversarially small grid terminates instead of spinning.
 */
const FACILITY_PLACEMENT_ATTEMPTS = 32

/**
 * Building footprint in world units from exact reserved 8-KiB pages.
 * `6 + log2(1 + pages) * 0.75` -- a doubling of reserved pages widens the building by 0.75 units.
 */
export function buildingFootprint(reservedPages8KiB: string | null): number | null {
  const pages = pageCount(reservedPages8KiB)
  if (pages === null) return null
  return 6 + Math.log2(1 + pages) * 0.75
}

/**
 * Building height in world units from exact used 8-KiB pages.
 * `log2(1 + pages) * 4.8` -- zero used pages is zero height, and every doubling adds 4.8 units.
 * Deliberately unclamped so the mapping stays strictly monotonic in the measured value.
 */
export function buildingHeight(usedPages8KiB: string | null): number | null {
  const pages = pageCount(usedPages8KiB)
  if (pages === null) return null
  return Math.log2(1 + pages) * 4.8
}

/** Style family for one object. Unknown size is always `vacant`, which makes no quantity claim. */
export function buildingArchetype(object: DatabaseCityObject): BuildingArchetype {
  if (object.reservedPages8KiB === null || object.usedPages8KiB === null) return 'vacant'
  if (object.kind === 'IndexedView') return 'civic'
  let pages: bigint
  try {
    pages = BigInt(object.reservedPages8KiB)
  } catch {
    return 'vacant'
  }
  if (pages < ARCHETYPE_THRESHOLD_PAGES.house) return 'house'
  if (pages < ARCHETYPE_THRESHOLD_PAGES.rowhouse) return 'rowhouse'
  if (pages < ARCHETYPE_THRESHOLD_PAGES.midrise) return 'midrise'
  if (pages < ARCHETYPE_THRESHOLD_PAGES.tower) return 'tower'
  return 'skyscraper'
}

/**
 * Where the heavy roads run.
 *
 * `col % ARTERIAL_EVERY === 0` gave the map a major-road structure and, at the same time, a second
 * grid at four times the pitch — so the coarse reading of the city was every bit as regular as the
 * fine one, and no amount of curving the streets between arterials could hide it. Real arterials are
 * the roads that were already there: a turnpike, a river crossing, a ridge track. They arrive at
 * irregular intervals because nothing ever surveyed them together.
 *
 * The city edges are always arterials, so the outer boundary is continuous and the routing graph
 * cannot be cut off. Everything between them is drawn from a seeded gap.
 */
export interface ArterialRhythm {
  readonly cols: readonly number[]
  readonly rows: readonly number[]
  readonly colSet: ReadonlySet<number>
  readonly rowSet: ReadonlySet<number>
}

/** Narrowest and widest run of blocks between two arterials. */
const ARTERIAL_GAP_MIN = 3
const ARTERIAL_GAP_MAX = 7

function arterialLines(extent: number, rng: () => number): number[] {
  if (extent <= ARTERIAL_GAP_MIN) return [0, extent]
  const lines = [0]
  let at = 0
  while (at < extent) {
    const gap = ARTERIAL_GAP_MIN + Math.floor(rng() * (ARTERIAL_GAP_MAX - ARTERIAL_GAP_MIN + 1))
    at += gap
    // A final sliver of one or two blocks is not a district, so the last gap absorbs it.
    if (at >= extent - 1) break
    lines.push(at)
  }
  lines.push(extent)
  return lines
}

export function planArterials(blockCols: number, blockRows: number, seed: string): ArterialRhythm {
  const cols = arterialLines(blockCols, mulberry32(stableHash(`${seed}::arterial:x`)))
  const rows = arterialLines(blockRows, mulberry32(stableHash(`${seed}::arterial:z`)))
  return { cols, rows, colSet: new Set(cols), rowSet: new Set(rows) }
}

/** Index of the arterial cell a block falls in, on one axis. */
export function arterialCellIndex(lines: readonly number[], at: number): number {
  for (let index = lines.length - 2; index >= 0; index -= 1) {
    if (at >= lines[index]) return index
  }
  return 0
}

/**
 * The squares.
 *
 * A lattice junction is the crossing of two lines and nothing else, which is why a grid is so hard to
 * navigate from memory: every corner is the same corner. A city is remembered by the handful of
 * places where several streets arrive together and the ground opens out. Those are put here, on
 * arterial crossings so that what converges on them is already the heavy road network, and spaced far
 * enough apart that each one is a destination rather than a texture.
 */
const PLAZA_MIN_SEPARATION = 4

function planPlazas(
  blockCols: number,
  blockRows: number,
  arterials: ArterialRhythm,
  seed: string,
): BlockRef[] {
  const rng = mulberry32(stableHash(`${seed}::plaza`))
  const candidates: BlockRef[] = []
  for (const row of arterials.rows) {
    for (const col of arterials.cols) {
      // Never on the boundary: a square on the edge of the map is a junction with half its streets
      // missing, which reads as an unfinished road rather than as a place.
      if (col === 0 || row === 0 || col === blockCols || row === blockRows) continue
      candidates.push({ col, row })
    }
  }
  if (candidates.length === 0) return []

  const wanted = clamp(Math.round(Math.sqrt(candidates.length) * 0.9), 1, 6)
  const chosen: BlockRef[] = []
  for (const candidate of seededShuffle(candidates, rng)) {
    if (chosen.length >= wanted) break
    const clear = chosen.every(
      taken => Math.hypot(taken.col - candidate.col, taken.row - candidate.row) >= PLAZA_MIN_SEPARATION,
    )
    if (clear) chosen.push(candidate)
  }
  return sortForReading(chosen)
}

export function planCity(
  objects: readonly DatabaseCityObject[],
  options: CityPlanOptions = {},
): CityPlan {
  const cell = chooseCell(objects)
  /*
   * The pitch is deliberately larger than the block needs.
   *
   * `cell + STREET_WIDTH` is the tightest a block can be and still hold its building with a
   * carriageway around it — which means it is also a block with no room to be anything but a
   * rectangle. {@link WARP_HEADROOM} is the ground every curve, twist and square on this map is
   * bought with.
   */
  const pitchX = (BLOCK_COLS * cell + STREET_WIDTH) * WARP_HEADROOM
  const pitchZ = (BLOCK_ROWS * cell + STREET_WIDTH) * WARP_HEADROOM
  const seed = options.seed ?? 'sqlsimcity'

  const ordered = orderObjects(objects)
  const sizes = schemaSizes(ordered, options.schemas)
  const slots = globalSlots(ordered, sizes)
  const capacity = Math.max(
    parseCount(options.totalObjects) ?? 0,
    ordered.length,
    // A slot index past the end would wrap and collide, so the grid always covers the highest one.
    ...[...slots.values()].map(slot => slot + 1),
  )

  const side = Math.max(
    MIN_GRID_SIDE,
    Math.ceil(Math.sqrt((capacity + FACILITY_ORDER.length) * GRID_SLACK)),
  )
  const blockCols = side
  const blockRows = side

  /*
   * Geometry is settled before anything is placed on it.
   *
   * The arterial rhythm, the squares and the warp depend only on the seed and the grid size, so they
   * are fixed before a single building is assigned — which is what keeps an appended page from
   * reshaping the streets under a city that is already on screen.
   */
  const arterials = planArterials(blockCols, blockRows, seed)
  const plazas = planPlazas(blockCols, blockRows, arterials, seed)
  const warp = planWarp({
    blockCols,
    blockRows,
    pitchX,
    pitchZ,
    cell,
    streetWidth: STREET_WIDTH,
    arterialCols: arterials.cols,
    arterialRows: arterials.rows,
    seed,
    plazas,
  })

  // One generator for the whole plan: facilities draw first, buildings take what is left. Both read
  // from the same stream, so the seed alone determines the entire city.
  const rng = mulberry32(stableHash(seed))
  const facilityBlocks = placeFacilities(blockCols, blockRows, rng)
  const facilityKeys = new Set(facilityBlocks.map(block => blockKey(block.col, block.row)))

  const plazaKeys = new Set(plazaBlocks(plazas, blockCols, blockRows).map(
    block => blockKey(block.col, block.row)))
  const freeBlocks = allBlocks(blockCols, blockRows).filter(
    block => !facilityKeys.has(blockKey(block.col, block.row)) &&
      !plazaKeys.has(blockKey(block.col, block.row)),
  )
  const shuffled = seededShuffle(freeBlocks, rng)

  // Territories grow in reading order and are then shuffled, so a schema's tables spread through
  // their own neighbourhood instead of packing against its seed and leaving the outskirts bare.
  const territories = planNeighborhoods(freeBlocks, sizes, rng, seed)
  const addresses = new Map<string, BlockRef[]>()
  for (const [schemaId, blocks] of territories) addresses.set(schemaId, seededShuffle(blocks, rng))

  const lots = new Map<string, CityLot>()
  const occupied = new Set<string>()
  for (const object of ordered) {
    const territory = addresses.get(object.schemaId)
    const block = territory && territory.length > 0
      ? territory[objectOrdinal(object) % territory.length]
      : shuffled[(slots.get(object.objectId) ?? 0) % shuffled.length]
    lots.set(object.objectId, placeLot(object, block, cell, warp))
    occupied.add(terrainBlockKey(block.col, block.row))
  }

  const districts = describeDistricts(ordered, lots, territories, warp)
  const terrain = planTerrain({
    blockCols,
    blockRows,
    pitchX,
    pitchZ,
    cell,
    streetWidth: STREET_WIDTH,
    lotMargin: LOT_MARGIN,
    occupied,
    facilities: new Set(facilityBlocks.map(block => terrainBlockKey(block.col, block.row))),
    plazas: plazaKeys,
    districtIds: districts.map(district => district.districtId),
    arterialCols: arterials.cols,
    arterialRows: arterials.rows,
    seed,
    warp,
  })

  const { intersections, streets } = buildStreetNetwork(
    blockCols,
    blockRows,
    cell,
    terrain,
    warp,
    arterials,
    plazas,
    seed,
  )

  // Doors are hung last, because until the network settles there is no telling which of a block's
  // four streets is still there to be entered from.
  rebindFrontages(lots, streets)

  return {
    cell,
    streetWidth: STREET_WIDTH,
    blockCols,
    blockRows,
    districts,
    lots,
    intersections,
    streets,
    bounds: cityBounds(warp),
    terrain,
    facilities: facilitySites(facilityBlocks, cell, warp),
    warp,
    arterials,
    plazas: warp.plazas,
  }
}

/**
 * The blocks a square occupies.
 *
 * A plaza node has the four blocks around it drawn in toward it, so those blocks are ground rather
 * than sites: putting a building on one would stand it in the middle of the open space the square
 * exists to be.
 */
function plazaBlocks(
  plazas: readonly BlockRef[],
  blockCols: number,
  blockRows: number,
): BlockRef[] {
  const blocks: BlockRef[] = []
  for (const plaza of plazas) {
    for (const [col, row] of [
      [plaza.col - 1, plaza.row - 1],
      [plaza.col, plaza.row - 1],
      [plaza.col - 1, plaza.row],
      [plaza.col, plaza.row],
    ]) {
      if (col < 0 || row < 0 || col >= blockCols || row >= blockRows) continue
      blocks.push({ col, row })
    }
  }
  return blocks
}

/**
 * Spacing of the street corridors: the grain every road in the city runs on.
 *
 * Exposed because a curved road can only be identified with the leg it belongs to by quantising to
 * this, not by rounding its coordinates. Since the warp, this is the *average* grain rather than an
 * exact pitch — which is all corridor bucketing ever needed it to be.
 */
export function streetPitch(plan: Pick<CityPlan, 'cell'>): { x: number; z: number } {
  return {
    x: (BLOCK_COLS * plan.cell + STREET_WIDTH) * WARP_HEADROOM,
    z: (BLOCK_ROWS * plan.cell + STREET_WIDTH) * WARP_HEADROOM,
  }
}

/** Grid id of the intersection nearest a world point, for entering the street graph. */
export function nearestIntersectionId(plan: CityPlan, x: number, z: number): string {
  const { col, row } = plan.warp.nearestNode(x, z)
  const exact = intersectionId(col, row)
  if (plan.intersections.has(exact)) return exact

  /*
   * Thinning the interior deletes junctions nothing meets at any more, and the nearest *node* to a
   * point can easily be one of them. Falling back to the nearest surviving junction keeps every
   * entry into the routing graph on a real street corner.
   */
  let bestId = exact
  let bestDistance = Infinity
  for (const intersection of plan.intersections.values()) {
    const distance = (intersection.x - x) ** 2 + (intersection.z - z) ** 2
    if (distance < bestDistance) {
      bestDistance = distance
      bestId = intersection.id
    }
  }
  return bestId
}

/**
 * Shortest street-following path between two intersections, as an ordered list of intersection ids.
 * Dijkstra over the lattice with an ordinal tie-break, so the same pair always yields the same path.
 */
export function streetPath(plan: CityPlan, fromId: string, toId: string): string[] {
  if (!plan.intersections.has(fromId) || !plan.intersections.has(toId)) return []
  if (fromId === toId) return [fromId]

  const neighbours = adjacency(plan)
  const distance = new Map<string, number>([[fromId, 0]])
  const previous = new Map<string, string>()
  const visited = new Set<string>()
  const queue = new Set<string>([fromId])

  while (queue.size > 0) {
    let current: string | null = null
    let best = Number.POSITIVE_INFINITY
    for (const candidate of [...queue].sort()) {
      const value = distance.get(candidate) ?? Number.POSITIVE_INFINITY
      if (value < best) {
        best = value
        current = candidate
      }
    }
    if (current === null) break
    queue.delete(current)
    visited.add(current)
    if (current === toId) break

    for (const edge of neighbours.get(current) ?? []) {
      if (visited.has(edge.toId)) continue
      const candidateDistance = best + edge.cost
      if (candidateDistance < (distance.get(edge.toId) ?? Number.POSITIVE_INFINITY)) {
        distance.set(edge.toId, candidateDistance)
        previous.set(edge.toId, current)
        queue.add(edge.toId)
      }
    }
  }

  if (!visited.has(toId)) return []
  const path = [toId]
  let cursor = toId
  while (cursor !== fromId) {
    const parent = previous.get(cursor)
    if (parent === undefined) return []
    path.push(parent)
    cursor = parent
  }
  return path.reverse()
}

/**
 * World-space polyline that visits every waypoint in order, following streets the whole way.
 *
 * Used by shared wait lanes, which must thread through each object a multi-object query family names
 * before running out to its facility: one continuous path, drawn once, so the family's whole wait
 * total is never duplicated across the buildings it touches. Consecutive duplicate points are
 * dropped where one leg ends exactly where the next begins, so the joins are seamless.
 *
 * Fewer than two waypoints describes no journey, so the result is empty rather than a degenerate
 * point: a lane with nowhere to go is not drawn at all.
 */
export function streetPolylineThrough(
  plan: CityPlan,
  waypoints: ReadonlyArray<{ x: number; z: number }>,
): Array<{ x: number; z: number }> {
  if (waypoints.length < 2) return []
  const points: Array<{ x: number; z: number }> = []
  for (let index = 0; index < waypoints.length - 1; index += 1) {
    for (const point of streetPolyline(plan, waypoints[index], waypoints[index + 1])) {
      const last = points[points.length - 1]
      if (last && last.x === point.x && last.z === point.z) continue
      points.push(point)
    }
  }
  return points
}

/**
 * World-space polyline from one point to another that only ever travels along street centre lines.
 *
 * Buildings are entered from their kerb, which is half a street width off the centre line, so the
 * connector at each end gets an elbow: pull perpendicular onto the street first, drive along it, then
 * pull off to the kerb at the far end.
 *
 * Between the two elbows the route now follows each street's drawn centre line rather than the
 * straight line between intersections, so a car on a bowed collector, an embankment road or a
 * diagonal avenue stays on the carriageway instead of cutting the corner through the blocks.
 */
export function streetPolyline(
  plan: CityPlan,
  from: { x: number; z: number },
  to: { x: number; z: number },
): Array<{ x: number; z: number }> {
  const path = streetPath(
    plan,
    nearestIntersectionId(plan, from.x, from.z),
    nearestIntersectionId(plan, to.x, to.z),
  )
  const lattice = path
    .map(id => plan.intersections.get(id))
    .filter((node): node is CityIntersection => node !== undefined)

  const points: Array<{ x: number; z: number }> = [{ x: from.x, z: from.z }]
  if (lattice.length === 0) {
    pushElbow(points, from, to, true)
    points.push({ x: to.x, z: to.z })
    return dedupePoints(points)
  }

  const entry = lattice[0]
  pushElbow(points, from, entry, true)

  const geometry = streetGeometry(plan)
  points.push({ x: entry.x, z: entry.z })
  for (let index = 1; index < lattice.length; index += 1) {
    const leg = geometry.get(`${lattice[index - 1].id}>${lattice[index].id}`)
    if (leg && leg.length > 1) {
      // The leg repeats the node the previous leg ended on; dedupePoints drops it at the end.
      for (const point of leg) points.push({ x: point.x, z: point.z })
    } else {
      points.push({ x: lattice[index].x, z: lattice[index].z })
    }
  }

  const exit = lattice[lattice.length - 1]
  pushElbow(points, exit, to, false)
  points.push({ x: to.x, z: to.z })
  return dedupePoints(points)
}

/**
 * Inserts the corner needed to reach `to` from `from` with two axis-aligned moves.
 * `shortAxisFirst` turns perpendicular onto the street before driving along it; the far end wants the
 * opposite, so it drives first and turns off last.
 */
function pushElbow(
  points: Array<{ x: number; z: number }>,
  from: { x: number; z: number },
  to: { x: number; z: number },
  shortAxisFirst: boolean,
): void {
  const dx = Math.abs(to.x - from.x)
  const dz = Math.abs(to.z - from.z)
  if (dx < AXIS_EPSILON || dz < AXIS_EPSILON) return
  const changeXFirst = shortAxisFirst ? dx < dz : dx >= dz
  points.push(changeXFirst ? { x: to.x, z: from.z } : { x: from.x, z: to.z })
}

const AXIS_EPSILON = 1e-9

/** A block on the grid. Blocks hold exactly one lot, so a block address is a building address. */
export interface BlockRef {
  readonly col: number
  readonly row: number
}

function blockKey(col: number, row: number): string {
  return `${col}-${row}`
}

function allBlocks(blockCols: number, blockRows: number): BlockRef[] {
  const blocks: BlockRef[] = []
  for (let row = 0; row < blockRows; row += 1) {
    for (let col = 0; col < blockCols; col += 1) blocks.push({ col, row })
  }
  return blocks
}

/** Chebyshev distance in blocks: diagonal neighbours are one block apart, same as orthogonal ones. */
function blockGap(left: BlockRef, right: BlockRef): number {
  return Math.max(Math.abs(left.col - right.col), Math.abs(left.row - right.row))
}

/** Stable object order: neighbourhood, then object ordinal, then id. Never row arrival order. */
function orderObjects(objects: readonly DatabaseCityObject[]): DatabaseCityObject[] {
  return [...objects].sort(
    (left, right) =>
      left.layout.neighborhoodOrdinal - right.layout.neighborhoodOrdinal ||
      compareOrdinal(left.schemaId, right.schemaId) ||
      left.layout.objectOrdinal - right.layout.objectOrdinal ||
      compareOrdinal(left.objectId, right.objectId),
  )
}

function parseCount(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null
}

/**
 * A page-independent slot index for every object.
 *
 * The backend numbers objects *within* a schema, so an object ordinal alone is not a position in the
 * city. Adding the running total of every earlier schema's full object count turns it into one, and
 * because every page carries the complete schema list with complete counts, that sum is the same on
 * page one as it is on page nine. This is what actually delivers the promise that appending a page
 * moves nothing: an object's block is a function of its own identity, not of who else is loaded.
 *
 * Only used now for the blockless fallback and for sizing the grid; a located object takes its block
 * from its own schema's neighbourhood instead.
 */
function globalSlots(
  ordered: readonly DatabaseCityObject[],
  counts: readonly SchemaSize[],
): Map<string, number> {
  const offsets = new Map<string, number>()
  let running = 0
  for (const entry of counts) {
    offsets.set(entry.schemaId, running)
    running += entry.count
  }

  const slots = new Map<string, number>()
  for (const object of ordered) {
    slots.set(object.objectId, (offsets.get(object.schemaId) ?? 0) + objectOrdinal(object))
  }
  return slots
}

/** How many objects a schema holds in total, and where it sits in neighbourhood order. */
interface SchemaSize {
  readonly schemaId: string
  readonly ordinal: number
  readonly count: number
}

/** An object's index within its own schema, floored and clamped so it can only address a real block. */
function objectOrdinal(object: DatabaseCityObject): number {
  const ordinal = Math.floor(object.layout.objectOrdinal)
  return Number.isFinite(ordinal) && ordinal > 0 ? ordinal : 0
}

/**
 * Every schema's full object count, in neighbourhood order.
 *
 * Taken from the page's complete schema list when there is one, because that count is the same on
 * every page and is therefore what a neighbourhood can be sized from without moving as pages load.
 * A schema the list did not mention, or one whose count is short of what actually arrived, is
 * widened to fit rather than allowed to overlap the next schema.
 */
function schemaSizes(
  ordered: readonly DatabaseCityObject[],
  schemas: readonly DatabaseCitySchema[] | undefined,
): SchemaSize[] {
  const counts = new Map<string, { ordinal: number; count: number }>()

  if (schemas && schemas.length > 0) {
    for (const schema of schemas) {
      counts.set(schema.schemaId, {
        ordinal: schema.neighborhoodOrdinal,
        count: parseCount(schema.objectCount) ?? 0,
      })
    }
  }
  for (const object of ordered) {
    const existing = counts.get(object.schemaId)
    const observed = objectOrdinal(object) + 1
    if (!existing) {
      counts.set(object.schemaId, { ordinal: object.layout.neighborhoodOrdinal, count: observed })
    } else if (observed > existing.count) {
      counts.set(object.schemaId, { ordinal: existing.ordinal, count: observed })
    }
  }

  return [...counts.entries()]
    .map(([schemaId, entry]) => ({ schemaId, ordinal: entry.ordinal, count: entry.count }))
    .sort((left, right) => left.ordinal - right.ordinal || compareOrdinal(left.schemaId, right.schemaId))
}

/**
 * Ground a neighbourhood claims per object it holds.
 *
 * Above 1 so a neighbourhood has gaps in it — front gardens, corner parks, the odd empty plot — which
 * is what stops a schema reading as a solid slab of buildings. Below {@link GRID_SLACK}, which is the
 * airiness of the grid as a whole, because the difference between the two is the open country that
 * separates one neighbourhood from the next. That separation is the whole point: a schema you can see
 * the edge of is a schema you can navigate by.
 */
const NEIGHBORHOOD_SLACK = 1.5

/**
 * How far a block's cost may wander when a neighbourhood decides whether to claim it.
 *
 * Growth without this is a distance field, and a distance field grows discs. Real neighbourhoods have
 * ragged edges, so every block gets a fixed seeded handicap that makes some of them cheap to reach and
 * others expensive. Big enough to bend a boundary by a block or two, small enough that a region stays
 * one connected place rather than breaking into islands.
 */
const NEIGHBORHOOD_WOBBLE = 1.7

/**
 * The hue a neighbourhood is drawn in, as a 0–1 turn around the wheel.
 *
 * Lives here, three-free, because two very different renderers have to agree on it: the 3D scene
 * bakes it into building materials and ground washes, and the sidebar paints the same swatch beside
 * the schema name. A second copy of this formula would be a colour legend that quietly lies.
 *
 * Hues step by the golden angle, so consecutive schemas land far apart on the wheel and the tenth
 * schema is still distinguishable from the first. That also makes the sequence ordinal-only: it is a
 * set of names, not a scale, and no hue is higher, hotter or busier than another.
 */
export function neighborhoodHue(ordinal: number): number {
  return (((ordinal * 0.6180339887498949) % 1) + 1) % 1
}

/** The neighbourhood swatch as a CSS colour, for chrome that never loads the 3D renderer. */
export function neighborhoodSwatch(ordinal: number): string {
  return `hsl(${(neighborhoodHue(ordinal) * 360).toFixed(1)} 52% 55%)`
}

/**
 * Divides the buildable grid into one contiguous territory per schema.
 *
 * This is the answer to "where does a table stand". Blocks used to be handed out from a single
 * city-wide shuffle, which put a schema's tables everywhere and nowhere: the map had no districts you
 * could point at, so the only way to see that two tables were related was to read both their labels.
 *
 * Each schema is given a seed block, spread as far from the other seeds as the grid allows, and the
 * territories then grow outward a block at a time in rounds. A schema still growing after its
 * neighbours have met their quota keeps taking ground, so a schema with ten times the tables gets
 * roughly ten times the territory, and the borders land wherever two regions happen to meet.
 *
 * Crucially the whole partition is a function of the seed, the grid and the *full* schema counts —
 * never of which objects have loaded. Appending a page therefore fills a neighbourhood in; it never
 * redraws one.
 */
function planNeighborhoods(
  freeBlocks: readonly BlockRef[],
  schemas: readonly SchemaSize[],
  rng: () => number,
  seed: string,
): Map<string, BlockRef[]> {
  const territories = new Map<string, BlockRef[]>()
  if (schemas.length === 0 || freeBlocks.length === 0) return territories
  for (const schema of schemas) territories.set(schema.schemaId, [])

  const quotas = neighborhoodQuotas(schemas, freeBlocks.length)
  const seeds = spreadSeeds(freeBlocks, schemas.length, rng)

  const unclaimed = new Map<string, BlockRef>()
  const wobble = new Map<string, number>()
  for (const block of freeBlocks) {
    const key = blockKey(block.col, block.row)
    unclaimed.set(key, block)
    wobble.set(key, (stableHash(`${seed}::hood::${key}`) % 1024) / 1024 * NEIGHBORHOOD_WOBBLE)
  }

  const cost = (block: BlockRef, from: BlockRef) =>
    Math.hypot(block.col - from.col, block.row - from.row) + (wobble.get(blockKey(block.col, block.row)) ?? 0)

  const frontiers = schemas.map(() => new Set<string>())
  const claim = (index: number, block: BlockRef) => {
    const key = blockKey(block.col, block.row)
    unclaimed.delete(key)
    territories.get(schemas[index].schemaId)!.push(block)
    frontiers[index].delete(key)
    for (const neighbour of orthogonalNeighbours(block)) {
      const neighbourKey = blockKey(neighbour.col, neighbour.row)
      if (unclaimed.has(neighbourKey)) frontiers[index].add(neighbourKey)
    }
  }

  seeds.forEach((block, index) => {
    if (unclaimed.has(blockKey(block.col, block.row))) claim(index, block)
  })

  // Rounds rather than one schema at a time: growing a schema to its full quota before the next one
  // starts would let the first schema surround every other seed and leave them nowhere to go.
  let growing = true
  while (growing) {
    growing = false
    for (let index = 0; index < schemas.length; index += 1) {
      if (territories.get(schemas[index].schemaId)!.length >= quotas[index]) continue
      const next =
        cheapest(frontiers[index], unclaimed, seeds[index], cost) ??
        // A region can be walled in by its neighbours before it is full. Jumping to the nearest free
        // ground keeps every object housed; the alternative is two tables sharing one block.
        cheapest(unclaimed.keys(), unclaimed, seeds[index], cost)
      if (!next) continue
      claim(index, next)
      growing = true
    }
  }

  return territories
}

/**
 * How many blocks each neighbourhood may claim.
 *
 * Proportional to the schema's share of the database, floored at the number of objects it actually
 * holds so every table has somewhere to stand, and capped so the quotas together never promise more
 * ground than the grid has.
 */
function neighborhoodQuotas(schemas: readonly SchemaSize[], available: number): number[] {
  const floors = schemas.map(schema => Math.min(schema.count, available))
  const committed = floors.reduce((sum, value) => sum + value, 0)
  const spare = Math.max(0, available - committed)
  const total = schemas.reduce((sum, schema) => sum + schema.count, 0)
  if (total === 0) return schemas.map(() => Math.floor(available / schemas.length))

  return schemas.map((schema, index) => {
    const wanted = Math.round(schema.count * NEIGHBORHOOD_SLACK) - floors[index]
    const share = Math.floor(spare * (schema.count / total))
    return floors[index] + Math.max(0, Math.min(wanted, share))
  })
}

/**
 * Picks one starting block per schema, each as far as possible from the ones already picked.
 *
 * Farthest-point sampling rather than random blocks: two seeds that land next to each other produce
 * two neighbourhoods that spend the whole growth fighting over the same ground and end up
 * interleaved, which is exactly the scattering this replaced.
 */
function spreadSeeds(freeBlocks: readonly BlockRef[], count: number, rng: () => number): BlockRef[] {
  const seeds: BlockRef[] = []
  if (freeBlocks.length === 0) return seeds
  seeds.push(freeBlocks[Math.min(freeBlocks.length - 1, Math.floor(rng() * freeBlocks.length))])

  while (seeds.length < count && seeds.length < freeBlocks.length) {
    let best: BlockRef | null = null
    let bestDistance = -1
    for (const block of freeBlocks) {
      let nearest = Infinity
      for (const seed of seeds) {
        nearest = Math.min(nearest, Math.hypot(block.col - seed.col, block.row - seed.row))
        if (nearest === 0) break
      }
      if (nearest > bestDistance) {
        bestDistance = nearest
        best = block
      }
    }
    if (!best || bestDistance <= 0) break
    seeds.push(best)
  }

  // More schemas than blocks is degenerate but must not throw; the extras share a seed and fall back
  // to the city-wide block list when they find no ground of their own.
  while (seeds.length < count) seeds.push(freeBlocks[seeds.length % freeBlocks.length])
  return seeds
}

/** The cheapest still-unclaimed block among `candidates`, or null when none is left. */
function cheapest(
  candidates: Iterable<string>,
  unclaimed: ReadonlyMap<string, BlockRef>,
  from: BlockRef,
  cost: (block: BlockRef, from: BlockRef) => number,
): BlockRef | null {
  let best: BlockRef | null = null
  let bestCost = Infinity
  let bestKey = ''
  for (const key of candidates) {
    const block = unclaimed.get(key)
    if (!block) continue
    const value = cost(block, from)
    // Ties broken by key so the partition never depends on Set iteration order.
    if (value < bestCost || (value === bestCost && key < bestKey)) {
      best = block
      bestCost = value
      bestKey = key
    }
  }
  return best
}

function orthogonalNeighbours(block: BlockRef): BlockRef[] {
  return [
    { col: block.col - 1, row: block.row },
    { col: block.col + 1, row: block.row },
    { col: block.col, row: block.row - 1 },
    { col: block.col, row: block.row + 1 },
  ]
}

/**
 * Chooses six blocks for the infrastructure facilities, every pair at least
 * {@link MIN_FACILITY_BLOCK_GAP} blocks apart.
 *
 * Each attempt greedily walks a freshly shuffled block list and takes any block that still clears
 * the gap — a random maximal independent set, which scatters the facilities properly instead of
 * pushing them into a lattice. If an attempt runs out of grid before placing all six it is
 * discarded and the next shuffle tried, so a lucky-but-cramped partial layout never ships.
 *
 * The chosen blocks are finally sorted top-left to bottom-right and zipped against
 * {@link FACILITY_ORDER}, so the facilities appear in a consistent reading order across the map.
 */
function placeFacilities(blockCols: number, blockRows: number, rng: () => number): BlockRef[] {
  const blocks = allBlocks(blockCols, blockRows)
  for (let attempt = 0; attempt < FACILITY_PLACEMENT_ATTEMPTS; attempt += 1) {
    const chosen: BlockRef[] = []
    for (const block of seededShuffle(blocks, rng)) {
      if (chosen.length === FACILITY_ORDER.length) break
      if (chosen.every(taken => blockGap(taken, block) >= MIN_FACILITY_BLOCK_GAP)) chosen.push(block)
    }
    if (chosen.length === FACILITY_ORDER.length) return sortForReading(chosen)
  }
  return sortForReading(spreadFacilities(blocks))
}

/**
 * Deterministic fallback for a grid too small to satisfy the gap rule.
 *
 * Starts at the first block and repeatedly takes whichever free block is furthest from everything
 * already taken, ties broken by block index. The spacing rule is relaxed rather than enforced —
 * a tiny database still gets a laid-out city, just a tighter one — and the result is still entirely
 * determined by the grid size, so it never varies between loads.
 */
function spreadFacilities(blocks: readonly BlockRef[]): BlockRef[] {
  if (blocks.length === 0) return []
  const chosen: BlockRef[] = [blocks[0]]
  while (chosen.length < FACILITY_ORDER.length) {
    let best: BlockRef | null = null
    let bestGap = -1
    for (const candidate of blocks) {
      if (chosen.some(taken => taken.col === candidate.col && taken.row === candidate.row)) continue
      const gap = Math.min(...chosen.map(taken => blockGap(taken, candidate)))
      if (gap > bestGap) {
        bestGap = gap
        best = candidate
      }
    }
    // Fewer blocks than facilities: reuse from the front rather than return a short list, so every
    // facility still has somewhere to stand.
    chosen.push(best ?? blocks[chosen.length % blocks.length])
  }
  return chosen
}

function sortForReading(blocks: readonly BlockRef[]): BlockRef[] {
  return [...blocks].sort((left, right) => left.row - right.row || left.col - right.col)
}

function facilitySites(
  blocks: readonly BlockRef[],
  cell: number,
  warp: CityWarp,
): Map<FacilityKind, FacilitySite> {
  const sites = new Map<FacilityKind, FacilitySite>()
  FACILITY_ORDER.forEach((kind, index) => {
    const block = blocks[index]
    if (!block) return
    const centre = warp.blockCenter(block.col, block.row)
    sites.set(kind, {
      kind,
      label: FACILITY_LABELS[kind],
      x: centre.x,
      z: centre.z,
      // Facilities fill their block. They are civic landmarks and must stay legible next to a
      // skyscraper, so their size is fixed by the block, never by a measurement.
      radius: cell / 2,
    })
  })
  return sites
}

/**
 * Describes each schema's neighbourhood: the ground it claimed and the buildings standing on it.
 *
 * The box is the territory rather than the bounding box of whatever has loaded, so framing "show me
 * this schema" holds still as pages arrive and always frames the same place. Only schemas with a
 * building on the map get a district, because a district is what the map labels and there is nothing
 * to point at otherwise.
 */
function describeDistricts(
  ordered: readonly DatabaseCityObject[],
  lots: ReadonlyMap<string, CityLot>,
  territories: ReadonlyMap<string, BlockRef[]>,
  warp: CityWarp,
): CityDistrict[] {
  const groups = new Map<string, { name: string; ordinal: number; lots: CityLot[] }>()
  for (const object of ordered) {
    const lot = lots.get(object.objectId)
    if (!lot) continue
    const existing = groups.get(object.schemaId)
    if (existing) {
      existing.lots.push(lot)
      existing.ordinal = Math.min(existing.ordinal, object.layout.neighborhoodOrdinal)
    } else {
      groups.set(object.schemaId, {
        name: object.schemaName,
        ordinal: object.layout.neighborhoodOrdinal,
        lots: [lot],
      })
    }
  }

  return [...groups.entries()]
    .sort((left, right) => left[1].ordinal - right[1].ordinal || compareOrdinal(left[0], right[0]))
    .map(([districtId, group]) => {
      const blocks = territories.get(districtId) ?? []
      // A warped block is a quadrilateral, so a territory's extent is the extent of its corners
      // rather than a multiple of a pitch.
      const corners = blocks.flatMap(block => warp.blockCorners(block.col, block.row))
      const box = corners.length > 0
        ? {
            minX: Math.min(...corners.map(point => point.x)),
            maxX: Math.max(...corners.map(point => point.x)),
            minZ: Math.min(...corners.map(point => point.z)),
            maxZ: Math.max(...corners.map(point => point.z)),
          }
        : {
            minX: Math.min(...group.lots.map(lot => lot.x)),
            maxX: Math.max(...group.lots.map(lot => lot.x)),
            minZ: Math.min(...group.lots.map(lot => lot.z)),
            maxZ: Math.max(...group.lots.map(lot => lot.z)),
          }
      const centres = blocks.map(block => warp.blockCenter(block.col, block.row))
      return {
        districtId,
        name: group.name,
        neighborhoodOrdinal: group.ordinal,
        kind: 'schema' as const,
        objectCount: group.lots.length,
        blocks,
        ...box,
        centerX: (box.minX + box.maxX) / 2,
        centerZ: (box.minZ + box.maxZ) / 2,
        // The name goes over the middle of the claimed ground, not the middle of the box: an L-shaped
        // territory's box centre can easily be a block the schema does not own.
        labelX: centres.length > 0
          ? average(centres.map(point => point.x))
          : average(group.lots.map(lot => lot.x)),
        labelZ: centres.length > 0
          ? average(centres.map(point => point.z))
          : average(group.lots.map(lot => lot.z)),
      }
    })
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * A single city-wide lot size keeps the street lattice aligned and guarantees lots never overlap.
 * The logarithmic footprint mapping bounds the spread, so one very large table cannot make the whole
 * city sparse.
 */
function chooseCell(objects: readonly DatabaseCityObject[]): number {
  let widest = UNKNOWN_FOOTPRINT
  for (const object of objects) {
    const footprint = buildingFootprint(object.reservedPages8KiB) ?? UNKNOWN_FOOTPRINT
    if (footprint > widest) widest = footprint
  }
  return Math.max(MIN_CELL, Math.ceil(widest + LOT_MARGIN))
}

function placeLot(
  object: DatabaseCityObject,
  block: BlockRef,
  cell: number,
  warp: CityWarp,
): CityLot {
  const centre = warp.blockCenter(block.col, block.row)
  const kerb = warp.blockFrontage(block.col, block.row)

  /*
   * One lot per block, so the building fronts the street along its block's north edge and the other
   * three sides are open street too. There is no back row to face the other way.
   *
   * "North" is now the *lattice* north rather than world north, because a warped block is a
   * quadrilateral that may sit at any angle. The building turns to face its own kerb, which is what
   * makes a twisted quarter read as a quarter that was laid out on its own alignment.
   */
  const facing: Facing = 'north'
  const heading = Math.atan2(kerb.x - centre.x, kerb.z - centre.z)

  return {
    objectId: object.objectId,
    districtId: object.schemaId,
    blockId: `block/${block.col}-${block.row}`,
    blockCol: block.col,
    blockRow: block.row,
    x: centre.x,
    z: centre.z,
    rotationY: heading,
    facing,
    accessX: kerb.x,
    accessZ: kerb.z,
    frontageStreetId: streetIdFor('x', block.col, block.row),
    lotSize: cell,
    footprint: buildingFootprint(object.reservedPages8KiB),
    height: buildingHeight(object.usedPages8KiB),
    archetype: buildingArchetype(object),
    seed: stableHash(object.objectId),
  }
}

function cityBounds(warp: CityWarp): CityBounds {
  return {
    minX: warp.minX,
    maxX: warp.maxX,
    minZ: warp.minZ,
    maxZ: warp.maxZ,
    centerX: (warp.minX + warp.maxX) / 2,
    centerZ: (warp.minZ + warp.maxZ) / 2,
    width: warp.maxX - warp.minX,
    depth: warp.maxZ - warp.minZ,
  }
}

/**
 * The street network: an irregular skeleton of heavy roads, and a different kind of town inside each
 * piece it cuts.
 *
 * Six things happen here, in this order:
 *
 * 1. **The junctions.** Positions come from {@link CityWarp}, not from `col * pitch`. That is the
 *    whole point: bending the road *between* two lattice points still leaves two lattice points, and
 *    the eye reads a street network by where its junctions are. The warp moves the junctions.
 * 2. **The arterial rhythm.** Heavy roads fall on an irregular set of lines chosen by
 *    {@link planArterials} — 3 to 7 blocks apart, never the same twice — so the map has a major-road
 *    structure with no drumbeat. Road hierarchy is still decoration, not a measurement.
 * 3. **A pattern per cell.** {@link planSuperblocks} gives each piece of ground between the arterials
 *    its own street vocabulary: downtown grid, ladder, crescent, radial, organic, estate, open park.
 *    The grid is one option among seven and is confined to the middle of town.
 * 4. **Radial avenues**, genuinely new edges between existing junctions, converging on the plazas.
 *    Because they are shorter than the lattice legs they replace, `streetPath` really does route over
 *    them — the avenues are a road network, not a drawing.
 * 5. **The junction-degree pass.** {@link pruneJunctions} converts four-way junctions into T-junctions
 *    and cul-de-sacs until the degree distribution matches a measured city rather than a lattice.
 *    This is the single largest change in how the map reads.
 * 6. **Embankment roads and bridges**, decided by whether a street runs with the river or across it.
 *
 * Every street then gets a bowed centre line. Curvature is decoration: it moves no endpoint, changes
 * no connectivity, and alters nothing a road carries.
 */
/**
 * What the inside of one superblock looks like.
 *
 * The arterial rhythm cuts the city into cells of {@link ARTERIAL_EVERY} blocks a side, and this is
 * the vocabulary of what happens inside one. It exists because a lattice with a road on every
 * boundary is not a map of a town — it is graph paper. Real towns put a handful of long, straight,
 * heavy roads down and then let each cell between them do something completely different: a tight
 * downtown grid here, half a mile of curving cul-de-sacs there, a big-box pad with one service loop,
 * a park with no streets in it at all. That variation *is* the legibility. It is what lets you say
 * "the bit past the second big road" and be understood.
 *
 * Which pattern a cell gets is decoration, seeded from the database id like everything else here. It
 * encodes nothing: a cell of cul-de-sacs is not a slower schema, it is a cell of cul-de-sacs.
 */
type SuperblockPattern =
  /** The full fine lattice, barely bowed. Reads as a downtown core. */
  | 'downtown'
  /** Every through street kept, cross streets thinned out. Long blocks, suburban arterial frontage. */
  | 'ladder'
  /** Through streets kept and strongly bowed, one central cross spine. Curvilinear residential. */
  | 'crescent'
  /** Rings and spokes about the cell's own centre. Reads as a market town grown around a square. */
  | 'radial'
  /** Streets dropped on an irregular rhythm, heavily bowed. Reads as a quarter that predates surveying. */
  | 'organic'
  /** One lane in each direction through the middle of an otherwise undivided parcel. */
  | 'estate'
  /** No interior streets whatsoever. The whole cell is one parcel: park, water, or a big-box site. */
  | 'open'

interface Superblock {
  readonly pattern: SuperblockPattern
  /** The interior line that carries the cell's spine, for the patterns that have one. */
  readonly midCol: number
  readonly midRow: number
  /** The cell's first interior line, so a pattern can phase itself against its own edge. */
  readonly fromCol: number
  readonly fromRow: number
  /** Which alternate interior column keeps its cross street under `ladder`. */
  readonly parity: number
  /** Multiplier on how far this cell's streets are allowed to wander. */
  readonly bow: number
  /** Multiplier on the clearance a wandering street may claim, where no building can be hit. */
  readonly room: number
}

function superblockKey(col: number, row: number): string {
  return `${col}:${row}`
}

/**
 * Decide what happens inside every cell of the arterial grid.
 *
 * Cells are the irregular ones {@link planArterials} cut, so a pattern applies to a piece of city of
 * an unpredictable size — which is half of why the result stops looking machine-made.
 *
 * The one rule that is not aesthetic: every block must end up with at least one bounding street, or
 * a building has no frontage to be entered from. That is enforced downstream by
 * {@link rebindFrontages} rather than by refusing patterns here, so an occupied cell is free to be
 * something other than a grid.
 */
function planSuperblocks(
  arterials: ArterialRhythm,
  terrain: CityTerrain,
  seed: string,
): Map<string, Superblock> {
  const cols = arterials.cols.length - 1
  const rows = arterials.rows.length - 1
  const occupied = new Set<string>()
  for (const block of terrain.blocks.values()) {
    if (block.use !== 'built' && block.use !== 'facility') continue
    occupied.add(superblockKey(
      arterialCellIndex(arterials.cols, block.col),
      arterialCellIndex(arterials.rows, block.row),
    ))
  }

  const centreCol = (cols - 1) / 2
  const centreRow = (rows - 1) / 2
  const maxRadius = Math.max(1, Math.hypot(centreCol, centreRow))
  const superblocks = new Map<string, Superblock>()

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const key = superblockKey(col, row)
      const rng = mulberry32(stableHash(`${seed}::superblock::${key}`))
      const draw = rng()
      const radius = Math.hypot(col - centreCol, row - centreRow) / maxRadius

      let pattern: SuperblockPattern
      if (!occupied.has(key)) {
        pattern = draw < 0.62 ? 'open' : 'estate'
      } else if (radius < 0.3) {
        /*
         * The middle. A small-block grid belongs *here* and only here — this is the one part of a
         * real city that was ever surveyed as a grid — and even here it shares the ground with the
         * old town it grew out of.
         */
        pattern = draw < 0.4 ? 'downtown' : draw < 0.72 ? 'organic' : 'radial'
      } else if (radius < 0.66) {
        pattern = draw < 0.22 ? 'downtown' : draw < 0.46 ? 'ladder' : draw < 0.74 ? 'organic' : 'crescent'
      } else {
        // The edge of town: curving residential and loop estates, never a downtown grid.
        pattern = draw < 0.34 ? 'crescent' : draw < 0.62 ? 'organic' : draw < 0.84 ? 'ladder' : 'estate'
      }

      const fromCol = arterials.cols[col]
      const fromRow = arterials.rows[row]
      const toCol = arterials.cols[col + 1]
      const toRow = arterials.rows[row + 1]

      superblocks.set(key, {
        pattern,
        midCol: Math.round((fromCol + toCol) / 2),
        midRow: Math.round((fromRow + toRow) / 2),
        fromCol,
        fromRow,
        parity: rng() < 0.5 ? 0 : 1,
        // Downtown streets are surveyed; the further out and the looser the pattern, the more they
        // are allowed to follow the ground instead.
        bow: pattern === 'downtown' ? 0.25
          : pattern === 'ladder' ? 0.8
          : pattern === 'organic' ? 2.1
          : pattern === 'radial' ? 1.8
          : 1.6,
        room: occupied.has(key) ? 1 : 2.6,
      })
    }
  }
  return superblocks
}

function buildStreetNetwork(
  blockCols: number,
  blockRows: number,
  cell: number,
  terrain: CityTerrain,
  warp: CityWarp,
  arterials: ArterialRhythm,
  plazas: readonly BlockRef[],
  seed: string,
) {
  const intersections = new Map<string, CityIntersection>()
  for (let row = 0; row <= blockRows; row += 1) {
    for (let col = 0; col <= blockCols; col += 1) {
      const point = warp.node(col, row)
      intersections.set(intersectionId(col, row), {
        id: intersectionId(col, row),
        col,
        row,
        x: point.x,
        z: point.z,
      })
    }
  }

  const context: StreetContext = { warp, cell, terrain, bow: bowField(seed) }
  const ring = ringBoulevard(blockCols, blockRows)
  const isArterialCol = (col: number) => arterials.colSet.has(col)
  const isArterialRow = (row: number) => arterials.rowSet.has(row)

  const superblocks = planSuperblocks(arterials, terrain, seed)
  const superblockAt = (col: number, row: number) =>
    superblocks.get(superblockKey(
      arterialCellIndex(arterials.cols, col),
      arterialCellIndex(arterials.rows, row),
    ))

  /*
   * Which interior streets survive.
   *
   * An arterial is never touched — it is the skeleton the whole map hangs off, and it is also what
   * guarantees the graph stays connected once the interior thins out. Everything else answers to its
   * cell's pattern.
   */
  const keepsThrough = (col: number, row: number) => {
    if (isArterialRow(row)) return true
    const superblock = superblockAt(col, row)
    if (!superblock) return true
    switch (superblock.pattern) {
      case 'open':
        return false
      case 'estate':
        return row === superblock.midRow
      case 'radial':
        // Concentric arcs about the cell's own centre: every other ring, plus the spine.
        return row === superblock.midRow || (row - superblock.fromRow) % 2 === superblock.parity
      case 'organic':
        // The multiplier has to be coprime with 3, or the row term vanishes under the modulus and
        // every row drops the same columns — a straight machine seam through the one pattern whose
        // whole job is to look unsurveyed.
        return (col + row * 2 + superblock.parity) % 3 !== 0
      default:
        return true
    }
  }
  const keepsCross = (col: number, row: number) => {
    if (isArterialCol(col)) return true
    const superblock = superblockAt(col, row)
    if (!superblock) return true
    switch (superblock.pattern) {
      case 'downtown':
        return true
      case 'ladder':
        return col % 2 === superblock.parity
      case 'radial':
        // Spokes out of the cell centre: keep every cross line, so what thins is the rings.
        return true
      case 'organic':
        return (col * 2 + row + superblock.parity) % 3 !== 0
      case 'crescent':
      case 'estate':
        return col === superblock.midCol
      case 'open':
        return false
    }
  }
  const bowScaleAt = (col: number, row: number) => superblockAt(col, row)?.bow ?? 1
  const roomScaleAt = (col: number, row: number) => superblockAt(col, row)?.room ?? 1

  const classify = (
    axis: 'x' | 'z',
    col: number,
    row: number,
    arterial: boolean,
  ): StreetClass => {
    if (ring !== null && onRing(ring, axis, col, row)) return 'boulevard'
    return arterial ? 'arterial' : 'collector'
  }

  /*
   * Which legs the patterns want, before anything is built.
   *
   * Decided as a set first rather than street-by-street, because a pattern can happily strip all four
   * edges off a block and only a view of the whole set can see that it has.
   */
  const through = new Set<string>()
  const cross = new Set<string>()
  for (let row = 0; row <= blockRows; row += 1) {
    for (let col = 0; col < blockCols; col += 1) {
      if (keepsThrough(col, row)) through.add(`${col}:${row}`)
    }
  }
  for (let col = 0; col <= blockCols; col += 1) {
    for (let row = 0; row < blockRows; row += 1) {
      if (keepsCross(col, row)) cross.add(`${col}:${row}`)
    }
  }

  /*
   * Give back any block the patterns stranded, and give it something it can be reached *by*.
   *
   * A block with no bounding street is a building with no door. Restoring a single edge is not
   * enough: in a sparse pattern that edge can touch nothing at either end, which leaves a two-node
   * island in the routing graph, and a lot snapped onto an island has no path to anywhere — the map
   * then falls back to drawing a straight dogleg across the city, through whatever is in the way.
   *
   * So the repair lays a lane along the block's north edge and runs it out to the first junction
   * that is already on the network. A node carrying a cross street is on the network by definition,
   * and arterial columns keep all of theirs, so the walk always terminates. The shorter of the two
   * directions wins, so a stranded block gets a lane that goes somewhere rather than its lattice back.
   */
  const onNetwork = (col: number, row: number) =>
    cross.has(`${col}:${row}`) || cross.has(`${col}:${row - 1}`)
  const reachFrom = (col: number, step: -1 | 1, row: number) => {
    let distance = 0
    for (let c = col; c >= 0 && c <= blockCols; c += step) {
      if (onNetwork(c, row)) return distance
      distance += 1
    }
    return Infinity
  }
  for (const block of terrain.blocks.values()) {
    if (block.use !== 'built' && block.use !== 'facility') continue
    const { col, row } = block
    const edges: Array<[Set<string>, string]> = [
      [through, `${col}:${row}`],
      [through, `${col}:${row + 1}`],
      [cross, `${col}:${row}`],
      [cross, `${col + 1}:${row}`],
    ]
    if (edges.some(([set, key]) => set.has(key))) continue
    through.add(`${col}:${row}`)
    const left = reachFrom(col, -1, row)
    const right = reachFrom(col + 1, 1, row)
    if (left <= right) {
      for (let c = col - left; c < col; c += 1) through.add(`${c}:${row}`)
    } else if (right < Infinity) {
      for (let c = col + 1; c <= col + right; c += 1) through.add(`${c}:${row}`)
    }
  }

  const streets: CityStreet[] = []
  for (let row = 0; row <= blockRows; row += 1) {
    for (let col = 0; col < blockCols; col += 1) {
      if (!through.has(`${col}:${row}`)) continue
      streets.push(
        makeStreet(
          streetIdFor('x', col, row),
          'x',
          { col, row },
          { col: col + 1, row },
          classify('x', col, row, isArterialRow(row)),
          context,
          bowScaleAt(col, row),
          roomScaleAt(col, row),
        ),
      )
    }
  }
  for (let col = 0; col <= blockCols; col += 1) {
    for (let row = 0; row < blockRows; row += 1) {
      if (!cross.has(`${col}:${row}`)) continue
      streets.push(
        makeStreet(
          streetIdFor('z', col, row),
          'z',
          { col, row },
          { col, row: row + 1 },
          classify('z', col, row, isArterialCol(col)),
          context,
          bowScaleAt(col, row),
          roomScaleAt(col, row),
        ),
      )
    }
  }

  for (const avenue of radialAvenues(blockCols, blockRows, arterials, plazas, terrain, seed)) {
    streets.push(
      makeStreet(
        `street:d:${avenue.from.col}:${avenue.from.row}:${avenue.to.col}:${avenue.to.row}`,
        'd',
        avenue.from,
        avenue.to,
        'avenue',
        context,
      ),
    )
  }

  const kept = pruneJunctions(streets, blockCols, blockRows, arterials, seed)

  /*
   * Drop the junctions nothing meets at any more.
   *
   * Thinning the interior leaves lattice nodes in the middle of a park with no street touching them.
   * Left in place they are unreachable islands in the routing graph, and `nearestIntersectionId`
   * would happily snap a route onto one and then fail to path out of it. A node that no street uses
   * is not a junction, so it does not survive as one.
   */
  const used = new Set<string>()
  for (const street of kept) {
    used.add(street.fromId)
    used.add(street.toId)
  }
  for (const id of [...intersections.keys()]) {
    if (!used.has(id)) intersections.delete(id)
  }

  return { intersections, streets: kept }
}

/** Street widths per class. Cartography, not evidence. */
const STREET_CLASS_WIDTH: Readonly<Record<StreetClass, number>> = {
  collector: STREET_WIDTH,
  arterial: ARTERIAL_WIDTH,
  boulevard: 26,
  avenue: 24,
  riverside: STREET_WIDTH * 1.1,
}

/**
 * How far each class would like to wander off the straight line between its endpoints, as a fraction
 * of the street corridor.
 *
 * A wish, not a guarantee: {@link streetBow} then holds it inside {@link SAFE_ROAD_SPAN}. The result
 * is that narrow streets wander freely and wide ones stay engineered and straight, which is both what
 * the geometry allows and what real cities look like.
 */
const STREET_CLASS_BOW: Readonly<Record<StreetClass, number>> = {
  collector: 0.42,
  arterial: 0.2,
  boulevard: 0.3,
  // A diagonal is a deliberate cut across the grid. Bending it would only blur what it is for.
  avenue: 0,
  riverside: 0.16,
}

/**
 * The bow a street actually gets: what its class wants, scaled by its cell's pattern, and then
 * clipped to what its width leaves room for.
 *
 * `roomScale` is the one part that is not taste. The clip exists so a wandering centre line can never
 * reach a building, and it assumes every block is built. A cell with nothing in it has no building to
 * hit, so it can lend the street most of its cell and curve properly.
 */
function streetBow(
  streetClass: StreetClass,
  width: number,
  field: BowField,
  x: number,
  z: number,
  bowScale = 1,
  roomScale = 1,
): number {
  const room = Math.max(0, SAFE_ROAD_SPAN * roomScale - width / 2)
  const wanted = STREET_CLASS_BOW[streetClass] * STREET_WIDTH * bowScale
  return bowAt(field, x, z) * Math.min(wanted, room)
}

/** Samples along a bowed street. Six segments is the point where the arc stops reading as a chevron. */
const STREET_CURVE_SAMPLES = 6

/** Below this bow, in world units, a street is drawn as the straight line it effectively is. */
const STRAIGHT_ENOUGH = 0.2

interface BowField {
  readonly frequencyX: number
  readonly frequencyZ: number
  readonly phaseX: number
  readonly phaseZ: number
}

/**
 * A slowly varying field that decides which way each street bows.
 *
 * Bowing every leg independently produces a noodle. Sampling a coherent field at the leg's midpoint
 * instead makes neighbouring legs agree, so a whole corridor drifts the same way and the grid reads
 * as a city laid over rolling ground rather than as a wobble effect.
 */
function bowField(seed: string): BowField {
  const rng = mulberry32(stableHash(`${seed}::bow`))
  return {
    frequencyX: 0.0022 + rng() * 0.0026,
    frequencyZ: 0.0022 + rng() * 0.0026,
    phaseX: rng() * Math.PI * 2,
    phaseZ: rng() * Math.PI * 2,
  }
}

function bowAt(field: BowField, x: number, z: number): number {
  return (
    Math.sin(x * field.frequencyX + field.phaseX) * Math.cos(z * field.frequencyZ + field.phaseZ)
  )
}

/** Everything a street needs to know about the city it is being drawn in. */
interface StreetContext {
  readonly warp: CityWarp
  readonly cell: number
  readonly terrain: CityTerrain
  readonly bow: BowField
}

/** Where along a street the water is checked. Endpoints included — see {@link makeStreet}. */
const WATER_SAMPLES = [0, 0.25, 0.5, 0.75, 1] as const

/**
 * How parallel a street must be to the current to count as running with it rather than across it.
 *
 * Comfortably above `cos 45° = 0.7071`, so a diagonal avenue meeting an axis-aligned reach of river is
 * always read as the crossing it is.
 */
const RUNS_WITH_FLOW = 0.82

function makeStreet(
  id: string,
  axis: 'x' | 'z' | 'd',
  from: BlockRef,
  to: BlockRef,
  proposed: StreetClass,
  context: StreetContext,
  bowScale = 1,
  roomScale = 1,
): CityStreet {
  const { warp, terrain, bow: field } = context
  const start = warp.node(from.col, from.row)
  const end = warp.node(to.col, to.row)
  const fromX = start.x
  const fromZ = start.z
  const toX = end.x
  const toZ = end.z
  const midX = (fromX + toX) / 2
  const midZ = (fromZ + toZ) / 2

  const length = Math.hypot(toX - fromX, toZ - fromZ)
  const unitX = length < 1e-9 ? 1 : (toX - fromX) / length
  const unitZ = length < 1e-9 ? 0 : (toZ - fromZ) / length
  // Left-hand normal of the direction of travel.
  const normal = { x: -unitZ, z: unitX }

  // The river is routed along block boundaries, which is to say along street corridors. So a street
  // that runs *with* the flow is submerged along its whole length and becomes an embankment, while a
  // street that runs *across* the flow only meets the water at the junction it shares with the
  // riverbank — its midpoint is a full half-block clear. Sampling the endpoints as well as the middle
  // is therefore the only way a crossing is ever seen at all.
  const alongFlow = riverAt(terrain, midX, midZ)
  let streetClass = proposed
  let bridge = false
  if (
    alongFlow !== null &&
    Math.abs(alongFlow.tangent.x * unitX + alongFlow.tangent.z * unitZ) > RUNS_WITH_FLOW
  ) {
    streetClass = 'riverside'
  } else {
    bridge = WATER_SAMPLES.some(t =>
      riverAt(terrain, fromX + (toX - fromX) * t, fromZ + (toZ - fromZ) * t) !== null)
  }

  const width = STREET_CLASS_WIDTH[streetClass]
  let path: Point[]
  if (streetClass === 'riverside' && alongFlow !== null) {
    const side = pickBank(context, from, axis, midX, midZ)
    path = embankmentPath(
      { x: fromX, z: fromZ },
      { x: toX, z: toZ },
      normal,
      Math.min(alongFlow.halfWidth + width * 0.6, bankRoom(context, side.open, width)),
      side.sign,
    )
  } else if (bridge) {
    // A deck is a straight structure. Bowing one would read as a mistake rather than as a curve.
    path = [{ x: fromX, z: fromZ }, { x: toX, z: toZ }]
  } else {
    path = bowedPath(
      { x: fromX, z: fromZ },
      { x: toX, z: toZ },
      normal,
      streetBow(streetClass, width, field, midX, midZ, bowScale, roomScale),
    )
  }

  return {
    id,
    fromId: intersectionId(from.col, from.row),
    toId: intersectionId(to.col, to.row),
    streetClass,
    axis,
    width,
    fromX,
    fromZ,
    toX,
    toZ,
    path,
    bridge,
  }
}

/**
 * How far a road's centre line may leave its corridor on a given bank without touching a building.
 *
 * On a built bank that is {@link SAFE_ROAD_SPAN} less half the carriageway. An open block has no
 * building to hit, so it lends most of its cell and the embankment can get properly clear of the
 * water.
 */
function bankRoom(context: StreetContext, open: boolean, width: number): number {
  const limit = open ? STREET_WIDTH / 2 + context.cell * 0.42 : SAFE_ROAD_SPAN
  return Math.max(0, limit - width / 2)
}

/**
 * Which bank an embankment road runs along: the open one where there is a choice, so the road takes
 * the park side rather than squeezing between the water and a building.
 */
function pickBank(
  context: StreetContext,
  from: BlockRef,
  axis: 'x' | 'z' | 'd',
  midX: number,
  midZ: number,
): { sign: 1 | -1; open: boolean } {
  const built = (col: number, row: number) => {
    const block = context.terrain.blocks.get(terrainBlockKey(col, row))
    return block === undefined || block.use === 'built' || block.use === 'facility'
  }
  // An 'x' street runs toward +x, so its left-hand normal points toward +z and the block on that side
  // is the one sharing the street's row; the right-hand side is the row above. A 'z' street runs
  // toward +z, so its left-hand normal points toward -x. A diagonal has no clean pair, so it is
  // treated as built on both sides and keeps the cautious offset.
  const left =
    axis === 'x' ? built(from.col, from.row) : axis === 'z' ? built(from.col - 1, from.row) : true
  const right =
    axis === 'x' ? built(from.col, from.row - 1) : axis === 'z' ? built(from.col, from.row) : true
  if (left !== right) return { sign: left ? -1 : 1, open: true }
  const sign: 1 | -1 = bowAt(context.bow, midX, midZ) >= 0 ? 1 : -1
  return { sign, open: !left }
}

function riverAt(
  terrain: CityTerrain,
  x: number,
  z: number,
): { halfWidth: number; tangent: Point } | null {
  if (terrain.river.length < 2) return null
  const near = riverProximity(terrain.river, x, z)
  return near.distance < near.halfWidth ? { halfWidth: near.halfWidth, tangent: near.tangent } : null
}

/** Quadratic arc from `from` to `to`, pushed `offset` world units along `normal` at its midpoint. */
function bowedPath(from: Point, to: Point, normal: Point, offset: number): Point[] {
  if (Math.abs(offset) < STRAIGHT_ENOUGH) return [from, to]
  const controlX = (from.x + to.x) / 2 + normal.x * offset * 2
  const controlZ = (from.z + to.z) / 2 + normal.z * offset * 2
  const path: Point[] = []
  for (let step = 0; step <= STREET_CURVE_SAMPLES; step += 1) {
    const t = step / STREET_CURVE_SAMPLES
    const inverse = 1 - t
    path.push({
      x: inverse * inverse * from.x + 2 * inverse * t * controlX + t * t * to.x,
      z: inverse * inverse * from.z + 2 * inverse * t * controlZ + t * t * to.z,
    })
  }
  return path
}

/**
 * An embankment road: leave the junction, run along one bank, rejoin at the far junction.
 *
 * The endpoints stay exactly on their intersections, so the graph is untouched and the road still
 * connects; only the middle steps aside to keep the carriageway out of the water.
 */
function embankmentPath(from: Point, to: Point, normal: Point, offset: number, side: 1 | -1): Point[] {
  const shift = { x: normal.x * offset * side, z: normal.z * offset * side }
  const path: Point[] = [from]
  for (let step = 1; step < STREET_CURVE_SAMPLES; step += 1) {
    const t = step / STREET_CURVE_SAMPLES
    // Ease the shift in and out so the slip joins read as a curve rather than a kink.
    const ease = Math.sin(Math.PI * t)
    path.push({
      x: from.x + (to.x - from.x) * t + shift.x * ease,
      z: from.z + (to.z - from.z) * t + shift.z * ease,
    })
  }
  path.push(to)
  return path
}

interface RingBounds {
  readonly minCol: number
  readonly maxCol: number
  readonly minRow: number
  readonly maxRow: number
}

/** The inset rectangle the ring boulevard follows, or null when the grid is too small to hold one. */
function ringBoulevard(blockCols: number, blockRows: number): RingBounds | null {
  const side = Math.min(blockCols, blockRows)
  if (side < 8) return null
  const inset = Math.max(2, Math.round(side * 0.26))
  if (blockCols - inset <= inset || blockRows - inset <= inset) return null
  return { minCol: inset, maxCol: blockCols - inset, minRow: inset, maxRow: blockRows - inset }
}

function onRing(ring: RingBounds, axis: 'x' | 'z', col: number, row: number): boolean {
  if (axis === 'x') {
    return (
      (row === ring.minRow || row === ring.maxRow) && col >= ring.minCol && col < ring.maxCol
    )
  }
  return (col === ring.minCol || col === ring.maxCol) && row >= ring.minRow && row < ring.maxRow
}

/**
 * Avenues that arrive somewhere, as real edges between existing junctions.
 *
 * A diagonal drawn across a lattice for its own sake is just a line on graph paper at 45°. What makes
 * an avenue read as an avenue is that it *goes* to a place: spokes converging on a square are the
 * single most recognisable non-grid feature a city map has, and they are why you can find Place de
 * l'Étoile on a map with the labels off.
 *
 * So every square gets spokes running out of it, and — on a city with room — one long cross-town
 * diagonal that is not attached to any square, because a real city also has the one road that was
 * there before the plan.
 *
 * Each edge is `sqrt(2)` block pitches long against the two pitches of the lattice legs it parallels,
 * so Dijkstra prefers it and a route across town genuinely takes the avenue.
 *
 * An avenue cuts corner-to-corner *through* a block, so it may only cross ground the plan left empty.
 * Where a built block stands in the way the edge is dropped and the walk continues past it: the
 * avenue is interrupted, routes fall back to the lattice for that stretch, and no carriageway is ever
 * drawn through a measured building.
 */
function radialAvenues(
  blockCols: number,
  blockRows: number,
  arterials: ArterialRhythm,
  plazas: readonly BlockRef[],
  terrain: CityTerrain,
  seed: string,
): Array<{ from: BlockRef; to: BlockRef }> {
  const side = Math.min(blockCols, blockRows)
  if (side < 6) return []
  const rng = mulberry32(stableHash(`${seed}::avenues`))
  const edges: Array<{ from: BlockRef; to: BlockRef }> = []
  const seen = new Set<string>()

  const crossable = (col: number, row: number, stepCol: 1 | -1, stepRow: 1 | -1) => {
    // The block an edge cuts through is the one at the lower corner of the pair it spans.
    const block = terrain.blocks.get(
      terrainBlockKey(stepCol === 1 ? col : col - 1, stepRow === 1 ? row : row - 1),
    )
    return block !== undefined && block.use !== 'built' && block.use !== 'facility'
  }

  const walk = (
    startCol: number,
    startRow: number,
    stepCol: 1 | -1,
    stepRow: 1 | -1,
    limit: number,
  ) => {
    let col = startCol
    let row = startRow
    for (let step = 0; step < limit; step += 1) {
      const nextCol = col + stepCol
      const nextRow = row + stepRow
      if (nextCol < 0 || nextCol > blockCols || nextRow < 0 || nextRow > blockRows) break
      const key = `${Math.min(col, nextCol)}:${Math.min(row, nextRow)}:${stepCol === stepRow ? 'a' : 'b'}`
      if (!seen.has(key) && crossable(col, row, stepCol, stepRow)) {
        seen.add(key)
        edges.push({ from: { col, row }, to: { col: nextCol, row: nextRow } })
      }
      col = nextCol
      row = nextRow
    }
  }

  /*
   * Spokes reach until they hit an arterial, so an avenue ends at a road rather than fizzling out
   * mid-block. Two blocks minimum, otherwise a square in a tight corner gets four stubs.
   */
  const reach = (from: number, step: 1 | -1, lines: readonly number[]) => {
    for (const line of step === 1 ? lines : [...lines].reverse()) {
      if (step === 1 ? line > from : line < from) return Math.abs(line - from)
    }
    return 0
  }

  for (const plaza of plazas) {
    for (const [stepCol, stepRow] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const limit = Math.min(
        reach(plaza.col, stepCol, arterials.cols),
        reach(plaza.row, stepRow, arterials.rows),
      )
      if (limit >= 2) walk(plaza.col, plaza.row, stepCol, stepRow, limit)
    }
  }

  // The one road that predates the plan. Skipped on a small city, where it would be most of the map.
  if (side >= 10) {
    const startRow = Math.floor(rng() * Math.max(1, blockRows - side + 1))
    walk(0, startRow, 1, 1, blockCols + blockRows)
  }
  return edges
}

/**
 * Turn four-way junctions into T-junctions and cul-de-sacs, until the city stops being a lattice.
 *
 * This is the change that matters most, and it is not a geometric one. Boeing's survey of 27,000 real
 * street networks (*A Multi-Scale Analysis of Urban Street Networks*, 2018) measures what the eye is
 * actually reading when it calls something a grid:
 *
 * | | lattice | measured cities |
 * | --- | --- | --- |
 * | four-way junctions | ~100% | ~23% |
 * | T-junctions | ~0% | ~57% |
 * | dead ends | ~0% | ~15% |
 * | mean junction degree | 4.0 | 2.7–3.0 |
 *
 * Curving a street between two junctions does not move either junction, so a curved lattice is still
 * a lattice with 100% four-way junctions — which is exactly why the previous attempt at this read as
 * a wiggly grid. Removing one edge between two four-way junctions converts *both* into T-junctions,
 * so the distribution moves twice as fast as the edge count falls.
 *
 * Three things are never done, in priority order over the target distribution:
 *
 * 1. An arterial is never cut. It is the skeleton, and it is what keeps the graph connected.
 * 2. The graph is never disconnected. Every removal is checked by walking from one end to the other.
 * 3. A block is never left without a bounding street, or the building on it has nowhere to be entered
 *    from. {@link rebindFrontages} then repoints each door at whichever edge survived.
 */
const DEGREE4_TARGET = 0.25
const DEAD_END_TARGET = 0.14

function pruneJunctions(
  streets: readonly CityStreet[],
  blockCols: number,
  blockRows: number,
  arterials: ArterialRhythm,
  seed: string,
): CityStreet[] {
  const degree = new Map<string, number>()
  const neighbours = new Map<string, Set<string>>()
  const link = (a: string, b: string) => {
    degree.set(a, (degree.get(a) ?? 0) + 1)
    const list = neighbours.get(a)
    if (list) list.add(b)
    else neighbours.set(a, new Set([b]))
  }
  for (const street of streets) {
    link(street.fromId, street.toId)
    link(street.toId, street.fromId)
  }

  /*
   * How many streets still bound each block.
   *
   * A block is bounded by the through street on its own row and the one on the row below, plus the
   * cross street on its own column and the one on the column to its right. Avenues cut across blocks
   * rather than round them, so they are not frontage and do not count.
   */
  const bounding = new Map<string, number>()
  const boundedBy = (street: CityStreet): string[] => {
    const [, axis, first, second] = street.id.split(':')
    if (axis !== 'x' && axis !== 'z') return []
    const col = Number(first)
    const row = Number(second)
    const blocks = axis === 'x'
      ? [[col, row], [col, row - 1]]
      : [[col, row], [col - 1, row]]
    return blocks
      .filter(([c, r]) => c >= 0 && r >= 0 && c < blockCols && r < blockRows)
      .map(([c, r]) => blockKey(c, r))
  }
  for (const street of streets) {
    for (const key of boundedBy(street)) bounding.set(key, (bounding.get(key) ?? 0) + 1)
  }

  const isArterial = (street: CityStreet) => {
    if (street.streetClass !== 'collector') return true
    const [, axis, first, second] = street.id.split(':')
    if (axis === 'x') return arterials.rowSet.has(Number(second))
    if (axis === 'z') return arterials.colSet.has(Number(first))
    return true
  }

  /** Is `to` still reachable from `from`? The edge under test has already been unlinked. */
  const connected = (from: string, to: string): boolean => {
    const visited = new Set([from])
    const queue = [from]
    let head = 0
    let budget = 6000
    while (head < queue.length && budget > 0) {
      const at = queue[head]
      head += 1
      if (at === to) return true
      budget -= 1
      for (const next of neighbours.get(at) ?? []) {
        if (visited.has(next)) continue
        visited.add(next)
        queue.push(next)
      }
    }
    // Out of budget means "could not prove it is safe", which is the answer that keeps a road.
    return false
  }

  const unlink = (a: string, b: string) => {
    degree.set(a, (degree.get(a) ?? 1) - 1)
    neighbours.get(a)?.delete(b)
  }

  const removed = new Set<string>()
  const rng = mulberry32(stableHash(`${seed}::prune`))
  const candidates = seededShuffle(streets.filter(street => !isArterial(street)), rng)

  const junctionCount = () => degree.size
  const countDegree = (predicate: (value: number) => boolean) => {
    let total = 0
    for (const value of degree.values()) if (predicate(value)) total += 1
    return total
  }

  /*
   * Pass one: the T-junctions.
   *
   * Only edges whose *both* ends are four-way are cut, because those are the removals that buy two
   * T-junctions for one street. Cutting an edge at a node that is already a T would make a dead end,
   * which is the next pass's job and has a much smaller budget.
   */
  const total = junctionCount()
  for (const street of candidates) {
    if (countDegree(value => value >= 4) <= total * DEGREE4_TARGET) break
    if ((degree.get(street.fromId) ?? 0) < 4 || (degree.get(street.toId) ?? 0) < 4) continue
    const blocks = boundedBy(street)
    if (blocks.some(key => (bounding.get(key) ?? 0) <= 1)) continue
    unlink(street.fromId, street.toId)
    unlink(street.toId, street.fromId)
    if (!connected(street.fromId, street.toId)) {
      link(street.fromId, street.toId)
      link(street.toId, street.fromId)
      continue
    }
    removed.add(street.id)
    for (const key of blocks) bounding.set(key, (bounding.get(key) ?? 1) - 1)
  }

  /*
   * Pass two: the dead ends.
   *
   * A cul-de-sac is a street that stops. So this pass does the opposite of the first one — it cuts an
   * edge at a node that is *already* down to two, leaving a stub — and it deliberately does not check
   * connectivity for the stub end, because a stub is meant to be a leaf.
   */
  for (const street of candidates) {
    if (removed.has(street.id)) continue
    if (countDegree(value => value === 1) >= total * DEAD_END_TARGET) break
    const fromDegree = degree.get(street.fromId) ?? 0
    const toDegree = degree.get(street.toId) ?? 0
    // Exactly one end must be about to become a leaf; the other must have streets to spare.
    const leafEnd = fromDegree === 2 && toDegree >= 3 ? street.fromId
      : toDegree === 2 && fromDegree >= 3 ? street.toId
      : null
    if (leafEnd === null) continue
    const other = leafEnd === street.fromId ? street.toId : street.fromId
    const blocks = boundedBy(street)
    if (blocks.some(key => (bounding.get(key) ?? 0) <= 1)) continue
    unlink(street.fromId, street.toId)
    unlink(street.toId, street.fromId)
    if (!connected(leafEnd, other)) {
      link(street.fromId, street.toId)
      link(street.toId, street.fromId)
      continue
    }
    removed.add(street.id)
    for (const key of blocks) bounding.set(key, (bounding.get(key) ?? 1) - 1)
  }

  return streets.filter(street => !removed.has(street.id))
}

/**
 * Hang every door on a street that still exists, at a point the carriageway actually passes.
 *
 * Two things make this necessary, and both of them only become knowable after the network settles.
 *
 * First, {@link placeLot} fronts a building on the street along its block's north edge, because at
 * the time lots are placed there is always one there. {@link pruneJunctions} then removes streets,
 * and the one a building was fronting may be among them — leaving a door opening onto nothing and a
 * route that ends at a kerb no carriageway runs along. The guarantee that at least one of a block's
 * four edges survives is enforced in the prune itself, which refuses to take a block's last one.
 *
 * Second, a street's drawn path is bowed, and on a strongly curved leg the carriageway is nowhere
 * near the straight-line midpoint of its two junctions. So the door is placed on the *drawn* path,
 * which is the road you can see, rather than on the chord between the junctions, which is not.
 *
 * This is also what makes a pruned city read correctly rather than merely differently: on a street
 * that lost its opposite number, the buildings turn to face the one that is left, exactly as a real
 * terrace does.
 */
function rebindFrontages(lots: Map<string, CityLot>, streets: readonly CityStreet[]): void {
  const byId = new Map(streets.map(street => [street.id, street]))
  for (const [objectId, lot] of lots) {
    const { blockCol: col, blockRow: row } = lot
    const options: Array<{ id: string; facing: Facing }> = [
      { id: streetIdFor('x', col, row), facing: 'north' },
      { id: streetIdFor('x', col, row + 1), facing: 'south' },
      { id: streetIdFor('z', col, row), facing: 'west' },
      { id: streetIdFor('z', col + 1, row), facing: 'east' },
    ]

    let best: { id: string; kerb: Point; facing: Facing } | null = null
    let bestDistance = Infinity
    for (const option of options) {
      const street = byId.get(option.id)
      if (!street) continue
      const kerb = nearestOnPath(street.path, lot.x, lot.z)
      const distance = Math.hypot(kerb.x - lot.x, kerb.z - lot.z)
      // Ties broken by id so the choice never depends on option order changing.
      if (distance < bestDistance || (distance === bestDistance && option.id < (best?.id ?? ''))) {
        bestDistance = distance
        best = { id: option.id, kerb, facing: option.facing }
      }
    }
    // No bounding street at all should be impossible, but a lot with a stale door is worse than one
    // that keeps the kerb it was given, so the fallback is to leave it alone.
    if (!best) continue

    lots.set(objectId, {
      ...lot,
      facing: best.facing,
      frontageStreetId: best.id,
      accessX: best.kerb.x,
      accessZ: best.kerb.z,
      rotationY: Math.atan2(best.kerb.x - lot.x, best.kerb.z - lot.z),
    })
  }
}

/** The point on a polyline closest to a world position. */
function nearestOnPath(path: readonly Point[], x: number, z: number): Point {
  let best: Point = path[0] ?? { x, z }
  let bestDistance = Infinity
  for (let index = 0; index + 1 < path.length; index += 1) {
    const from = path[index]
    const to = path[index + 1]
    const dx = to.x - from.x
    const dz = to.z - from.z
    const lengthSquared = dx * dx + dz * dz
    const t = lengthSquared < 1e-9
      ? 0
      : clamp(((x - from.x) * dx + (z - from.z) * dz) / lengthSquared, 0, 1)
    const point = { x: from.x + dx * t, z: from.z + dz * t }
    const distance = Math.hypot(point.x - x, point.z - z)
    if (distance < bestDistance) {
      bestDistance = distance
      best = point
    }
  }
  return best
}

/**
 * Adjacency for route finding, costed by the length actually driven.
 *
 * Using the drawn path rather than the straight endpoint distance is what makes the diagonals honest:
 * an avenue is preferred because it really is shorter, and a bowed collector costs the little extra
 * that its curve adds, so the route the map draws is the route the map costed.
 */
function adjacency(plan: CityPlan): Map<string, Array<{ toId: string; cost: number }>> {
  const cached = adjacencyCache.get(plan)
  if (cached) return cached

  const map = new Map<string, Array<{ toId: string; cost: number }>>()
  const add = (fromId: string, toId: string, cost: number) => {
    const list = map.get(fromId)
    if (list) list.push({ toId, cost })
    else map.set(fromId, [{ toId, cost }])
  }
  for (const street of plan.streets) {
    const cost = pathLength(street.path)
    add(street.fromId, street.toId, cost)
    add(street.toId, street.fromId, cost)
  }
  adjacencyCache.set(plan, map)
  return map
}

const adjacencyCache = new WeakMap<CityPlan, Map<string, Array<{ toId: string; cost: number }>>>()

const geometryCache = new WeakMap<CityPlan, Map<string, readonly Point[]>>()

/** Drawn centre lines keyed by ordered intersection pair, so a leg can be walked either way. */
function streetGeometry(plan: CityPlan): Map<string, readonly Point[]> {
  const cached = geometryCache.get(plan)
  if (cached) return cached

  const map = new Map<string, readonly Point[]>()
  for (const street of plan.streets) {
    const forward = `${street.fromId}>${street.toId}`
    // The lattice and an avenue can both connect a pair; the first one wins, deterministically,
    // because street order is itself deterministic.
    if (!map.has(forward)) map.set(forward, street.path)
    const backward = `${street.toId}>${street.fromId}`
    if (!map.has(backward)) map.set(backward, [...street.path].reverse())
  }
  geometryCache.set(plan, map)
  return map
}

function pathLength(path: readonly Point[]): number {
  let total = 0
  for (let index = 1; index < path.length; index += 1) {
    total += Math.hypot(path[index].x - path[index - 1].x, path[index].z - path[index - 1].z)
  }
  return total
}

function intersectionId(col: number, row: number): string {
  return `x${col}:z${row}`
}

function streetIdFor(axis: 'x' | 'z', col: number, row: number): string {
  return `street:${axis}:${col}:${row}`
}

function dedupePoints(points: Array<{ x: number; z: number }>): Array<{ x: number; z: number }> {
  const result: Array<{ x: number; z: number }> = []
  for (const point of points) {
    const last = result[result.length - 1]
    if (last && Math.abs(last.x - point.x) < 0.001 && Math.abs(last.z - point.z) < 0.001) continue
    result.push(point)
  }
  return result
}

function pageCount(value: string | null): number | null {
  if (value === null) return null
  let parsed: bigint
  try {
    parsed = BigInt(value)
  } catch {
    return null
  }
  return parsed < 0n ? 0 : Number(parsed)
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

