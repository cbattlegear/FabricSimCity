import { stableHash, ATLAS_SPACING } from './atlasLayout'
import type { AtlasPoint } from './atlasCity'

/**
 * The country the server atlas's towns stand in.
 *
 * The atlas used to draw its capacities on nothing: a flat clear colour, a faint helper grid, and a
 * scatter of plates floating in it. That is a chart of cities rather than a map of them — there is no
 * ground for a town to sit on, no reason for one town to be where it is, and nothing at all in the
 * two thirds of the sheet no capacity occupies. The capacity city one level down had exactly this
 * problem and solved it with land cover; this is the same answer at the regional scale.
 *
 * **Nothing here is evidence.** Not one coordinate comes from a measurement. The river, the lakes and
 * the woodland are a fixed, seeded landscape that is byte-identical every session and does not change
 * when a capacity grows, is added, or is dropped. It is drawn because a map has ground, and the legend
 * says as much in as many words.
 *
 * The landscape is generated once for a fixed extent rather than fitted to whatever is on screen, for
 * one reason that matters: if the terrain were fitted, adding a capacity would slide the coastline
 * across the sheet, and a landscape that moves is one a reader will eventually try to read.
 */

/** Half-extent of the generated landscape, in world units. Comfortably past the layout's outermost slot. */
export const TERRAIN_EXTENT = 900

/** Fixed seed for the landscape. Not the server name: the ground must not move when the server does. */
export const TERRAIN_SEED = 'sqlsimcity:atlas:terrain'

/** How wide the river is at its banks, and the darker edge drawn under it. */
export const RIVER_WIDTH = 11
export const RIVER_BANK_WIDTH = 15

/** Ground cover classes the regional landscape uses, all of them borrowed from the city's palette. */
export type AtlasTerrainKind = 'water' | 'woodland' | 'park' | 'orchard'

export interface AtlasTerrainPatch {
  readonly kind: AtlasTerrainKind
  /** Closed outline, in world units, absolute (not relative to any town). */
  readonly points: readonly AtlasPoint[]
}

export interface AtlasTerrain {
  readonly extent: number
  /** Centreline of the river, crossing the whole sheet. */
  readonly river: readonly AtlasPoint[]
  readonly patches: readonly AtlasTerrainPatch[]
}

/** Deterministic 0..1 draw. Same key, same value, forever. */
function draw(key: string): number {
  return (stableHash(`${TERRAIN_SEED}:${key}`) % 100_000) / 100_000
}

/**
 * A soft closed blob of the given mean radius, built the same way a town's outline is.
 *
 * Sharing the construction is deliberate: a lake and a town edge drawn by different rules read as
 * belonging to different drawings, and the point of this work is that they do not.
 */
function blob(cx: number, cz: number, radius: number, key: string, vertices = 26): AtlasPoint[] {
  const phases = [draw(`${key}:p0`), draw(`${key}:p1`), draw(`${key}:p2`)].map(
    value => value * Math.PI * 2,
  )
  const points: AtlasPoint[] = []
  for (let index = 0; index < vertices; index += 1) {
    const angle = (index / vertices) * Math.PI * 2
    const wobble =
      1 +
      0.22 * Math.sin(angle * 2 + phases[0]) +
      0.13 * Math.sin(angle * 3 + phases[1]) +
      0.08 * Math.sin(angle * 5 + phases[2])
    points.push({ x: cx + Math.cos(angle) * radius * wobble, z: cz + Math.sin(angle) * radius * wobble })
  }
  return points
}

/**
 * Where the landscape's features are allowed to sit.
 *
 * The layout hands towns the points of a lattice at {@link ATLAS_SPACING}; the landscape takes the
 * gaps *between* those points. That single offset is what lets the terrain be generated in complete
 * ignorance of which capacities exist while still never dropping a lake on a town centre — and it
 * stays true however many capacities the server turns out to have.
 */
function interstices(extent: number): Array<{ x: number; z: number; key: string }> {
  const half = ATLAS_SPACING / 2
  const reach = Math.ceil(extent / ATLAS_SPACING)
  const cells: Array<{ x: number; z: number; key: string }> = []
  for (let row = -reach; row <= reach; row += 1) {
    for (let column = -reach; column <= reach; column += 1) {
      cells.push({
        x: column * ATLAS_SPACING + half,
        z: row * ATLAS_SPACING + half,
        key: `${column}:${row}`,
      })
    }
  }
  return cells
}

export function planAtlasTerrain(extent: number = TERRAIN_EXTENT): AtlasTerrain {
  /*
   * The river meanders at the scale you actually look at.
   *
   * Its first draft wobbled as a fraction of the sheet's full extent, which meant one lazy wave across
   * the entire country: at the zoom a reader uses -- a handful of towns -- it drew a perfectly straight
   * diagonal band, which is a ruler, not a river. Tying the wavelength to {@link ATLAS_SPACING} instead
   * gives it a bend roughly every few towns, which is what a river does on a real sheet.
   */
  const river: AtlasPoint[] = []
  const heading = (draw('river:heading') - 0.5) * 0.9
  const steps = 220
  const span = extent * 1.25
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps
    const along = (t * 2 - 1) * span
    const phase = along / ATLAS_SPACING
    const meander =
      Math.sin(phase * 0.62 + draw('river:a') * Math.PI * 2) * ATLAS_SPACING * 0.86 +
      Math.sin(phase * 1.47 + draw('river:b') * Math.PI * 2) * ATLAS_SPACING * 0.31 +
      Math.sin(phase * 3.11 + draw('river:c') * Math.PI * 2) * ATLAS_SPACING * 0.12
    const drift = (draw('river:drift') - 0.5) * extent * 0.5
    river.push({
      x: Math.cos(heading) * along - Math.sin(heading) * (meander + drift),
      z: Math.sin(heading) * along + Math.cos(heading) * (meander + drift),
    })
  }

  /*
   * Cover a bit under two thirds of the gaps, with a second smaller patch in some of them.
   *
   * Denser than this and the towns lose their figure against the ground; sparser and the sheet reads
   * as mostly nothing, which is the problem this exists to solve.
   */
  const patches: AtlasTerrainPatch[] = []
  for (const cell of interstices(extent)) {
    if (Math.hypot(cell.x, cell.z) > extent) continue
    for (const pass of ['a', 'b'] as const) {
      const roll = draw(`patch:${cell.key}:${pass}`)
      if (roll > (pass === 'a' ? 0.66 : 0.3)) continue
      const kind: AtlasTerrainKind =
        roll < 0.09 ? 'water' : roll < 0.3 ? 'woodland' : roll < 0.48 ? 'park' : 'orchard'
      const scale = pass === 'a' ? 1 : 0.62
      const radius = ATLAS_SPACING * (0.11 + draw(`patch:${cell.key}:${pass}:r`) * 0.15) * scale
      // Excursion is capped so a patch stays inside its own gap, allowing for the blob's wobble. Towns
      // sit on the lattice nodes, and a lake that wanders onto one swallows the town it lands on.
      const room = Math.max(0, ATLAS_SPACING * 0.5 - radius * 1.25 - 6)
      const angle = draw(`patch:${cell.key}:${pass}:a`) * Math.PI * 2
      const reach = draw(`patch:${cell.key}:${pass}:d`) * room
      patches.push({
        kind,
        points: blob(
          cell.x + Math.cos(angle) * reach,
          cell.z + Math.sin(angle) * reach,
          radius,
          `${cell.key}:${pass}`,
        ),
      })
    }
  }

  return { extent, river, patches }
}
