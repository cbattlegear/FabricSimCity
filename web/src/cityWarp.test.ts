import { describe, expect, it } from 'vitest'
import { centroid, inradius, planWarp, WARP_HEADROOM, type CityWarpInput } from './cityWarp'

const CELL = 40
const STREET = 15
const PITCH = (CELL + STREET) * WARP_HEADROOM

function input(overrides: Partial<CityWarpInput> = {}): CityWarpInput {
  const blockCols = overrides.blockCols ?? 14
  const blockRows = overrides.blockRows ?? 12
  return {
    blockCols,
    blockRows,
    pitchX: PITCH,
    pitchZ: PITCH,
    cell: CELL,
    streetWidth: STREET,
    arterialCols: lines(blockCols),
    arterialRows: lines(blockRows),
    seed: 'db:sales',
    plazas: [{ col: 5, row: 4 }],
    ...overrides,
  }
}

/** An irregular arterial rhythm of the kind `planArterials` produces, so the twist has real seams. */
function lines(extent: number): number[] {
  if (extent <= 3) return [0, extent]
  const out = [0]
  const gaps = [4, 6, 3, 7, 5]
  let at = 0
  let index = 0
  while (at < extent) {
    at += gaps[index % gaps.length]
    index += 1
    if (at >= extent - 1) break
    out.push(at)
  }
  out.push(extent)
  return out
}

