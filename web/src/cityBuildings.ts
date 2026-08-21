import * as THREE from 'three'
import type { BuildingArchetype, CityLot } from './cityPlan'
import type { DistrictCharacter } from './cityTerrain'
import { mergeAndDispose } from './mergeGeometry'

/**
 * Procedural building geometry, one merged {@link THREE.BufferGeometry} per building.
 *
 * **Evidence boundary.** Only three things here are measured: the building's `footprint` (log2 of
 * exact reserved pages), its `height` (log2 of exact used pages), and its `archetype` (exact reserved
 * page thresholds). Everything else -- bay rhythm, roof form, cornices, balconies, storefronts,
 * canopies, rooftop plant, palette -- is decoration derived from the lot's stable `seed` and its
 * district's character, and encodes nothing. A building's decoration never changes when its
 * measurements change, and never varies between renders of the same object.
 *
 * A lot whose size is unknown gets `archetype: 'vacant'` and renders as a fenced empty parcel, so an
 * unmeasured object can never be mistaken for a small one.
 *
 * **How the massing is composed.** Every archetype is assembled from the same kit: a plinth, one or
 * more shafts, a facade, and a crown. The facade is bay-based rather than a fixed grid of quads --
 * the number of bays follows the building's own width, so a wide table and a narrow one are visibly
 * different buildings rather than the same texture stretched. Bay count follows geometry, never data.
 */

/** Deterministic 0..1 stream from a lot's stable seed. Decoration only; never gates a measurement. */
function seeded(seed: number): () => number {
  let state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return ((state >>> 0) % 100_000) / 100_000
  }
}

export interface BuildingGeometrySet {
  /** Body of the building, already centred on the origin with its base at y = 0. */
  readonly body: THREE.BufferGeometry
  /** Windows, emitted as a single instanced-friendly geometry, or null for archetypes without them. */
  readonly windows: THREE.BufferGeometry | null
  /** Trim: roofs, parapets, crowns, doors. Rendered in the accent material. */
  readonly trim: THREE.BufferGeometry | null
  readonly height: number
  readonly footprint: number
}

/** Footprint and height used when the object's page counts are unavailable. */
const VACANT_FENCE_HEIGHT = 2.2

/**
 * A hard ceiling on drawn window panels per building.
 *
 * A large instance can produce thousands of buildings, and the facade system multiplies bays by
 * floors by four faces. Past this count the extra panels are invisible at any camera distance that
 * fits the building on screen, so they are spent on nothing.
 */
const MAX_PANELS = 360

export function buildBuildingGeometry(
  lot: CityLot,
  character: DistrictCharacter = 'commercial',
): BuildingGeometrySet {
  const footprint = lot.footprint ?? 11
  const height = lot.height ?? 0
  const random = seeded(lot.seed)
  switch (lot.archetype) {
    case 'house':
      return house(footprint, height, random, character)
    case 'rowhouse':
      return rowhouse(footprint, height, random, character)
    case 'midrise':
      return midrise(footprint, height, random, character)
    case 'tower':
      return tower(footprint, height, random, character, false)
    case 'skyscraper':
      return tower(footprint, height, random, character, true)
    case 'civic':
      return civic(footprint, height, random, character)
    default:
      return vacant(footprint)
  }
}

type Random = () => number

function box(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  rotationY = 0,
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth)
  if (rotationY !== 0) geometry.rotateY(rotationY)
  geometry.translate(x, y, z)
  return geometry
}

const CUBE_FACES: readonly (readonly [number, number, number, number])[] = [
  [0, 1, 2, 3], [7, 6, 5, 4], [4, 5, 1, 0], [5, 6, 2, 1], [6, 7, 3, 2], [7, 4, 0, 3],
]

/**
 * A rectangular frustum: the workhorse behind setbacks, mansards, tapered crowns and plinths.
 *
 * Emitted as non-indexed triangles on purpose. Sharing corners and calling `computeVertexNormals`
 * would average the normals across the taper and shade a hard-edged solid as if it were inflated.
 */
