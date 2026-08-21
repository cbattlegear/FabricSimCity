import { stableHash } from './atlasLayout'
import { FACILITY_LABELS, FACILITY_ORDER, type FacilityKind, type FacilitySite } from './cityInfrastructure'
import { mulberry32, seededShuffle } from './citySeed'
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

export type StreetClass = 'arterial' | 'collector'

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
  readonly axis: 'x' | 'z'
  readonly width: number
  readonly fromX: number
  readonly fromZ: number
  readonly toX: number
  readonly toZ: number
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
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
  readonly centerX: number
  readonly centerZ: number
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
 * Blocks used to hold eight buildings in two back-to-back rows, and schema neighborhood tints were
 * what visually separated one group of buildings from the next. Those tints are off by default now,
 * which left a packed block reading as an undifferentiated mass of geometry. Giving every building
 * its own block moves that separation into the street lattice itself, where it does not depend on a
 * layer being switched on.
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
export const LOT_MARGIN = 11
export const MIN_CELL = 26

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
  const slots = globalSlots(ordered, options.schemas)
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

  const lots = new Map<string, CityLot>()
  for (const object of ordered) {
    const slot = slots.get(object.objectId) ?? 0
    const block = shuffled[slot % shuffled.length]
    lots.set(object.objectId, placeLot(object, block, cell, pitchX, pitchZ))
  }

  const { intersections, streets } = buildStreetLattice(blockCols, blockRows, pitchX, pitchZ)

  return {
    cell,
    streetWidth: STREET_WIDTH,
    blockCols,
    blockRows,
    districts: describeDistricts(ordered, lots, cell),
    lots,
    intersections,
    streets,
    bounds: cityBounds(blockCols, blockRows, pitchX, pitchZ),
    facilities: facilitySites(facilityBlocks, cell, pitchX, pitchZ),
  }
}

/** Grid id of the intersection nearest a world point, for entering the street graph. */
export function nearestIntersectionId(plan: CityPlan, x: number, z: number): string {
  const pitchX = BLOCK_COLS * plan.cell + STREET_WIDTH
  const pitchZ = BLOCK_ROWS * plan.cell + STREET_WIDTH
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

/** World-space polyline that follows streets between two world points. */
/**
 * World-space polyline from one point to another that only ever travels along street centre lines.
 *
 * Buildings are entered from their kerb, which is half a street width off the centre line, so the
 * connector at each end gets an elbow: pull perpendicular onto the street first, drive along it, then
 * pull off to the kerb at the far end. Every segment is therefore axis-aligned, which is what makes
 * the drawn route read as driving rather than as a diagonal shortcut through the blocks.
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
  for (const node of lattice) points.push({ x: node.x, z: node.z })

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
interface BlockRef {
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
 * Without schema counts the offsets are derived from the loaded objects instead, which is correct
 * once everything is loaded and drifts while it is not.
 */
function globalSlots(
  ordered: readonly DatabaseCityObject[],
  schemas: readonly DatabaseCitySchema[] | undefined,
): Map<string, number> {
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
    // A schema the list did not mention, or one whose count is short of what actually arrived,
    // still has to fit; widen it rather than overlap the next schema's slots.
    const observed = object.layout.objectOrdinal + 1
    if (!existing) {
      counts.set(object.schemaId, { ordinal: object.layout.neighborhoodOrdinal, count: observed })
    } else if (observed > existing.count) {
      counts.set(object.schemaId, { ordinal: existing.ordinal, count: observed })
    }
  }

  const offsets = new Map<string, number>()
  let running = 0
  const orderedSchemas = [...counts.entries()].sort(
    (left, right) => left[1].ordinal - right[1].ordinal || compareOrdinal(left[0], right[0]),
  )
  for (const [schemaId, entry] of orderedSchemas) {
    offsets.set(schemaId, running)
    running += entry.count
  }

  const slots = new Map<string, number>()
  for (const object of ordered) {
    slots.set(object.objectId, (offsets.get(object.schemaId) ?? 0) + object.layout.objectOrdinal)
  }
  return slots
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
 * Districts are now the bounding box of their scattered members rather than a packed rectangle.
 *
 * Because members are spread across the grid these boxes overlap, so the neighbourhood layer draws
 * per-lot pads instead of one filled rectangle. The box survives only as a framing target for
 * "show me this schema".
 */
function describeDistricts(
  ordered: readonly DatabaseCityObject[],
  lots: ReadonlyMap<string, CityLot>,
  cell: number,
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
      const minX = Math.min(...group.lots.map(lot => lot.x)) - half
      const maxX = Math.max(...group.lots.map(lot => lot.x)) + half
      const minZ = Math.min(...group.lots.map(lot => lot.z)) - half
      const maxZ = Math.max(...group.lots.map(lot => lot.z)) + half
      return {
        districtId,
        name: group.name,
        neighborhoodOrdinal: group.ordinal,
        kind: 'schema' as const,
        objectCount: group.lots.length,
        minX,
        maxX,
        minZ,
        maxZ,
        centerX: (minX + maxX) / 2,
        centerZ: (minZ + maxZ) / 2,
      }
    })
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
 * The street lattice: a road on every block boundary, so each building is ringed by street.
 *
 * Arterials used to fall on district edges. With districts scattered there are no edges to follow,
 * so arterials fall on a fixed rhythm instead — every {@link ARTERIAL_EVERY} lines, plus the city
 * boundary. That gives the map the major-road structure it needs to be readable at a glance without
 * pretending the road hierarchy is measured: street class is cartography, not evidence.
 */
