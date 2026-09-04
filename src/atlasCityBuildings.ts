import * as THREE from 'three'
import type { AtlasCityPlan, AtlasCityLot } from './atlasCity'
import { mergeAndDispose } from './mergeGeometry'
import { ribbonPositions } from './mapRibbon'

/**
 * Turns an {@link AtlasCityPlan} into the handful of merged geometries the atlas draws it with.
 *
 * One city is one draw call per material rather than one per building. A hundred capacities at up to
 * forty-nine lots each is several thousand boxes, and the atlas refreshes on a timer, so merging is
 * what keeps the top-level view affordable — and it makes the whole city a single raycast target, so
 * hovering anywhere in a city selects the capacity rather than one arbitrary tower.
 *
 * **Evidence boundary.** The measured values arrive already resolved on the plan: lot positions and
 * footprints come from the encoded plot side, and lot heights from the encoded tallest tower. Setback,
 * mast, roof cap, and the small per-lot width variation are decoration derived from each lot's stable
 * seed, and encode nothing at all.
 */

/** Thickness of the ground plate a city stands on. Buildings start at its top. */
export const PAD_HEIGHT = 0.9

/** Fraction of the tallest tower above which a lot is treated as downtown and gets a mast. */
const MAST_THRESHOLD = 0.92

/** A tower taller than this many world units is drawn as two stacked volumes with a setback. */
const SETBACK_HEIGHT = 26

/**
 * Painted width of a town street, and of the darker casing under it.
 *
 * Constant across every town, like the block pitch: streets are scenery, so letting them grow with a
 * capacity would put a second, false size encoding on the sheet. Both fit inside the gap the block
 * pitch already leaves between buildings.
 */
export const STREET_FILL_WIDTH = 1.7
export const STREET_CASING_WIDTH = 2.9

export interface AtlasCityGeometry {
  /** Building bodies. Carries the capacity tint and is the city's pick target. */
  readonly massing: THREE.BufferGeometry | null
  /** Roof caps, parapets, and masts, drawn in the lighter accent material. */
  readonly trim: THREE.BufferGeometry | null
  /** The ground the city stands on: the town outline, extruded. Its area is the allocated bytes. */
  readonly pad: THREE.BufferGeometry
  /** The dark edge under every street, drawn first. */
  readonly streetCasing: THREE.BufferGeometry | null
  /** The pale surface of every street, drawn over its casing. */
  readonly streetFill: THREE.BufferGeometry | null
}

export function buildAtlasCityGeometry(plan: AtlasCityPlan): AtlasCityGeometry {
  const massing: THREE.BufferGeometry[] = []
  const trim: THREE.BufferGeometry[] = []
  for (const lot of plan.lots) {
    if (lot.kind === 'vacant') massing.push(...fence(lot))
    else addTower(lot, plan.towerHeight ?? lot.height, massing, trim)
  }

  return {
    massing: mergeAndDispose(massing),
    trim: mergeAndDispose(trim),
    pad: padGeometry(plan),
    streetCasing: streetGeometry(plan, STREET_CASING_WIDTH, PAD_HEIGHT + 0.04),
    streetFill: streetGeometry(plan, STREET_FILL_WIDTH, PAD_HEIGHT + 0.08),
  }
}

/**
 * The town's ground: its outline extruded to {@link PAD_HEIGHT}.
 *
 * A square box became an extruded polygon here and nowhere else in the pipeline, because the plot was
 * never really a square -- it was an area, and a square was one arbitrary way to spend it. `Shape`
 * works in XY, so the outline's `z` is negated on the way in and the prism is stood upright
 * afterwards, which lands it spanning `y = 0..PAD_HEIGHT` in the same place the box occupied.
 */
function padGeometry(plan: AtlasCityPlan): THREE.BufferGeometry {
  if (plan.outline.length < 3) {
    const fallback = new THREE.BoxGeometry(plan.side, PAD_HEIGHT, plan.side)
    fallback.translate(0, PAD_HEIGHT / 2, 0)
    return fallback
  }
  const shape = new THREE.Shape(
    plan.outline.map(point => new THREE.Vector2(point.x, -point.z)),
  )
  const pad = new THREE.ExtrudeGeometry(shape, { depth: PAD_HEIGHT, bevelEnabled: false })
  pad.rotateX(-Math.PI / 2)
  pad.computeVertexNormals()
  return pad
}

