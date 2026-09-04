import type { Point } from './cityStreamlines'
import type { CityBlockField } from './cityBlocks'

/**
 * A thin compatibility layer that lets code written for the old lattice keep asking its questions.
 *
 * The lattice exposed a `CityWarp`: give it a block address `(col, row)` and it returned the block's
 * corners, its centre, or the block a world point fell in. Half the app was written against that
 * shape — the address book, the district washes on the 3D ground, the map's own bounds. Rewriting
 * every one of those call sites to walk a planar graph would be a great deal of churn for no visible
 * change, so instead the graph pretends to still be a warp.
 *
 * The pretence is deliberately lossy. A block no longer has a row, so `row` is always zero and `col`
 * is simply the block's id; the pair still round-trips through the address book as `Block C1`. And a
 * block is no longer a quadrilateral, so `blockCorners` returns a polygon of however many sides the
 * street network left behind rather than the old four-tuple. Nothing here is a measurement: block
 * shapes come from the seeded streets, and which world point lands in which block is geometry, not a
 * claim about the capacity.
 */
export interface CityWarp {
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
  /** The block's boundary, of any number of sides. `col` is a block id; `row` is ignored. */
  blockCorners(col: number, row: number): readonly Point[]
  /** The block's centroid, where its building stands. `col` is a block id; `row` is ignored. */
  blockCenter(col: number, row: number): Point
  /** The block a world point falls in, or the nearest one if it fell in the street. */
  blockAt(x: number, z: number): { col: number; row: number }
}

/**
 * Wraps a {@link CityBlockField} so it answers the old `CityWarp` questions.
 *
 * `blockAt` inherits the field's own fall-back to the nearest block, and only reaches its own scan
 * when the field's spatial index has nothing bucketed near the point at all — which happens for a
 * query miles outside the built-up area, where naming the nearest block is still the least surprising
 * answer.
 */
export function makeBlockWarp(field: CityBlockField): CityWarp {
  const nearestBlockId = (x: number, z: number): number => {
    let bestId = -1
    let bestDistance = Infinity
    for (const block of field.blocks) {
      const distance = Math.hypot(block.centroid.x - x, block.centroid.z - z)
      if (distance < bestDistance) {
        bestDistance = distance
        bestId = block.id
      }
    }
    return bestId
  }

  return {
    minX: field.minX,
    maxX: field.maxX,
    minZ: field.minZ,
    maxZ: field.maxZ,
    blockCorners: col => field.block(col)?.polygon ?? [],
    blockCenter: col => field.block(col)?.centroid ?? { x: 0, z: 0 },
    blockAt: (x, z) => ({ col: (field.blockAt(x, z) ?? field.block(nearestBlockId(x, z)))?.id ?? 0, row: 0 }),
  }
}
