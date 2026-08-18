import * as THREE from 'three'
import type { BuildingArchetype, CityLot } from './cityPlan'

/**
 * Procedural building geometry, one merged {@link THREE.BufferGeometry} per building.
 *
 * **Evidence boundary.** Only three things here are measured: the building's `footprint` (log2 of
 * exact reserved pages), its `height` (log2 of exact used pages), and its `archetype` (exact reserved
 * page thresholds). Everything else -- roof pitch, window rows, door placement, setbacks, crown,
 * antenna, chimney, balconies -- is decoration derived from the lot's stable `seed`, and encodes
 * nothing. A building's decoration never changes when its measurements change, and never varies
 * between renders of the same object.
 *
 * A lot whose size is unknown gets `archetype: 'vacant'` and renders as a fenced empty parcel, so an
 * unmeasured object can never be mistaken for a small one.
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

export function buildBuildingGeometry(lot: CityLot): BuildingGeometrySet {
  const footprint = lot.footprint ?? 11
  const height = lot.height ?? 0
  const random = seeded(lot.seed)
  switch (lot.archetype) {
    case 'house':
      return house(footprint, height, random)
    case 'rowhouse':
      return rowhouse(footprint, height, random)
    case 'midrise':
      return midrise(footprint, height, random)
    case 'tower':
      return tower(footprint, height, random, false)
    case 'skyscraper':
      return tower(footprint, height, random, true)
    case 'civic':
      return civic(footprint, height, random)
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

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]
  const merged = mergeBufferGeometries(parts)
  for (const part of parts) part.dispose()
  return merged
}

/**
 * Minimal position/normal/uv merge. three's BufferGeometryUtils is an examples module; this keeps the
 * scene dependent only on the core package and on geometries we build ourselves, which are always
 * non-indexed-compatible BoxGeometry/CylinderGeometry with the same attribute set.
 */
function mergeBufferGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const nonIndexed = parts.map(part => (part.index ? part.toNonIndexed() : part.clone()))
  const names = ['position', 'normal', 'uv'] as const
  const result = new THREE.BufferGeometry()
  for (const name of names) {
    if (!nonIndexed.every(part => part.getAttribute(name))) continue
    const itemSize = nonIndexed[0].getAttribute(name).itemSize
    let total = 0
    for (const part of nonIndexed) total += part.getAttribute(name).count * itemSize
    const array = new Float32Array(total)
    let offset = 0
    for (const part of nonIndexed) {
      const attribute = part.getAttribute(name)
      array.set(attribute.array as Float32Array, offset)
      offset += attribute.count * itemSize
    }
    result.setAttribute(name, new THREE.BufferAttribute(array, itemSize))
  }
  for (const part of nonIndexed) part.dispose()
  result.computeBoundingSphere()
  return result
}

/** Small detached house: base, pitched roof, door, and a chimney. */
function house(footprint: number, height: number, random: Random): BuildingGeometrySet {
  const width = footprint
  const depth = footprint * (0.78 + random() * 0.16)
  const wallHeight = Math.max(height, 3.2)
  const roofHeight = wallHeight * (0.42 + random() * 0.2)

  const body = box(width, wallHeight, depth, 0, wallHeight / 2, 0)
  const roof = new THREE.ConeGeometry(Math.max(width, depth) * 0.76, roofHeight, 4)
  roof.rotateY(Math.PI / 4)
  roof.translate(0, wallHeight + roofHeight / 2, 0)

  const trim: THREE.BufferGeometry[] = [roof]
  trim.push(box(width * 0.22, wallHeight * 0.6, 0.5, 0, wallHeight * 0.3, depth / 2 + 0.2))
  if (random() > 0.45) {
    const chimneyX = (random() > 0.5 ? 1 : -1) * width * 0.28
    trim.push(box(1.1, roofHeight * 1.1, 1.1, chimneyX, wallHeight + roofHeight * 0.7, 0))
  }

  const windows: THREE.BufferGeometry[] = []
  const perSide = 2
  for (let i = 0; i < perSide; i += 1) {
    const offset = (i - (perSide - 1) / 2) * width * 0.42
    windows.push(box(width * 0.2, wallHeight * 0.3, 0.3, offset, wallHeight * 0.62, depth / 2 + 0.16))
    windows.push(box(0.3, wallHeight * 0.3, depth * 0.2, width / 2 + 0.16, wallHeight * 0.62, offset * 0.7))
  }

  return { body, windows: merge(windows), trim: merge(trim), height: wallHeight + roofHeight, footprint }
}

/** Terraced/row housing: a narrow block with a flat parapet and a repeating window grid. */
function rowhouse(footprint: number, height: number, random: Random): BuildingGeometrySet {
  const width = footprint
  const depth = footprint * (0.7 + random() * 0.12)
  const wallHeight = Math.max(height, 5)
  const floors = Math.max(2, Math.round(wallHeight / 4))

  const body = box(width, wallHeight, depth, 0, wallHeight / 2, 0)
  const trim = [
    box(width * 1.04, 0.7, depth * 1.04, 0, wallHeight + 0.35, 0),
    box(width * 0.24, wallHeight / floors * 0.7, 0.5, 0, (wallHeight / floors) * 0.35, depth / 2 + 0.2),
  ]

  const windows = gridWindows(width, depth, wallHeight, floors, 2, 0.22, 0.32)
  return { body, windows: merge(windows), trim: merge(trim), height: wallHeight + 0.7, footprint }
}