function box(width: number, height: number, depth: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth)
  geometry.translate(x, y, z)
  return geometry
}

/** Deterministic 0..1 value from a lot's stable seed. Decoration only. */
function seeded(seed: number, salt: number): number {
  let state = (seed ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0
  state ^= state << 13
  state ^= state >>> 17
  state ^= state << 5
  return ((state >>> 0) % 100_000) / 100_000
}

function addTower(
  lot: AtlasCityLot,
  towerHeight: number,
  massing: THREE.BufferGeometry[],
  trim: THREE.BufferGeometry[],
): void {
  // A little width variation keeps a block of equal-footprint lots from reading as extruded graph
  // paper. It never crosses the street, so the encoded lot pitch still bounds every building.
  const width = lot.footprint * (0.84 + seeded(lot.seed, 1) * 0.16)
  const depth = lot.footprint * (0.84 + seeded(lot.seed, 2) * 0.16)
  const height = Math.max(lot.height, 0)
  const base = PAD_HEIGHT

  if (height <= 0) {
    // Zero used bytes is zero height, exactly as in the capacity city: a paved, empty lot.
    trim.push(box(width, 0.25, depth, lot.x, base + 0.12, lot.z))
    return
  }

  if (height > SETBACK_HEIGHT) {
    const podium = height * (0.52 + seeded(lot.seed, 3) * 0.14)
    const setback = 0.7 + seeded(lot.seed, 4) * 0.14
    massing.push(box(width, podium, depth, lot.x, base + podium / 2, lot.z))
    massing.push(box(width * setback, height - podium, depth * setback, lot.x, base + podium + (height - podium) / 2, lot.z))
    trim.push(box(width * 1.05, 0.5, depth * 1.05, lot.x, base + podium + 0.25, lot.z))
    trim.push(box(width * setback * 1.08, 0.7, depth * setback * 1.08, lot.x, base + height + 0.35, lot.z))
  } else {
    massing.push(box(width, height, depth, lot.x, base + height / 2, lot.z))
    trim.push(box(width * 1.07, 0.6, depth * 1.07, lot.x, base + height + 0.3, lot.z))
  }

  if (towerHeight > 0 && lot.height >= towerHeight * MAST_THRESHOLD) {
    const mastHeight = Math.min(height * 0.18, 8)
    if (mastHeight > 0.4) {
      const mast = new THREE.CylinderGeometry(0.2, 0.36, mastHeight, 5)
      mast.translate(lot.x, base + height + 0.7 + mastHeight / 2, lot.z)
      trim.push(mast)
    }
  }
}

/** A lot whose height is unmeasured: a fenced parcel with no massing, so it claims nothing. */
function fence(lot: AtlasCityLot): THREE.BufferGeometry[] {
  const half = lot.footprint / 2
  const base = PAD_HEIGHT
  const parts: THREE.BufferGeometry[] = []
  for (const [x, z] of [[-half, -half], [half, -half], [-half, half], [half, half]] as const) {
    parts.push(box(0.4, lot.height, 0.4, lot.x + x, base + lot.height / 2, lot.z + z))
  }
  parts.push(box(lot.footprint, 0.24, 0.24, lot.x, base + lot.height, lot.z - half))
  parts.push(box(lot.footprint, 0.24, 0.24, lot.x, base + lot.height, lot.z + half))
  parts.push(box(0.24, 0.24, lot.footprint, lot.x - half, base + lot.height, lot.z))
  parts.push(box(0.24, 0.24, lot.footprint, lot.x + half, base + lot.height, lot.z))
  return parts
}

/**
 * Every street in a town as one ribbon buffer at the given width.
 *
 * Called twice -- once wide and dark, once narrow and pale -- which is the whole trick that makes a
 * road read as a road rather than as a line, and is the same pair the capacity city draws one level
 * down. Shared with that city through {@link ribbonPositions}, so the two surfaces cannot drift.
 */
function streetGeometry(
  plan: AtlasCityPlan,
  width: number,
  y: number,
): THREE.BufferGeometry | null {
  if (plan.streets.length === 0) return null
  const positions: number[] = []
  for (const street of plan.streets) {
    ribbonPositions(street.points, width, null, 0, positions, y)
  }
  if (positions.length === 0) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return geometry
}
