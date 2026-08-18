import { stableHash } from './atlasLayout'
import type { DatabaseCityObject } from './databaseCityContracts'

/**
 * Deterministic town plan for one database city.
 *
 * Placement derives only from the backend's stable layout ordinals
 * (`layout.neighborhoodOrdinal` / `layout.objectOrdinal`) and from ordinal-stable string comparisons,
 * never from the order rows happen to arrive in. This preserves the architectural rule that
 * database-city layout is deterministic and independent of source row order, and it keeps a building
 * on the same lot when a later bounded page is appended.
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
  /** Reserved district that hosts the CPU / memory / storage / tempdb / log / lock facilities. */
  readonly civic: CityDistrict
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
 * Civic district size in blocks. Blocks are one lot each now, so the reserved rectangle is sized in
 * many small blocks rather than a few large ones; {@link layoutFacilities} divides whatever rectangle
 * it is given into a fixed 3x2 grid, and these dimensions keep each facility's footprint close to
 * what it was when a block held eight buildings. Facilities are civic landmarks and must not shrink
 * to the size of the tables they serve.
 */
const CIVIC_BLOCK_COLS = 5
const CIVIC_BLOCK_ROWS = 3
export const CIVIC_DISTRICT_ID = 'civic:infrastructure'

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

export function planCity(objects: readonly DatabaseCityObject[]): CityPlan {
  const districts = groupDistricts(objects)
  const cell = chooseCell(objects)
  const pitchX = BLOCK_COLS * cell + STREET_WIDTH
  const pitchZ = BLOCK_ROWS * cell + STREET_WIDTH

  const totalBlocks =
    districts.reduce((sum, district) => sum + blocksNeeded(district.members.length), 0) +
    CIVIC_BLOCK_COLS * CIVIC_BLOCK_ROWS
  const shelfWidth = Math.max(CIVIC_BLOCK_COLS, Math.ceil(Math.sqrt(Math.max(totalBlocks, 1))))

  const placements = packDistricts(districts, shelfWidth)
  const blockCols = placements.reduce((max, item) => Math.max(max, item.startCol + item.cols), 0)
  const blockRows = placements.reduce((max, item) => Math.max(max, item.startRow + item.rows), 0)

  const { intersections, streets } = buildStreetLattice(
    blockCols,
    blockRows,
    pitchX,
    pitchZ,
    placements,
  )

  const lots = new Map<string, CityLot>()
  const districtResults: CityDistrict[] = []

  for (const placement of placements) {
    const bounds = districtBounds(placement, pitchX, pitchZ)
    districtResults.push({
      districtId: placement.districtId,
      name: placement.name,
      neighborhoodOrdinal: placement.neighborhoodOrdinal,
      kind: placement.kind,
      objectCount: placement.members.length,
      ...bounds,
    })
    placement.members.forEach((object, localIndex) => {
      lots.set(
        object.objectId,
        placeLot(object, localIndex, placement, cell, pitchX, pitchZ),
      )
    })
  }

  const civic = districtResults.find(district => district.districtId === CIVIC_DISTRICT_ID)!
  return {
    cell,
    streetWidth: STREET_WIDTH,
    blockCols,
    blockRows,
    districts: districtResults.filter(district => district.kind === 'schema'),
    lots,
    intersections,
    streets,
    bounds: cityBounds(blockCols, blockRows, pitchX, pitchZ),
    civic,
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

type DistrictGroup = {
  districtId: string
  name: string
  neighborhoodOrdinal: number
  kind: 'schema' | 'civic'
  members: DatabaseCityObject[]
}

type DistrictPlacement = DistrictGroup & {
  startCol: number
  startRow: number
  cols: number
  rows: number
}

function groupDistricts(objects: readonly DatabaseCityObject[]): DistrictGroup[] {
  const groups = new Map<string, DistrictGroup>()
  for (const object of objects) {
    const existing = groups.get(object.schemaId)
    if (existing) {
      existing.members.push(object)
      existing.neighborhoodOrdinal = Math.min(
        existing.neighborhoodOrdinal,
        object.layout.neighborhoodOrdinal,
      )
    } else {
      groups.set(object.schemaId, {
        districtId: object.schemaId,
        name: object.schemaName,
        neighborhoodOrdinal: object.layout.neighborhoodOrdinal,
        kind: 'schema',
        members: [object],
      })
    }
  }
  const ordered = [...groups.values()].sort(
    (left, right) =>
      left.neighborhoodOrdinal - right.neighborhoodOrdinal ||
      compareOrdinal(left.districtId, right.districtId),
  )
  for (const group of ordered) {
    group.members.sort(
      (left, right) =>
        left.layout.objectOrdinal - right.layout.objectOrdinal ||
        compareOrdinal(left.objectId, right.objectId),
    )
  }
  return ordered
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

/** One block per building, so a district needs exactly as many blocks as it has members. */
function blocksNeeded(memberCount: number): number {
  return Math.max(1, Math.ceil(memberCount / CELLS_PER_BLOCK))
}

/** Shelf packing in neighbourhood order, so districts occupy contiguous rectangles of blocks. */
function packDistricts(districts: DistrictGroup[], shelfWidth: number): DistrictPlacement[] {
  const civic: DistrictGroup = {
    districtId: CIVIC_DISTRICT_ID,
    name: 'Infrastructure',
    neighborhoodOrdinal: Number.MAX_SAFE_INTEGER,
    kind: 'civic',
    members: [],
  }

  const placements: DistrictPlacement[] = []
  let cursorCol = 0
  let cursorRow = 0
  let shelfHeight = 0

  const place = (district: DistrictGroup, cols: number, rows: number) => {
    if (cursorCol > 0 && cursorCol + cols > shelfWidth) {
      cursorCol = 0
      cursorRow += shelfHeight
      shelfHeight = 0
    }
    placements.push({ ...district, startCol: cursorCol, startRow: cursorRow, cols, rows })
    cursorCol += cols
    shelfHeight = Math.max(shelfHeight, rows)
  }

  for (const district of districts) {
    const need = blocksNeeded(district.members.length)
    const cols = Math.max(1, Math.min(need, shelfWidth))
    place(district, cols, Math.ceil(need / cols))
  }
  place(civic, CIVIC_BLOCK_COLS, CIVIC_BLOCK_ROWS)
  return placements
}

function placeLot(
  object: DatabaseCityObject,
  localIndex: number,
  placement: DistrictPlacement,
  cell: number,
  pitchX: number,
  pitchZ: number,
): CityLot {
  const blockIndex = Math.floor(localIndex / CELLS_PER_BLOCK)
  const cellIndex = localIndex % CELLS_PER_BLOCK
  const blockCol = placement.startCol + (blockIndex % placement.cols)
  const blockRow = placement.startRow + Math.floor(blockIndex / placement.cols)
  const cellCol = cellIndex % BLOCK_COLS
  const cellRow = Math.floor(cellIndex / BLOCK_COLS)

  const blockOriginX = blockCol * pitchX + STREET_WIDTH / 2
  const blockOriginZ = blockRow * pitchZ + STREET_WIDTH / 2
  const x = blockOriginX + (cellCol + 0.5) * cell
  const z = blockOriginZ + (cellRow + 0.5) * cell

  // One lot per block, so the building fronts the street along its block's north edge and the other
  // three sides are open street too. There is no back row to face the other way.
  const facing: Facing = 'north'
  const kerbZ = blockRow * pitchZ
  const frontageStreetId = streetIdFor('x', blockCol, blockRow)

  return {
    objectId: object.objectId,
    districtId: placement.districtId,
    blockId: `${placement.districtId}/block/${blockCol}-${blockRow}`,
    x,
    z,
    rotationY: Math.PI,
    facing,
    accessX: x,
    accessZ: kerbZ,
    frontageStreetId,
    lotSize: cell,
    footprint: buildingFootprint(object.reservedPages8KiB),
    height: buildingHeight(object.usedPages8KiB),
    archetype: buildingArchetype(object),
    seed: stableHash(object.objectId),
  }
}

function districtBounds(placement: DistrictPlacement, pitchX: number, pitchZ: number) {
  const minX = placement.startCol * pitchX
  const maxX = (placement.startCol + placement.cols) * pitchX
  const minZ = placement.startRow * pitchZ
  const maxZ = (placement.startRow + placement.rows) * pitchZ
  return { minX, maxX, minZ, maxZ, centerX: (minX + maxX) / 2, centerZ: (minZ + maxZ) / 2 }
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

function buildStreetLattice(
  blockCols: number,
  blockRows: number,
  pitchX: number,
  pitchZ: number,
  placements: readonly DistrictPlacement[],
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

  const boundaryCols = new Set<number>([0, blockCols])
  const boundaryRows = new Set<number>([0, blockRows])
  for (const placement of placements) {
    boundaryCols.add(placement.startCol)
    boundaryCols.add(placement.startCol + placement.cols)
    boundaryRows.add(placement.startRow)
    boundaryRows.add(placement.startRow + placement.rows)
  }

  const streets: CityStreet[] = []
  for (let row = 0; row <= blockRows; row += 1) {
    for (let col = 0; col < blockCols; col += 1) {
      streets.push(
        segment('x', col, row, col + 1, row, pitchX, pitchZ, boundaryRows.has(row)),
      )
    }
  }
  for (let col = 0; col <= blockCols; col += 1) {
    for (let row = 0; row < blockRows; row += 1) {
      streets.push(
        segment('z', col, row, col, row + 1, pitchX, pitchZ, boundaryCols.has(col)),
      )
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
