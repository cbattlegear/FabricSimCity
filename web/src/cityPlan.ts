import { stableHash } from './atlasLayout'
import { FACILITY_LABELS, FACILITY_ORDER, type FacilityKind, type FacilitySite } from './cityInfrastructure'
import { mulberry32, seededShuffle } from './citySeed'
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

export function planCity(
  objects: readonly DatabaseCityObject[],
  options: CityPlanOptions = {},
): CityPlan {
  const cell = chooseCell(objects)
  const pitchX = BLOCK_COLS * cell + STREET_WIDTH
  const pitchZ = BLOCK_ROWS * cell + STREET_WIDTH

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

  // One generator for the whole plan: facilities draw first, buildings take what is left. Both read
  // from the same stream, so the seed alone determines the entire city.
  const rng = mulberry32(stableHash(options.seed ?? 'sqlsimcity'))
  const facilityBlocks = placeFacilities(blockCols, blockRows, rng)
  const facilityKeys = new Set(facilityBlocks.map(block => blockKey(block.col, block.row)))

  const freeBlocks = allBlocks(blockCols, blockRows).filter(
    block => !facilityKeys.has(blockKey(block.col, block.row)),
  )
  const shuffled = seededShuffle(freeBlocks, rng)

  // Territories grow in reading order and are then shuffled, so a schema's tables spread through
  // their own neighbourhood instead of packing against its seed and leaving the outskirts bare.
  const territories = planNeighborhoods(freeBlocks, sizes, rng, options.seed ?? 'sqlsimcity')
  const addresses = new Map<string, BlockRef[]>()
  for (const [schemaId, blocks] of territories) addresses.set(schemaId, seededShuffle(blocks, rng))

  const lots = new Map<string, CityLot>()
  const occupied = new Set<string>()
  for (const object of ordered) {
    const territory = addresses.get(object.schemaId)
    const block = territory && territory.length > 0
      ? territory[objectOrdinal(object) % territory.length]
      : shuffled[(slots.get(object.objectId) ?? 0) % shuffled.length]
    lots.set(object.objectId, placeLot(object, block, cell, pitchX, pitchZ))
    occupied.add(terrainBlockKey(block.col, block.row))
  }

  const districts = describeDistricts(ordered, lots, territories, cell, pitchX, pitchZ)
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
    districtIds: districts.map(district => district.districtId),
    superblock: ARTERIAL_EVERY,
    seed: options.seed ?? 'sqlsimcity',
  })

  const { intersections, streets } = buildStreetNetwork(
    blockCols,
    blockRows,
    pitchX,
    pitchZ,
    cell,
    terrain,
    options.seed ?? 'sqlsimcity',
  )

  return {
    cell,
    streetWidth: STREET_WIDTH,
    blockCols,
    blockRows,
    districts,
    lots,
    intersections,
    streets,
    bounds: cityBounds(blockCols, blockRows, pitchX, pitchZ),
    terrain,
    facilities: facilitySites(facilityBlocks, cell, pitchX, pitchZ),
  }
}

/**
 * Spacing of the street corridors: the grain every road in the city runs on.
 *
 * Exposed because a curved road can only be identified with the leg it belongs to by quantising to
 * this, not by rounding its coordinates.
 */
export function streetPitch(plan: Pick<CityPlan, 'cell'>): { x: number; z: number } {
  return { x: BLOCK_COLS * plan.cell + STREET_WIDTH, z: BLOCK_ROWS * plan.cell + STREET_WIDTH }
}

