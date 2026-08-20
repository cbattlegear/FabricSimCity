import { databaseHeight, databaseSide } from './atlas'
import { stableHash } from './atlasLayout'
import type { DatabaseAtlasItem } from './contracts'

/**
 * Plans the small city that stands for one database in the server atlas.
 *
 * The atlas used to draw a database as a single box. That box carried the allocated size in its
 * footprint and nothing else, so a database read as a quantity rather than as a place, and entering
 * one changed metaphor entirely: the level above a city was not a bigger city, it was a bar chart.
 * A database is now a city on the atlas and a city again when entered, which is the whole point of
 * the two surfaces sharing one vocabulary.
 *
 * **Evidence boundary.** Exactly two things here are measured, and they are the same two the
 * database city measures one level down:
 *
 * | Encoded property | Evidence |
 * | --- | --- |
 * | City plot side | allocated bytes, through {@link databaseSide} |
 * | Tallest tower height | used bytes, through {@link databaseHeight} |
 *
 * Everything else follows from those two or is decoration. The lot grid follows from the plot,
 * because {@link LOT_PITCH} is one constant shared by every city: a larger database is a larger
 * city with more blocks in it, and block *size* never varies, so counting blocks and measuring the
 * plot say the same thing rather than two different things. The individual towers below the tallest
 * step down along a fixed profile jittered from the database's stable id; they are skyline, not
 * measurement, and a city's shape never changes between renders of the same database.
 *
 * Unknown stays unknown in both directions and never degrades into a small number. Unknown allocated
 * size yields no city at all -- {@link AtlasCityPlan.sizeKnown} is false and the scene draws the
 * nonquantitative parcel the legend's × marks. Known allocated size with unknown used size yields
 * the real plot and its real lot grid, but every lot is `vacant`: the ground was measured and the
 * skyline was not.
 */

/**
 * Target world units per lot, including that lot's share of the surrounding street. Constant across
 * every database city, which is what lets block count be read as plot area rather than as a separate
 * claim.
 *
 * Sized against the plot mapping rather than picked for looks. {@link databaseSide} spans 12 to 96
 * world units across its whole domain, so a pitch of 12 is what makes a block grid that actually
 * resolves differences over the range real databases occupy -- a gigabyte is five blocks a side, a
 * terabyte six, a petabyte eight -- instead of rounding most of them to the same city.
 */
export const LOT_PITCH = 12

/**
 * Most blocks a city is divided into per side. The plot side is capped by {@link databaseSide} at 96
 * world units, so at the pitch above this bound is never actually reached; it exists so a future
 * change to either mapping cannot produce a grid of unreadable specks.
 */
export const MAX_COLUMNS = 8

/** Share of a grid cell given over to street. The rest is the building's footprint. */
export const STREET_RATIO = 0.36

/** Plot side used when allocated size is unknown. Nonquantitative: it stands for no measurement. */
export const UNKNOWN_SIDE = 26

/** Height of a fenced lot on a plot whose used size is unknown. Claims no skyline. */
export const VACANT_HEIGHT = 2.4

/** How much shorter the outermost ring of a skyline is than downtown, before jitter. Decoration. */
export const DOWNTOWN_FALLOFF = 0.55

/** Floor of the per-lot decorative jitter, so no tower collapses to nothing next to its neighbours. */
export const JITTER_FLOOR = 0.72

export type AtlasCityLotKind = 'tower' | 'vacant'

export interface AtlasCityLot {
  /** Lot centre relative to the city centre, in world units. */
  readonly x: number
  readonly z: number
  readonly footprint: number
  readonly height: number
  readonly kind: AtlasCityLotKind
  /** Stable per-lot seed. Decoration only; never gates a measurement. */
  readonly seed: number
}

/** A street centreline, relative to the city centre. Drawn as a line, never as a claim. */
export interface AtlasCityStreet {
  readonly x1: number
  readonly z1: number
  readonly x2: number
  readonly z2: number
}