/** Mid-rise: a stepped block with a setback, banded windows and a parapet. */
function midrise(footprint: number, height: number, random: Random): BuildingGeometrySet {
  const width = footprint
  const depth = footprint * (0.86 + random() * 0.12)
  const total = Math.max(height, 10)
  const podiumHeight = total * (0.55 + random() * 0.12)
  const setback = 0.82 + random() * 0.08
  const towerHeight = total - podiumHeight

  const bodies = [
    box(width, podiumHeight, depth, 0, podiumHeight / 2, 0),
    box(width * setback, towerHeight, depth * setback, 0, podiumHeight + towerHeight / 2, 0),
  ]
  const trim = [
    box(width * 1.03, 0.6, depth * 1.03, 0, podiumHeight + 0.3, 0),
    box(width * setback * 1.05, 0.6, depth * setback * 1.05, 0, total + 0.3, 0),
    box(width * 0.3, 3, 0.6, 0, 1.5, depth / 2 + 0.25),
  ]

  const floors = Math.max(3, Math.round(total / 4.4))
  const windows = [
    ...gridWindows(width, depth, podiumHeight, Math.max(2, Math.round(podiumHeight / 4.4)), 3, 0.2, 0.34),
    ...gridWindows(
      width * setback,
      depth * setback,
      towerHeight,
      Math.max(1, floors - Math.round(podiumHeight / 4.4)),
      3,
      0.2,
      0.34,
      podiumHeight,
    ),
  ]
  return { body: merge(bodies)!, windows: merge(windows), trim: merge(trim), height: total + 0.6, footprint }
}

/** Tower / skyscraper: tapered stacked volumes, a crown, and an antenna on the tallest. */
function tower(footprint: number, height: number, random: Random, tallest: boolean): BuildingGeometrySet {
  const total = Math.max(height, 18)
  const stacks = tallest ? 3 + Math.round(random()) : 2
  const bodies: THREE.BufferGeometry[] = []
  const windows: THREE.BufferGeometry[] = []

  let base = 0
  let width = footprint
  let depth = footprint * (0.9 + random() * 0.08)
  for (let stack = 0; stack < stacks; stack += 1) {
    const remaining = stacks - stack
    const stackHeight = stack === stacks - 1 ? total - base : (total - base) / remaining * (0.85 + random() * 0.3)
    bodies.push(box(width, stackHeight, depth, 0, base + stackHeight / 2, 0))
    windows.push(
      ...gridWindows(width, depth, stackHeight, Math.max(3, Math.round(stackHeight / 4.2)), 4, 0.16, 0.4, base),
    )
    base += stackHeight
    width *= 0.8 + random() * 0.08
    depth *= 0.8 + random() * 0.08
  }

  const trim: THREE.BufferGeometry[] = [
    box(footprint * 1.06, 0.8, depth * 1.4, 0, 0.4, 0),
    box(width * 1.14, 1.1, depth * 1.14, 0, total + 0.55, 0),
  ]
  if (tallest) {
    // Mast length is capped so a very tall tower does not sprout an implausible spike.
    const mastHeight = Math.min(total * 0.16, 9)
    const mast = new THREE.CylinderGeometry(0.28, 0.5, mastHeight, 6)
    mast.translate(0, total + 1.1 + mastHeight / 2, 0)
    trim.push(mast)
  }

  return { body: merge(bodies)!, windows: merge(windows), trim: merge(trim), height: total + 1.1, footprint }
}

/** Indexed views get a civic/glass hall: a wide colonnaded base under a low glazed roof. */
function civic(footprint: number, height: number, random: Random): BuildingGeometrySet {
  const width = footprint * 1.1
  const depth = footprint * (0.82 + random() * 0.1)
  const wallHeight = Math.max(height, 6)

  const body = box(width, wallHeight, depth, 0, wallHeight / 2, 0)
  const trim: THREE.BufferGeometry[] = [
    box(width * 1.12, 0.9, depth * 1.12, 0, 0.45, 0),
    box(width * 1.06, 1.1, depth * 1.06, 0, wallHeight + 0.55, 0),
  ]
  const columns = 4
  for (let i = 0; i < columns; i += 1) {
    const offset = (i - (columns - 1) / 2) * (width / columns)
    const column = new THREE.CylinderGeometry(0.55, 0.55, wallHeight, 8)
    column.translate(offset, wallHeight / 2, depth / 2 + 0.7)
    trim.push(column)
  }

  const windows = gridWindows(width, depth, wallHeight, Math.max(2, Math.round(wallHeight / 5)), 4, 0.16, 0.5)
  return { body, windows: merge(windows), trim: merge(trim), height: wallHeight + 1.1, footprint }
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

/** Repeating window grid on all four faces. Purely decorative: count follows geometry, not data. */
function gridWindows(
  width: number,
  depth: number,
  wallHeight: number,
  floors: number,
  perFloor: number,
  windowWidthRatio: number,
  windowHeightRatio: number,
  yOffset = 0,
): THREE.BufferGeometry[] {
  const windows: THREE.BufferGeometry[] = []
  const floorHeight = wallHeight / floors
  const windowHeight = floorHeight * windowHeightRatio * 2
  if (floorHeight <= 0.6 || floors > 60) return windows
  for (let floor = 0; floor < floors; floor += 1) {
    const y = yOffset + floorHeight * (floor + 0.55)
    for (let i = 0; i < perFloor; i += 1) {
      const tx = (i - (perFloor - 1) / 2) * (width / perFloor)
      const tz = (i - (perFloor - 1) / 2) * (depth / perFloor)
      windows.push(box(width * windowWidthRatio, windowHeight, 0.25, tx, y, depth / 2 + 0.13))
      windows.push(box(width * windowWidthRatio, windowHeight, 0.25, tx, y, -depth / 2 - 0.13))
      windows.push(box(0.25, windowHeight, depth * windowWidthRatio, width / 2 + 0.13, y, tz))
      windows.push(box(0.25, windowHeight, depth * windowWidthRatio, -width / 2 - 0.13, y, tz))
    }
  }
  return windows
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