/** Grid id of the intersection nearest a world point, for entering the street graph. */
export function nearestIntersectionId(plan: CityPlan, x: number, z: number): string {
  const { x: pitchX, z: pitchZ } = streetPitch(plan)
  const col = clamp(Math.round(x / pitchX), 0, plan.blockCols)
  const row = clamp(Math.round(z / pitchZ), 0, plan.blockRows)
  return intersectionId(col, row)
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
  pitchX: number,
  pitchZ: number,
): Map<FacilityKind, FacilitySite> {
  const sites = new Map<FacilityKind, FacilitySite>()
  FACILITY_ORDER.forEach((kind, index) => {
    const block = blocks[index]
    if (!block) return
    sites.set(kind, {
      kind,
      label: FACILITY_LABELS[kind],
      x: block.col * pitchX + STREET_WIDTH / 2 + cell / 2,
      z: block.row * pitchZ + STREET_WIDTH / 2 + cell / 2,
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
  cell: number,
  pitchX: number,
  pitchZ: number,
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

  const half = cell / 2
  return [...groups.entries()]
    .sort((left, right) => left[1].ordinal - right[1].ordinal || compareOrdinal(left[0], right[0]))
    .map(([districtId, group]) => {
      const blocks = territories.get(districtId) ?? []
      const box = blocks.length > 0
        ? {
            minX: Math.min(...blocks.map(block => block.col)) * pitchX,
            maxX: (Math.max(...blocks.map(block => block.col)) + 1) * pitchX,
            minZ: Math.min(...blocks.map(block => block.row)) * pitchZ,
            maxZ: (Math.max(...blocks.map(block => block.row)) + 1) * pitchZ,
          }
        : {
            minX: Math.min(...group.lots.map(lot => lot.x)) - half,
            maxX: Math.max(...group.lots.map(lot => lot.x)) + half,
            minZ: Math.min(...group.lots.map(lot => lot.z)) - half,
            maxZ: Math.max(...group.lots.map(lot => lot.z)) + half,
          }
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
        labelX: blocks.length > 0
          ? average(blocks.map(block => block.col * pitchX + STREET_WIDTH / 2 + cell / 2))
          : average(group.lots.map(lot => lot.x)),
        labelZ: blocks.length > 0
          ? average(blocks.map(block => block.row * pitchZ + STREET_WIDTH / 2 + cell / 2))
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
  pitchX: number,
  pitchZ: number,
): CityLot {
  const x = block.col * pitchX + STREET_WIDTH / 2 + cell / 2
  const z = block.row * pitchZ + STREET_WIDTH / 2 + cell / 2

  // One lot per block, so the building fronts the street along its block's north edge and the other
  // three sides are open street too. There is no back row to face the other way.
  const facing: Facing = 'north'
  const kerbZ = block.row * pitchZ

  return {
    objectId: object.objectId,
    districtId: object.schemaId,
    blockId: `block/${block.col}-${block.row}`,
    x,
    z,
    rotationY: Math.PI,
    facing,
    accessX: x,
    accessZ: kerbZ,
    frontageStreetId: streetIdFor('x', block.col, block.row),
    lotSize: cell,
    footprint: buildingFootprint(object.reservedPages8KiB),
    height: buildingHeight(object.usedPages8KiB),
    archetype: buildingArchetype(object),
    seed: stableHash(object.objectId),
  }
}

function cityBounds(
  blockCols: number,
  blockRows: number,
  pitchX: number,
  pitchZ: number,
): CityBounds {
  const maxX = blockCols * pitchX
  const maxZ = blockRows * pitchZ
  return {
    minX: 0,
    maxX,
    minZ: 0,
    maxZ,
    centerX: maxX / 2,
    centerZ: maxZ / 2,
    width: maxX,
    depth: maxZ,
  }
}

/**
 * The street network: the block lattice, plus the roads that stop it reading as graph paper.
 *
 * Four things happen here, in this order, and only the first one existed before:
 *
 * 1. **The lattice.** A road on every block boundary, so each building is still ringed by street.
 *    Arterials fall on a fixed rhythm — every {@link ARTERIAL_EVERY} lines, plus the city boundary —
 *    which gives the map a major-road structure without pretending road hierarchy is measured.
 * 2. **A ring boulevard**, reclassified from the lattice edges on an inset rectangle, drawn wider and
 *    rounded at the corners.
 * 3. **Diagonal avenues**, which are genuinely new edges between existing lattice nodes. Because they
 *    are shorter than the two lattice legs they replace, `streetPath` really does route over them —
 *    the diagonals are a road network, not a drawing.
 * 4. **Embankment roads and bridges**, decided by whether a street runs with the river or across it.
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
  /** One lane in each direction through the middle of an otherwise undivided parcel. */
  | 'estate'
  /** No interior streets whatsoever. The whole cell is one parcel: park, water, or a big-box site. */
  | 'open'

interface Superblock {
  readonly pattern: SuperblockPattern
  /** The interior line that carries the cell's spine, for the patterns that have one. */
  readonly midCol: number
  readonly midRow: number
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
 * The one rule that is not aesthetic: a cell holding a building may never be given a pattern that
 * drops through streets, because {@link placeLot} fronts every building on the street along its
 * block's north edge and that street has to exist. So the empty cells — and on a typical instance
 * that is nearly half of them — are the ones free to become parkland and undivided parcels, which is
 * exactly where a real town puts them too.
 */
function planSuperblocks(
  blockCols: number,
  blockRows: number,
  terrain: CityTerrain,
  seed: string,
): Map<string, Superblock> {
  const cols = Math.max(1, Math.ceil(blockCols / ARTERIAL_EVERY))
  const rows = Math.max(1, Math.ceil(blockRows / ARTERIAL_EVERY))
  const occupied = new Set<string>()
  for (const block of terrain.blocks.values()) {
    if (block.use !== 'built' && block.use !== 'facility') continue
    occupied.add(superblockKey(Math.floor(block.col / ARTERIAL_EVERY), Math.floor(block.row / ARTERIAL_EVERY)))
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
      } else if (radius < 0.34) {
        // The middle of a city is where the small-block grid actually belongs.
        pattern = draw < 0.72 ? 'downtown' : 'ladder'
      } else {
        pattern = draw < 0.3 ? 'downtown' : draw < 0.66 ? 'ladder' : 'crescent'
      }

      superblocks.set(key, {
        pattern,
        midCol: col * ARTERIAL_EVERY + Math.max(1, Math.round(ARTERIAL_EVERY / 2)),
        midRow: row * ARTERIAL_EVERY + Math.max(1, Math.round(ARTERIAL_EVERY / 2)),
        parity: rng() < 0.5 ? 0 : 1,
        // Downtown streets are surveyed; the further out and the looser the pattern, the more they
        // are allowed to follow the ground instead.
        bow: pattern === 'downtown' ? 0.25 : pattern === 'ladder' ? 0.8 : 1.6,
        room: occupied.has(key) ? 1 : 2.6,
      })
    }
  }
  return superblocks
}

function buildStreetNetwork(
  blockCols: number,
  blockRows: number,
  pitchX: number,
  pitchZ: number,
  cell: number,
  terrain: CityTerrain,
  seed: string,
) {
  const intersections = new Map<string, CityIntersection>()
  for (let row = 0; row <= blockRows; row += 1) {
    for (let col = 0; col <= blockCols; col += 1) {
      intersections.set(intersectionId(col, row), {
        id: intersectionId(col, row),
        col,
        row,
        x: col * pitchX,
        z: row * pitchZ,
      })
    }
  }

  const context: StreetContext = { pitchX, pitchZ, cell, terrain, bow: bowField(seed) }
  const ring = ringBoulevard(blockCols, blockRows)
  const isArterialCol = (col: number) => col === 0 || col === blockCols || col % ARTERIAL_EVERY === 0
  const isArterialRow = (row: number) => row === 0 || row === blockRows || row % ARTERIAL_EVERY === 0

  const superblocks = planSuperblocks(blockCols, blockRows, terrain, seed)
  const superblockAt = (col: number, row: number) =>
    superblocks.get(superblockKey(Math.floor(col / ARTERIAL_EVERY), Math.floor(row / ARTERIAL_EVERY)))

  /*
   * Which interior streets survive.
   *
   * An arterial is never touched — it is the skeleton the whole map hangs off, and it is also what
   * guarantees the graph stays connected once the interior thins out. Everything else answers to its
   * cell's pattern. Note that a cell holding buildings always keeps every through street, so no
   * building is ever left without the frontage {@link placeLot} promised it.
   */
  const keepsThrough = (col: number, row: number) => {
    if (isArterialRow(row)) return true
    const superblock = superblockAt(col, row)
    if (!superblock) return true
    if (superblock.pattern === 'open') return false
    if (superblock.pattern === 'estate') return row === superblock.midRow
    return true
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

  const streets: CityStreet[] = []
  for (let row = 0; row <= blockRows; row += 1) {
    for (let col = 0; col < blockCols; col += 1) {
      if (!keepsThrough(col, row)) continue
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
      if (!keepsCross(col, row)) continue
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

  for (const avenue of diagonalAvenues(blockCols, blockRows, terrain, seed)) {
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

  /*
   * Drop the junctions nothing meets at any more.
   *
   * Thinning the interior leaves lattice nodes in the middle of a park with no street touching them.
   * Left in place they are unreachable islands in the routing graph, and `nearestIntersectionId`
   * would happily snap a route onto one and then fail to path out of it. A node that no street uses
   * is not a junction, so it does not survive as one.
   */
  const used = new Set<string>()
  for (const street of streets) {
    used.add(street.fromId)
    used.add(street.toId)
  }
  for (const id of [...intersections.keys()]) {
    if (!used.has(id)) intersections.delete(id)
  }

  return { intersections, streets }
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
  readonly pitchX: number
  readonly pitchZ: number
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
  const { pitchX, pitchZ, terrain, bow: field } = context
  const fromX = from.col * pitchX
  const fromZ = from.row * pitchZ
  const toX = to.col * pitchX
  const toZ = to.row * pitchZ
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
 * Diagonal avenues across the lattice, as real edges between existing intersections.
 *
 * One runs south-east and, on a grid with room for it, a second runs south-west. Each edge is
 * `sqrt(2)` block pitches long against the two pitches of the lattice legs it parallels, so Dijkstra
 * prefers it and a route across town genuinely takes the avenue.
 *
 * An avenue cuts corner-to-corner *through* a block, so it may only cross ground the plan left empty.
 * Where a built block stands in the way the edge is dropped and the walk continues past it: the
 * avenue is interrupted, routes fall back to the lattice for that stretch, and no carriageway is ever
 * drawn through a measured building.
 */
function diagonalAvenues(
  blockCols: number,
  blockRows: number,
  terrain: CityTerrain,
  seed: string,
): Array<{ from: BlockRef; to: BlockRef }> {
  const side = Math.min(blockCols, blockRows)
  if (side < 6) return []
  const rng = mulberry32(stableHash(`${seed}::avenues`))
  const edges: Array<{ from: BlockRef; to: BlockRef }> = []

  const crossable = (col: number, row: number, stepCol: 1 | -1, stepRow: 1 | -1) => {
    // The block an edge cuts through is the one at the lower corner of the pair it spans.
    const block = terrain.blocks.get(
      terrainBlockKey(stepCol === 1 ? col : col - 1, stepRow === 1 ? row : row - 1),
    )
    return block !== undefined && block.use !== 'built' && block.use !== 'facility'
  }

  const walk = (startCol: number, startRow: number, stepCol: 1 | -1, stepRow: 1 | -1) => {
    let col = startCol
    let row = startRow
    while (true) {
      const nextCol = col + stepCol
      const nextRow = row + stepRow
      if (nextCol < 0 || nextCol > blockCols || nextRow < 0 || nextRow > blockRows) break
      if (crossable(col, row, stepCol, stepRow)) {
        edges.push({ from: { col, row }, to: { col: nextCol, row: nextRow } })
      }
      col = nextCol
      row = nextRow
    }
  }

  const firstRow = Math.floor(rng() * Math.max(1, blockRows - side + 1))
  walk(0, firstRow, 1, 1)
  if (side >= 10) {
    const secondRow = Math.min(blockRows, firstRow + Math.max(3, Math.floor(side * 0.6)))
    walk(0, secondRow, 1, -1)
  }
  return edges
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