describe('planWarp', () => {
  it('draws the same city twice for one seed, and a different one for another', () => {
    const left = planWarp(input())
    const right = planWarp(input())
    const other = planWarp(input({ seed: 'db:orders' }))

    expect(left.node(3, 5)).toEqual(right.node(3, 5))
    expect(left.node(3, 5)).not.toEqual(other.node(3, 5))
  })

  it('moves the junctions themselves, which is the whole point of the module', () => {
    const warp = planWarp(input())
    // A lattice puts every node of a row at the same z. If that is still true, nothing was warped
    // and the map would read as a grid however hard the streets between the nodes are curved.
    const row = [0, 1, 2, 3, 4, 5, 6].map(col => warp.node(col, 5).z)
    const spread = Math.max(...row) - Math.min(...row)
    expect(spread).toBeGreaterThan(PITCH * 0.25)

    const column = [0, 1, 2, 3, 4, 5, 6].map(row => warp.node(5, row).x)
    expect(Math.max(...column) - Math.min(...column)).toBeGreaterThan(PITCH * 0.25)
  })

  it('varies block size instead of stamping one pitch across the whole map', () => {
    const warp = planWarp(input())
    const widths: number[] = []
    for (let col = 0; col < 14; col += 1) {
      widths.push(warp.node(col + 1, 0).x - warp.node(col, 0).x)
    }
    expect(Math.max(...widths) / Math.min(...widths)).toBeGreaterThan(1.2)
  })

  /*
   * The one rule here that is not taste.
   *
   * A building stands at its block's centroid and occupies `cell` square. The road runs along the
   * block edge. If warping ever pulls an edge nearer the centroid than half a building plus half a
   * carriageway, a building is standing in the road — and it would be one building somewhere in a
   * city of a thousand, on one seed, which is exactly the kind of defect that ships.
   */
  it('never pinches a block tighter than the building it has to hold', () => {
    const required = CELL / 2 + STREET / 2
    for (const seed of ['db:sales', 'db:orders', 'db:reporting', 'db:tiny', 'db:sprawl']) {
      for (const [cols, rows] of [[7, 7], [14, 12], [23, 19], [40, 31]]) {
        const warp = planWarp(input({ seed, blockCols: cols, blockRows: rows }))
        for (let row = 0; row < rows; row += 1) {
          for (let col = 0; col < cols; col += 1) {
            const room = inradius(warp.blockCorners(col, row))
            expect(
              room,
              `${seed} ${cols}x${rows} block ${col},${row} kept only ${room.toFixed(1)} of ${required}`,
            ).toBeGreaterThanOrEqual(required - 1e-6)
          }
        }
      }
    }
  })

  it('spends the whole displacement budget on a normal city rather than quietly backing off', () => {
    // The fit is a safety net, not the design. If it starts firing on ordinary seeds the field is
    // mistuned and the map is being flattened back toward the grid without anyone noticing.
    for (const seed of ['db:sales', 'db:orders', 'db:reporting', 'db:tiny', 'db:sprawl']) {
      for (const [cols, rows] of [[7, 7], [14, 12], [23, 19], [40, 31]]) {
        expect(planWarp(input({ seed, blockCols: cols, blockRows: rows })).strength).toBe(1)
      }
    }
  })

  it('keeps a plaza-heavy city inside the same rule', () => {
    const plazas = [
      { col: 3, row: 3 },
      { col: 4, row: 9 },
      { col: 11, row: 5 },
      { col: 12, row: 11 },
    ]
    const warp = planWarp(input({ plazas }))
    const required = CELL / 2 + STREET / 2
    for (let row = 0; row < 12; row += 1) {
      for (let col = 0; col < 14; col += 1) {
        expect(inradius(warp.blockCorners(col, row))).toBeGreaterThanOrEqual(required - 1e-6)
      }
    }
  })

  it('opens ground around a plaza rather than leaving it an ordinary crossing', () => {
    const bare = planWarp(input({ plazas: [] }))
    const withPlaza = planWarp(input({ plazas: [{ col: 5, row: 4 }] }))
    const spread = (warp: ReturnType<typeof planWarp>) => {
      const ring = [
        warp.node(4, 4),
        warp.node(6, 4),
        warp.node(5, 3),
        warp.node(5, 5),
      ]
      const middle = warp.node(5, 4)
      return ring.reduce((total, point) =>
        total + Math.hypot(point.x - middle.x, point.z - middle.z), 0)
    }
    expect(spread(withPlaza)).toBeLessThan(spread(bare))
  })

  it('finds the node nearest a point even though division no longer inverts the mapping', () => {
    const warp = planWarp(input())
    for (const [col, row] of [[0, 0], [3, 7], [9, 2], [14, 12], [6, 6]]) {
      const point = warp.node(col, row)
      expect(warp.nearestNode(point.x, point.z)).toEqual({ col, row })
    }
  })

  it('finds the block a point falls in from the block centre', () => {
    const warp = planWarp(input())
    for (const [col, row] of [[0, 0], [3, 7], [9, 2], [13, 11]]) {
      const centre = warp.blockCenter(col, row)
      expect(warp.blockAt(centre.x, centre.z)).toEqual({ col, row })
    }
  })

  it('reports bounds that actually contain the warped city', () => {
    const warp = planWarp(input())
    for (let row = 0; row <= 12; row += 1) {
      for (let col = 0; col <= 14; col += 1) {
        const point = warp.node(col, row)
        expect(point.x).toBeGreaterThanOrEqual(warp.minX)
        expect(point.x).toBeLessThanOrEqual(warp.maxX)
        expect(point.z).toBeGreaterThanOrEqual(warp.minZ)
        expect(point.z).toBeLessThanOrEqual(warp.maxZ)
      }
    }
  })

  it('fronts a building on the middle of its own north kerb', () => {
    const warp = planWarp(input())
    const frontage = warp.blockFrontage(4, 6)
    const left = warp.node(4, 6)
    const right = warp.node(5, 6)
    expect(frontage.x).toBeCloseTo((left.x + right.x) / 2, 6)
    expect(frontage.z).toBeCloseTo((left.z + right.z) / 2, 6)
  })

  it('survives a one-block city without dividing by zero', () => {
    const warp = planWarp(input({ blockCols: 1, blockRows: 1, plazas: [] }))
    expect(Number.isFinite(warp.node(0, 0).x)).toBe(true)
    expect(Number.isFinite(warp.node(1, 1).z)).toBe(true)
    expect(inradius(warp.blockCorners(0, 0))).toBeGreaterThan(0)
  })
})

describe('inradius', () => {
  it('measures a square as half its side', () => {
    expect(inradius([
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 10, z: 10 },
      { x: 0, z: 10 },
    ])).toBeCloseTo(5, 6)
  })

  it('reports the tight direction of a sheared quad, not the loose one', () => {
    const room = inradius([
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 14, z: 4 },
      { x: 4, z: 4 },
    ])
    expect(room).toBeLessThan(5)
    expect(room).toBeGreaterThan(0)
  })
})

describe('centroid', () => {
  it('averages the points it is given', () => {
    expect(centroid([{ x: 0, z: 0 }, { x: 4, z: 8 }])).toEqual({ x: 2, z: 4 })
  })
})