export interface AtlasCityPlan {
  readonly databaseId: string
  /** Plot side in world units: the encoded allocated size, or {@link UNKNOWN_SIDE} when unknown. */
  readonly side: number
  /** False when allocated size is unknown, in which case there are no lots and no streets. */
  readonly sizeKnown: boolean
  /** Encoded used size: the height of the tallest tower. Null when used size is unknown. */
  readonly towerHeight: number | null
  readonly columns: number
  readonly lots: readonly AtlasCityLot[]
  readonly streets: readonly AtlasCityStreet[]
}

/**
 * Blocks per side for a plot. Rounds rather than floors so a plot just under a whole block still
 * gains it, and never returns zero, so the smallest measured database is a one-block hamlet rather
 * than bare ground -- bare ground already means "unknown".
 */
export function cityColumns(side: number): number {
  if (!Number.isFinite(side) || side <= 0) return 1
  return Math.min(MAX_COLUMNS, Math.max(1, Math.round(side / LOT_PITCH)))
}

/**
 * Relative tower heights across a city, normalized so the tallest is exactly 1.
 *
 * Normalizing is what keeps the skyline honest: whatever the grid size and whatever the jitter, one
 * tower reaches the full encoded height, so the tallest roofline of two cities can be compared
 * directly and answers "which database has more used bytes".
 */
export function skylineProfile(columns: number, seedFor: (index: number) => number): number[] {
  const centre = (columns - 1) / 2
  const span = Math.max(centre, 1)
  const raw: number[] = []
  for (let row = 0; row < columns; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const ring = Math.max(Math.abs(column - centre), Math.abs(row - centre)) / span
      const jitter = JITTER_FLOOR + ((seedFor(raw.length) % 1000) / 1000) * (1 - JITTER_FLOOR)
      raw.push((1 - ring * DOWNTOWN_FALLOFF) * jitter)
    }
  }
  const peak = Math.max(...raw)
  return peak > 0 ? raw.map(value => value / peak) : raw.map(() => 1)
}

export function planAtlasCity(database: DatabaseAtlasItem): AtlasCityPlan {
  const side = databaseSide(database)
  if (side === null) {
    return {
      databaseId: database.databaseId,
      side: UNKNOWN_SIDE,
      sizeKnown: false,
      towerHeight: null,
      columns: 0,
      lots: [],
      streets: [],
    }
  }

  const towerHeight = databaseHeight(database)
  const columns = cityColumns(side)
  const cell = side / columns
  const footprint = cell * (1 - STREET_RATIO)
  const centre = (columns - 1) / 2
  const seeds: number[] = []
  for (let index = 0; index < columns * columns; index += 1) {
    seeds.push(stableHash(`${database.databaseId}:${index}`))
  }
  const profile = skylineProfile(columns, index => seeds[index] ?? 0)

  const lots: AtlasCityLot[] = []
  for (let row = 0; row < columns; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column
      lots.push({
        x: (column - centre) * cell,
        z: (row - centre) * cell,
        footprint,
        height: towerHeight === null ? VACANT_HEIGHT : towerHeight * (profile[index] ?? 1),
        kind: towerHeight === null ? 'vacant' : 'tower',
        seed: seeds[index] ?? 0,
      })
    }
  }

  return {
    databaseId: database.databaseId,
    side,
    sizeKnown: true,
    towerHeight,
    columns,
    lots,
    streets: cityStreets(side, columns),
  }
}

/** Grid centrelines for a plot: one along each block edge, in both directions, plus the perimeter. */
export function cityStreets(side: number, columns: number): AtlasCityStreet[] {
  const half = side / 2
  const cell = side / columns
  const streets: AtlasCityStreet[] = []
  for (let index = 0; index <= columns; index += 1) {
    const offset = -half + cell * index
    streets.push({ x1: offset, z1: -half, x2: offset, z2: half })
    streets.push({ x1: -half, z1: offset, x2: half, z2: offset })
  }
  return streets
}

/**
 * Signature of everything that changes a city's geometry. The atlas refreshes on a timer, and a
 * refresh that moved no bytes must not churn the GPU, so the scene caches merged geometry by this.
 */
export function cityGeometrySignature(plan: AtlasCityPlan): string {
  return `${plan.databaseId}|${plan.sizeKnown ? plan.side.toFixed(4) : 'unknown'}|${plan.towerHeight?.toFixed(4) ?? 'unknown'}`
}