function frustum(
  bottomWidth: number,
  bottomDepth: number,
  topWidth: number,
  topDepth: number,
  height: number,
  y: number,
): THREE.BufferGeometry {
  const bx = bottomWidth / 2
  const bz = bottomDepth / 2
  const tx = topWidth / 2
  const tz = topDepth / 2
  const corners: readonly (readonly [number, number, number])[] = [
    [-bx, y, -bz], [bx, y, -bz], [bx, y, bz], [-bx, y, bz],
    [-tx, y + height, -tz], [tx, y + height, -tz], [tx, y + height, tz], [-tx, y + height, tz],
  ]
  const positions: number[] = []
  for (const [a, b, c, d] of CUBE_FACES) {
    for (const index of [a, b, c, a, c, d]) positions.push(...corners[index])
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return geometry
}

/** A triangular prism with its ridge running along X: gables, pediments, dormers. */
function prism(width: number, depth: number, height: number, y: number): THREE.BufferGeometry {
  const hw = width / 2
  const hd = depth / 2
  const corners: readonly (readonly [number, number, number])[] = [
    [-hw, y, -hd], [hw, y, -hd], [hw, y, hd], [-hw, y, hd],
    [-hw, y + height, 0], [hw, y + height, 0],
  ]
  const triangles: readonly (readonly number[])[] = [
    [0, 2, 1], [0, 3, 2], [3, 5, 2], [3, 4, 5], [0, 1, 5], [0, 5, 4], [1, 2, 5], [0, 4, 3],
  ]
  const positions: number[] = []
  for (const triangle of triangles) {
    for (const index of triangle) positions.push(...corners[index])
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return geometry
}

/** A parapet: four low walls on the roof edge, which is what stops a flat roof reading as a lid. */
function parapet(
  width: number,
  depth: number,
  thickness: number,
  height: number,
  y: number,
): THREE.BufferGeometry[] {
  return [
    box(width, height, thickness, 0, y + height / 2, -depth / 2 + thickness / 2),
    box(width, height, thickness, 0, y + height / 2, depth / 2 - thickness / 2),
    box(thickness, height, depth - thickness * 2, -width / 2 + thickness / 2, y + height / 2, 0),
    box(thickness, height, depth - thickness * 2, width / 2 - thickness / 2, y + height / 2, 0),
  ]
}

const merge = mergeAndDispose

// --------------------------------------------------------------------------------------------------
// The facade system
// --------------------------------------------------------------------------------------------------

/** How a facade is glazed. Purely a look; the bay count follows the building's width either way. */
type Glazing = 'punched' | 'ribbon' | 'curtain'

interface FacadeSpec {
  width: number
  depth: number
  /** Height of the glazed shaft, excluding any plinth below it. */
  height: number
  /** World y of the bottom of the shaft. */
  base: number
  /** Target width of one structural bay. The drawn bay width is this rounded to fit. */
  bay: number
  /** Target floor-to-floor height. */
  floor: number
  glazing: Glazing
  /** Draws a glazed ground floor with a canopy and an entrance. */
  storefront: boolean
  /** Projecting slabs on alternating floors, on the long faces only. */
  balconies: boolean
  /** A horizontal band every few storeys, which is what gives a tall shaft a legible scale. */
  stringCourse: boolean
}

interface FacadeParts {
  windows: THREE.BufferGeometry[]
  trim: THREE.BufferGeometry[]
}

/**
 * Builds one shaft's glazing and its applied trim.
 *
 * The rhythm comes from the geometry: bays are the building's width divided into whole units close to
 * the target bay width, and floors are its height divided into whole storeys. Two buildings of
 * different measured size therefore get visibly different facades, and two of the same measured size
 * get the same one.
 */
function facade(spec: FacadeSpec): FacadeParts {
  const windows: THREE.BufferGeometry[] = []
  const trim: THREE.BufferGeometry[] = []
  const { width, depth, height, base, glazing } = spec
  if (height <= 1.6 || width <= 1 || depth <= 1) return { windows, trim }

  const floors = Math.max(1, Math.min(48, Math.round(height / spec.floor)))
  const floorHeight = height / floors
  if (floorHeight < 1.4) return { windows, trim }

  const groundFloors = spec.storefront && floors > 1 ? 1 : 0
  const upperFloors = floors - groundFloors
  const bayX = Math.max(1, Math.min(9, Math.round(width / spec.bay)))
  const bayZ = Math.max(1, Math.min(9, Math.round(depth / spec.bay)))

  // Trade rows for bays when the building is too tall to draw every storey. Skipping rows keeps the
  // vertical rhythm; dropping bays would change the building's apparent width.
  const perRow = (bayX + bayZ) * 2
  const rowStride = Math.max(1, Math.ceil((upperFloors * perRow) / MAX_PANELS))

  const pitchX = width / bayX
  const pitchZ = depth / bayZ
  const glassRatio = glazing === 'curtain' ? 0.82 : glazing === 'ribbon' ? 0.74 : 0.52
  const sillRatio = glazing === 'curtain' ? 0.86 : glazing === 'ribbon' ? 0.5 : 0.46
  const panelWidthX = pitchX * glassRatio
  const panelWidthZ = pitchZ * glassRatio
  const panelHeight = floorHeight * sillRatio
  const proud = 0.16

  for (let floor = groundFloors; floor < floors; floor += 1) {
    if ((floor - groundFloors) % rowStride !== 0) continue
    const y = base + floorHeight * (floor + 0.52)
    for (let bay = 0; bay < bayX; bay += 1) {
      const x = (bay - (bayX - 1) / 2) * pitchX
      windows.push(box(panelWidthX, panelHeight, 0.22, x, y, depth / 2 + proud))
      windows.push(box(panelWidthX, panelHeight, 0.22, x, y, -depth / 2 - proud))
    }
    for (let bay = 0; bay < bayZ; bay += 1) {
      const z = (bay - (bayZ - 1) / 2) * pitchZ
      windows.push(box(0.22, panelHeight, panelWidthZ, width / 2 + proud, y, z))
      windows.push(box(0.22, panelHeight, panelWidthZ, -width / 2 - proud, y, z))
    }

    // Balconies read as residential from any distance, so they are the cheapest character cue there is.
    if (spec.balconies && floor > groundFloors && (floor - groundFloors) % 2 === 1) {
      const slabY = base + floorHeight * floor + 0.1
      for (const sign of [-1, 1]) {
        trim.push(box(width * 0.62, 0.22, 1.5, 0, slabY, sign * (depth / 2 + 0.75)))
        trim.push(box(width * 0.62, 0.5, 0.14, 0, slabY + 0.36, sign * (depth / 2 + 1.42)))
      }
    }
  }

  // Mullions: the vertical structure between bays. Only on a curtain wall, where they are the wall.
  if (glazing === 'curtain' && bayX <= 7) {
    const shaftBase = base + floorHeight * groundFloors
    const shaftHeight = height - floorHeight * groundFloors
    for (let bay = 0; bay <= bayX; bay += 1) {
      const x = -width / 2 + bay * pitchX
      for (const sign of [-1, 1]) {
        trim.push(box(0.24, shaftHeight, 0.16, x, shaftBase + shaftHeight / 2, sign * (depth / 2 + proud)))
      }
    }
  }

  // String courses every fourth storey. A forty-storey shaft with no horizontal break has no scale.
  if (spec.stringCourse) {
    for (let floor = groundFloors + 4; floor < floors; floor += 4) {
      trim.push(box(width + 0.5, 0.34, depth + 0.5, 0, base + floorHeight * floor, 0))
    }
  }

  if (spec.storefront) {
    const shopHeight = floorHeight * 0.72
    const y = base + shopHeight / 2 + 0.2
    for (const sign of [-1, 1]) {
      windows.push(box(width * 0.86, shopHeight, 0.2, 0, y, sign * (depth / 2 + proud)))
      windows.push(box(0.2, shopHeight, depth * 0.8, sign * (width / 2 + proud), y, 0))
    }
    // Canopy and entrance, on the front face only, so the building has a legible front.
    trim.push(box(width * 0.9, 0.22, 1.9, 0, base + floorHeight * 0.86, depth / 2 + 0.95))
    trim.push(box(width * 0.26, floorHeight * 0.66, 0.4, 0, base + floorHeight * 0.33, depth / 2 + 0.3))
  }

  return { windows, trim }
}

/** Rooftop plant: the clutter that stops every flat roof in the city reading as the same lid. */
function rooftop(width: number, depth: number, y: number, random: Random): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = []
  const scale = Math.min(width, depth)
  if (scale < 6) return parts
  parts.push(box(scale * 0.22, scale * 0.3, scale * 0.22, -width * 0.22, y + scale * 0.15, depth * 0.18))
  if (random() > 0.4) {
    parts.push(box(scale * 0.3, scale * 0.1, scale * 0.2, width * 0.2, y + scale * 0.05, -depth * 0.16))
  }
  if (random() > 0.6) {
    const tank = new THREE.CylinderGeometry(scale * 0.12, scale * 0.12, scale * 0.18, 8)
    tank.translate(width * 0.18, y + scale * 0.26, depth * 0.2)
    parts.push(tank)
    parts.push(box(scale * 0.2, scale * 0.17, scale * 0.2, width * 0.18, y + scale * 0.085, depth * 0.2))
  }
  return parts
}

// --------------------------------------------------------------------------------------------------
// Archetypes
// --------------------------------------------------------------------------------------------------

/** Small detached house: walls, a pitched or hipped roof with eaves, a porch, and a chimney. */
function house(
  footprint: number,
  height: number,
  random: Random,
  character: DistrictCharacter,
): BuildingGeometrySet {
  const width = footprint
  const depth = footprint * (0.78 + random() * 0.16)
  const wallHeight = Math.max(height, 3.2)
  const roofHeight = wallHeight * (0.42 + random() * 0.2)
  const hipped = character === 'civic' || random() > 0.55

  const body = box(width, wallHeight, depth, 0, wallHeight / 2, 0)
  const trim: THREE.BufferGeometry[] = []

  if (hipped) {
    const roof = new THREE.ConeGeometry(Math.max(width, depth) * 0.76, roofHeight, 4)
    roof.rotateY(Math.PI / 4)
    roof.translate(0, wallHeight + roofHeight / 2, 0)
    trim.push(roof)
  } else {
    trim.push(prism(width * 1.1, depth * 1.12, roofHeight, wallHeight))
    // Eaves. Without an overhang a pitched roof looks like a party hat balanced on a box.
    trim.push(box(width * 1.14, 0.28, depth * 1.16, 0, wallHeight + 0.14, 0))
  }

  // Porch: a hood on two posts over the door.
  const doorZ = depth / 2
  trim.push(box(width * 0.24, wallHeight * 0.62, 0.4, 0, wallHeight * 0.31, doorZ + 0.2))
  trim.push(box(width * 0.5, 0.2, 1.3, 0, wallHeight * 0.66, doorZ + 0.65))
  for (const sign of [-1, 1]) {
    trim.push(box(0.24, wallHeight * 0.62, 0.24, sign * width * 0.2, wallHeight * 0.31, doorZ + 1.1))
  }
  if (random() > 0.45) {
    const chimneyX = (random() > 0.5 ? 1 : -1) * width * 0.28
    trim.push(box(1.1, roofHeight * 1.2, 1.1, chimneyX, wallHeight + roofHeight * 0.72, 0))
  }

  const parts = facade({
    width,
    depth,
    height: wallHeight,
    base: 0,
    bay: 3.4,
    floor: 3.2,
    glazing: 'punched',
    storefront: false,
    balconies: false,
    stringCourse: false,
  })
  trim.push(...parts.trim)

  return {
    body,
    windows: merge(parts.windows),
    trim: merge(trim),
    height: wallHeight + roofHeight,
    footprint,
  }
}

/** Terraced housing: a plinth, a cornice, and either a mansard with dormers or a flat parapet. */
function rowhouse(
  footprint: number,
  height: number,
  random: Random,
  character: DistrictCharacter,
): BuildingGeometrySet {
  const width = footprint
  const depth = footprint * (0.7 + random() * 0.12)
  const wallHeight = Math.max(height, 5)
  const mansard = character === 'residential' || random() > 0.6
  const capHeight = mansard ? Math.min(wallHeight * 0.22, 3.4) : 0.8

  const bodies = [
    box(width, wallHeight, depth, 0, wallHeight / 2, 0),
    // Plinth: a slightly wider ground storey, which is how a terrace meets the pavement.
    frustum(width * 1.05, depth * 1.05, width * 1.02, depth * 1.02, Math.min(1.4, wallHeight * 0.2), 0),
  ]

  // The cornice under the roof is the strongest single line on a terrace.
  const trim: THREE.BufferGeometry[] = [box(width * 1.08, 0.55, depth * 1.08, 0, wallHeight - 0.1, 0)]
  if (mansard) {
    trim.push(frustum(width * 1.04, depth * 1.04, width * 0.74, depth * 0.74, capHeight, wallHeight + 0.18))
    const dormers = Math.max(1, Math.min(4, Math.round(width / 4.6)))
    for (let index = 0; index < dormers; index += 1) {
      const x = (index - (dormers - 1) / 2) * (width / dormers)
      trim.push(box((width / dormers) * 0.42, capHeight * 0.62, 1.0, x, wallHeight + capHeight * 0.42, depth * 0.42))
    }
  } else {
    trim.push(...parapet(width * 1.04, depth * 1.04, 0.4, capHeight, wallHeight + 0.18))
  }

  const parts = facade({
    width,
    depth,
    height: wallHeight,
    base: 0,
    bay: 3.2,
    floor: 3.6,
    glazing: 'punched',
    storefront: character === 'commercial',
    balconies: character === 'residential' && wallHeight > 11,
    stringCourse: false,
  })
  trim.push(...parts.trim)

  return {
    body: merge(bodies)!,
    windows: merge(parts.windows),
    trim: merge(trim),
    height: wallHeight + capHeight + 0.18,
    footprint,
  }
}

/** Mid-rise: a podium, a set-back shaft, cornices, parapets, and plant on the roof. */
function midrise(
  footprint: number,
  height: number,
  random: Random,
  character: DistrictCharacter,
): BuildingGeometrySet {
  const width = footprint
  const depth = footprint * (0.86 + random() * 0.12)
  const total = Math.max(height, 10)
  const podiumHeight = total * (0.5 + random() * 0.14)
  const setback = 0.8 + random() * 0.08
  const shaftHeight = total - podiumHeight
  const shaftWidth = width * setback
  const shaftDepth = depth * setback
  const industrial = character === 'industrial'

  const bodies = [
    box(width, podiumHeight, depth, 0, podiumHeight / 2, 0),
    box(shaftWidth, shaftHeight, shaftDepth, 0, podiumHeight + shaftHeight / 2, 0),
  ]

  const trim: THREE.BufferGeometry[] = [
    // The podium cornice is what makes the setback read as deliberate rather than as a modelling slip.
    box(width * 1.05, 0.7, depth * 1.05, 0, podiumHeight - 0.1, 0),
    ...parapet(width * 1.02, depth * 1.02, 0.4, 1.1, podiumHeight),
    ...parapet(shaftWidth * 1.04, shaftDepth * 1.04, 0.4, 1.2, total),
  ]
  trim.push(...rooftop(shaftWidth, shaftDepth, total, random))

  const glazing: Glazing = character === 'commercial' ? 'ribbon' : 'punched'
  const bay = industrial ? 5.2 : 3.8
  const podium = facade({
    width,
    depth,
    height: podiumHeight,
    base: 0,
    bay,
    floor: 4.2,
    glazing,
    storefront: !industrial,
    balconies: false,
    stringCourse: false,
  })
  const shaft = facade({
    width: shaftWidth,
    depth: shaftDepth,
    height: shaftHeight,
    base: podiumHeight,
    bay,
    floor: 4.2,
    glazing,
    storefront: false,
    balconies: character === 'residential',
    stringCourse: shaftHeight > 26,
  })
  trim.push(...podium.trim, ...shaft.trim)

  return {
    body: merge(bodies)!,
    windows: merge([...podium.windows, ...shaft.windows]),
    trim: merge(trim),
    height: total + 1.2,
    footprint,
  }
}

/** Tower / skyscraper: a plinth, tapered stacked shafts, terraces at each step, a crown, and a mast. */
function tower(
  footprint: number,
  height: number,
  random: Random,
  character: DistrictCharacter,
  tallest: boolean,
): BuildingGeometrySet {
  const total = Math.max(height, 18)
  const stacks = tallest ? 3 + Math.round(random()) : 2
  const bodies: THREE.BufferGeometry[] = []
  const windows: THREE.BufferGeometry[] = []
  const trim: THREE.BufferGeometry[] = []
  const glazing: Glazing = character === 'industrial' ? 'ribbon' : 'curtain'

  let base = 0
  let width = footprint
  let depth = footprint * (0.9 + random() * 0.08)
  for (let stack = 0; stack < stacks; stack += 1) {
    const remaining = stacks - stack
    const last = stack === stacks - 1
    const stackHeight = last ? total - base : ((total - base) / remaining) * (0.85 + random() * 0.3)
    const nextWidth = width * (0.8 + random() * 0.08)
    const nextDepth = depth * (0.8 + random() * 0.08)

    if (last) {
      // The top stack tapers rather than stepping, so the tower has a silhouette instead of a stack
      // of boxes with a lid on it.
      bodies.push(frustum(width, depth, width * 0.9, depth * 0.9, stackHeight, base))
    } else {
      bodies.push(box(width, stackHeight, depth, 0, base + stackHeight / 2, 0))
      trim.push(box(width * 1.03, 0.6, depth * 1.03, 0, base + stackHeight - 0.1, 0))
      trim.push(...parapet(width, depth, 0.36, 0.9, base + stackHeight))
    }

    const parts = facade({
      width,
      depth,
      height: stackHeight,
      base,
      bay: 3.6,
      floor: 4.0,
      glazing,
      storefront: stack === 0,
      balconies: false,
      stringCourse: stackHeight > 24,
    })
    windows.push(...parts.windows)
    trim.push(...parts.trim)

    base += stackHeight
    width = nextWidth
    depth = nextDepth
  }

  // A plinth at the pavement and a crown at the top: the two ends a tall building needs before it
  // reads as architecture rather than as an extrusion.
  trim.push(frustum(footprint * 1.12, footprint * 1.12, footprint * 1.04, footprint * 1.04, 0.9, 0))
  const crownWidth = width * 0.9
  const crownDepth = depth * 0.9
  trim.push(frustum(crownWidth * 1.14, crownDepth * 1.14, crownWidth * 0.86, crownDepth * 0.86, 1.6, total))
  trim.push(...rooftop(crownWidth, crownDepth, total + 1.6, random))
  let top = total + 1.6
  if (tallest) {
    // Mast length is capped so a very tall tower does not sprout an implausible spike.
    const mastHeight = Math.min(total * 0.16, 9)
    const mast = new THREE.CylinderGeometry(0.24, 0.62, mastHeight, 6)
    mast.translate(0, top + mastHeight / 2, 0)
    trim.push(mast)
    top += mastHeight
  }

  return { body: merge(bodies)!, windows: merge(windows), trim: merge(trim), height: top, footprint }
}

/** Indexed views get a civic hall: a colonnaded base, steps, and a glazed barrel vault over the hall. */
function civic(
  footprint: number,
  height: number,
  random: Random,
  character: DistrictCharacter,
): BuildingGeometrySet {
  const width = footprint * 1.1
  const depth = footprint * (0.82 + random() * 0.1)
  const wallHeight = Math.max(height, 6)
  const vaultRadius = Math.min(width, depth) * 0.32

  const bodies = [
    box(width, wallHeight, depth, 0, wallHeight / 2, 0),
    frustum(width * 1.14, depth * 1.14, width * 1.04, depth * 1.04, 1.0, 0),
  ]

  const trim: THREE.BufferGeometry[] = [box(width * 1.08, 1.1, depth * 1.08, 0, wallHeight + 0.55, 0)]

  // Colonnade across the front, under a full-width entablature.
  const columns = Math.max(4, Math.min(9, Math.round(width / 3.4)))
  const columnHeight = wallHeight * 0.92
  for (let index = 0; index < columns; index += 1) {
    const x = (index - (columns - 1) / 2) * (width / columns)
    const column = new THREE.CylinderGeometry(0.5, 0.58, columnHeight, 8)
    column.translate(x, 1.0 + columnHeight / 2, depth / 2 + 1.0)
    trim.push(column)
  }
  trim.push(box(width * 1.06, 0.9, 2.0, 0, 1.0 + columnHeight + 0.45, depth / 2 + 1.0))
  for (let step = 0; step < 3; step += 1) {
    trim.push(
      box(width * (0.9 + step * 0.06), 0.34, 2.4 + step * 0.8, 0, 0.85 - step * 0.34, depth / 2 + 1.5 + step * 0.4),
    )
  }

  // A glazed barrel vault over the hall: the one roof form nothing else in the city uses.
  const vault = new THREE.CylinderGeometry(vaultRadius, vaultRadius, depth * 0.72, 14, 1, true, 0, Math.PI)
  vault.rotateZ(-Math.PI / 2)
  vault.rotateY(Math.PI / 2)
  vault.translate(0, wallHeight + 1.1, 0)

  const parts = facade({
    width,
    depth,
    height: wallHeight,
    base: 1.0,
    bay: 3.6,
    floor: 5.0,
    glazing: character === 'industrial' ? 'punched' : 'ribbon',
    storefront: false,
    balconies: false,
    stringCourse: false,
  })
  trim.push(...parts.trim)

  return {
    body: merge(bodies)!,
    windows: merge([...parts.windows, vault]),
    trim: merge(trim),
    height: wallHeight + 1.1 + vaultRadius,
    footprint,
  }
}

/** Unknown size: a fenced empty parcel. Deliberately has no massing at all -- it claims nothing. */
function vacant(footprint: number): BuildingGeometrySet {
  const posts: THREE.BufferGeometry[] = []
  const half = footprint / 2
  const perSide = 4
  for (let i = 0; i <= perSide; i += 1) {
    const t = -half + (footprint * i) / perSide
    posts.push(box(0.35, VACANT_FENCE_HEIGHT, 0.35, t, VACANT_FENCE_HEIGHT / 2, -half))
    posts.push(box(0.35, VACANT_FENCE_HEIGHT, 0.35, t, VACANT_FENCE_HEIGHT / 2, half))
    posts.push(box(0.35, VACANT_FENCE_HEIGHT, 0.35, -half, VACANT_FENCE_HEIGHT / 2, t))
    posts.push(box(0.35, VACANT_FENCE_HEIGHT, 0.35, half, VACANT_FENCE_HEIGHT / 2, t))
  }
  posts.push(box(footprint, 0.2, 0.25, 0, VACANT_FENCE_HEIGHT, -half))
  posts.push(box(footprint, 0.2, 0.25, 0, VACANT_FENCE_HEIGHT, half))
  posts.push(box(0.25, 0.2, footprint, -half, VACANT_FENCE_HEIGHT, 0))
  posts.push(box(0.25, 0.2, footprint, half, VACANT_FENCE_HEIGHT, 0))
  return { body: merge(posts)!, windows: null, trim: null, height: VACANT_FENCE_HEIGHT, footprint }
}

/** Palette. Colours are per-archetype styling and carry no measurement. */
export const ARCHETYPE_COLORS: Readonly<Record<BuildingArchetype, number>> = {
  house: 0x8a6f5a,
  rowhouse: 0x7d6c5e,
  midrise: 0x4f6675,
  tower: 0x35505f,
  skyscraper: 0x2b4453,
  civic: 0x6b7f96,
  vacant: 0x6e7d88,
}

/**
 * Per-character shifts on the archetype palette.
 *
 * A district's character is hashed from its schema id, so this is styling and nothing else: two
 * schemas with identical contents can and will be different colours. It exists so a city has
 * neighbourhoods you can navigate by, not so a colour can be looked up in a table and believed.
 */
const CHARACTER_TINTS: Readonly<Record<DistrictCharacter, Readonly<Record<BuildingArchetype, number>>>> = {
  residential: {
    house: 0x977a60, rowhouse: 0x8b7460, midrise: 0x6a6a70, tower: 0x4c5a63,
    skyscraper: 0x3c4d59, civic: 0x77808f, vacant: 0x6e7d88,
  },
  commercial: {
    house: 0x7f7264, rowhouse: 0x76707a, midrise: 0x4f6675, tower: 0x35505f,
    skyscraper: 0x2b4453, civic: 0x6b7f96, vacant: 0x6e7d88,
  },
  industrial: {
    house: 0x76685c, rowhouse: 0x6d655c, midrise: 0x565c5c, tower: 0x424f52,
    skyscraper: 0x36474c, civic: 0x5f7078, vacant: 0x6e7d88,
  },
  civic: {
    house: 0x8e8272, rowhouse: 0x847a6d, midrise: 0x5a6a7c, tower: 0x3d5468,
    skyscraper: 0x334a5e, civic: 0x7889a0, vacant: 0x6e7d88,
  },
}

/** The drawn colour of one building. Styling only: nothing about it can be looked up as a fact. */
export function buildingColor(
  archetype: BuildingArchetype,
  character: DistrictCharacter | undefined,
): number {
  if (!character) return ARCHETYPE_COLORS[archetype]
  return CHARACTER_TINTS[character][archetype]
}
