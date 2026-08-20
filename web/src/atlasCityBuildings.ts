import * as THREE from 'three'
import type { AtlasCityLot, AtlasCityPlan } from './atlasCity'
import { mergeAndDispose } from './mergeGeometry'

/**
 * Turns an {@link AtlasCityPlan} into the handful of merged geometries the atlas draws it with.
 *
 * One city is one draw call per material rather than one per building. A hundred databases at up to
 * forty-nine lots each is several thousand boxes, and the atlas refreshes on a timer, so merging is
 * what keeps the top-level view affordable — and it makes the whole city a single raycast target, so
 * hovering anywhere in a city selects the database rather than one arbitrary tower.
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

export interface AtlasCityGeometry {
  /** Building bodies. Carries the database tint and is the city's pick target. */
  readonly massing: THREE.BufferGeometry | null
  /** Roof caps, parapets, and masts, drawn in the lighter accent material. */
  readonly trim: THREE.BufferGeometry | null
  /** The plot the city stands on, sized by the encoded allocated bytes. */
  readonly pad: THREE.BufferGeometry
  /** Street centrelines, as a position buffer for {@link THREE.LineSegments}. */
  readonly streets: THREE.BufferGeometry | null
}

export function buildAtlasCityGeometry(plan: AtlasCityPlan): AtlasCityGeometry {
  const pad = new THREE.BoxGeometry(plan.side, PAD_HEIGHT, plan.side)
  pad.translate(0, PAD_HEIGHT / 2, 0)

  const massing: THREE.BufferGeometry[] = []
  const trim: THREE.BufferGeometry[] = []
  for (const lot of plan.lots) {
    if (lot.kind === 'vacant') massing.push(...fence(lot))
    else addTower(lot, plan.towerHeight ?? lot.height, massing, trim)
  }

  return {
    massing: mergeAndDispose(massing),
    trim: mergeAndDispose(trim),
    pad,
    streets: streetGeometry(plan),
  }
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
    // Zero used bytes is zero height, exactly as in the database city: a paved, empty lot.
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

function streetGeometry(plan: AtlasCityPlan): THREE.BufferGeometry | null {
  if (plan.streets.length === 0) return null
  const positions = new Float32Array(plan.streets.length * 6)
  const y = PAD_HEIGHT + 0.06
  plan.streets.forEach((street, index) => {
    positions.set([street.x1, y, street.z1, street.x2, y, street.z2], index * 6)
  })
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  return geometry
}