function buildStreetLattice(
  blockCols: number,
  blockRows: number,
  pitchX: number,
  pitchZ: number,
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

  const isArterialCol = (col: number) =>
    col === 0 || col === blockCols || col % ARTERIAL_EVERY === 0
  const isArterialRow = (row: number) =>
    row === 0 || row === blockRows || row % ARTERIAL_EVERY === 0

  const streets: CityStreet[] = []
  for (let row = 0; row <= blockRows; row += 1) {
    for (let col = 0; col < blockCols; col += 1) {
      streets.push(segment('x', col, row, col + 1, row, pitchX, pitchZ, isArterialRow(row)))
    }
  }
  for (let col = 0; col <= blockCols; col += 1) {
    for (let row = 0; row < blockRows; row += 1) {
      streets.push(segment('z', col, row, col, row + 1, pitchX, pitchZ, isArterialCol(col)))
    }
  }
  return { intersections, streets }
}

function segment(
  axis: 'x' | 'z',
  fromCol: number,
  fromRow: number,
  toCol: number,
  toRow: number,
  pitchX: number,
  pitchZ: number,
  arterial: boolean,
): CityStreet {
  return {
    id: streetIdFor(axis, fromCol, fromRow),
    fromId: intersectionId(fromCol, fromRow),
    toId: intersectionId(toCol, toRow),
    streetClass: arterial ? 'arterial' : 'collector',
    axis,
    width: arterial ? ARTERIAL_WIDTH : STREET_WIDTH,
    fromX: fromCol * pitchX,
    fromZ: fromRow * pitchZ,
    toX: toCol * pitchX,
    toZ: toRow * pitchZ,
  }
}

function adjacency(plan: CityPlan): Map<string, Array<{ toId: string; cost: number }>> {
  const map = new Map<string, Array<{ toId: string; cost: number }>>()
  const add = (fromId: string, toId: string, cost: number) => {
    const list = map.get(fromId)
    if (list) list.push({ toId, cost })
    else map.set(fromId, [{ toId, cost }])
  }
  for (const street of plan.streets) {
    const cost = Math.hypot(street.toX - street.fromX, street.toZ - street.fromZ)
    add(street.fromId, street.toId, cost)
    add(street.toId, street.fromId, cost)
  }
  return map
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
