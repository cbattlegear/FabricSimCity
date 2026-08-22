import { describe, expect, it } from 'vitest'
import {
  DISTRICT_CHARACTERS,
  SCENERY_USES,
  blockKey,
  planTerrain,
  reliefAt,
  riverProximity,
  smoothPolyline,
  type TerrainInput,
} from './cityTerrain'

const CELL = 40
const STREET = 15
const MARGIN = 11

function input(overrides: Partial<TerrainInput> = {}): TerrainInput {
  const blockCols = overrides.blockCols ?? 12
  const blockRows = overrides.blockRows ?? 12
  // A realistic scatter: roughly half the grid built, in a fixed pattern so the fixture is stable.
  const occupied = new Set<string>()
  for (let row = 0; row < blockRows; row += 1) {
    for (let col = 0; col < blockCols; col += 1) {
      if ((col * 7 + row * 13) % 5 < 2) occupied.add(blockKey(col, row))
    }
  }
  const facilities = new Set([blockKey(1, 1), blockKey(blockCols - 2, blockRows - 2)])
  for (const key of facilities) occupied.delete(key)

  return {
    blockCols,
    blockRows,
    pitchX: CELL + STREET,
    pitchZ: CELL + STREET,
    cell: CELL,
    streetWidth: STREET,
    lotMargin: MARGIN,
    occupied,
    facilities,
    districtIds: ['schema:dbo', 'schema:reporting', 'schema:archive'],
    seed: 'db:sales',
    ...overrides,
  }
}

describe('planTerrain', () => {
  it('is a pure function of its input', () => {
    const first = planTerrain(input())
    const second = planTerrain(input())
    expect([...second.blocks.entries()]).toEqual([...first.blocks.entries()])
    expect(second.river).toEqual(first.river)
    expect([...second.characters.entries()]).toEqual([...first.characters.entries()])
    expect(second.relief).toEqual(first.relief)
  })

  it('gives two different databases two different landscapes', () => {
    const sales = planTerrain(input({ seed: 'db:sales' }))
    const warehouse = planTerrain(input({ seed: 'db:warehouse' }))
    expect(warehouse.river).not.toEqual(sales.river)
  })

  it('dresses every block in the grid exactly once', () => {
    const terrain = planTerrain(input())
    expect(terrain.blocks.size).toBe(12 * 12)
    for (let row = 0; row < 12; row += 1) {
      for (let col = 0; col < 12; col += 1) {
        const block = terrain.blocks.get(blockKey(col, row))
        expect(block).toBeDefined()
        expect(block!.col).toBe(col)
        expect(block!.row).toBe(row)
      }
    }
  })

  it('never dresses a measured block as scenery', () => {
    const options = input()
    const terrain = planTerrain(options)
    for (const key of options.occupied) expect(terrain.blocks.get(key)!.use).toBe('built')
    for (const key of options.facilities) expect(terrain.blocks.get(key)!.use).toBe('facility')
    // And the converse: scenery only ever lands on ground the plan left empty.
    for (const block of terrain.blocks.values()) {
      if (SCENERY_USES.includes(block.use)) {
        expect(options.occupied.has(block.key)).toBe(false)
        expect(options.facilities.has(block.key)).toBe(false)
      }
    }
  })

  it('leaves every measured block at ground level so heights stay comparable', () => {
    const options = input()
    const terrain = planTerrain(options)
    for (const block of terrain.blocks.values()) {
      if (block.use === 'built' || block.use === 'facility') expect(block.relief).toBe(0)
    }
    // Relief is not simply switched off everywhere — the point is a horizon at the edges.
    expect([...terrain.blocks.values()].some(block => Math.abs(block.relief) > 0.01)).toBe(true)
  })

  it('routes a river across a city large enough to hold one', () => {
    const terrain = planTerrain(input())
    expect(terrain.river.length).toBeGreaterThan(2)
    const first = terrain.river[0]
    const last = terrain.river[terrain.river.length - 1]
    // It crosses, rather than tracing an edge or doubling back on itself.
    const spans = Math.hypot(last.x - first.x, last.z - first.z)
    expect(spans).toBeGreaterThan(terrain.bounds.maxX * 0.5)
  })

  it('leaves a small town dry rather than drowning it', () => {
    const terrain = planTerrain(input({ blockCols: 4, blockRows: 4, occupied: new Set(), facilities: new Set() }))
    expect(terrain.river).toEqual([])
    expect([...terrain.blocks.values()].every(block => block.use !== 'water')).toBe(true)
  })

  it('never floods a measured building', () => {
    // The closest a building edge can be to the corridor the river runs along.
    const clearance = STREET / 2 + MARGIN / 2
    for (const seed of ['db:sales', 'db:warehouse', 'db:archive', 'db:ops', 'db:telemetry']) {
      const options = input({ seed })
      const terrain = planTerrain(options)
      if (terrain.river.length < 2) continue
      for (const key of [...options.occupied, ...options.facilities]) {
        const block = terrain.blocks.get(key)!
        const near = riverProximity(terrain.river, block.x, block.z)
        // Measured from the block centre, so the building's own half-cell is the first thing the
        // water would have to cross.
        expect(near.distance).toBeGreaterThan(near.halfWidth)
        expect(near.distance).toBeGreaterThan(clearance)
      }
    }
  })

  it('gives every district a character without claiming anything about it', () => {
    const terrain = planTerrain(input())
    for (const districtId of ['schema:dbo', 'schema:reporting', 'schema:archive']) {
      expect(DISTRICT_CHARACTERS).toContain(terrain.characters.get(districtId))
    }
    // Stable across plans, because it is hashed from the id alone.
    expect([...planTerrain(input()).characters.entries()]).toEqual([...terrain.characters.entries()])
  })
})

describe('reliefAt', () => {
  it('is continuous and bounded by its own amplitude', () => {
    const terrain = planTerrain(input())
    for (let step = 0; step < 40; step += 1) {
      const x = step * 37
      const z = step * 53
      const height = reliefAt(terrain.relief, x, z)
      expect(Math.abs(height)).toBeLessThanOrEqual(terrain.relief.amplitude + 1e-9)
      const nearby = reliefAt(terrain.relief, x + 0.5, z + 0.5)
      expect(Math.abs(nearby - height)).toBeLessThan(terrain.relief.amplitude)
    }
  })
})

describe('smoothPolyline', () => {
  it('starts and ends exactly where the corridor did', () => {
    const corridor = [
      { x: 0, z: 0 },
      { x: 100, z: 0 },
      { x: 100, z: 100 },
      { x: 200, z: 100 },
    ]
    const smoothed = smoothPolyline(corridor, 6)
    expect(smoothed[0]).toEqual(corridor[0])
    expect(smoothed[smoothed.length - 1]).toEqual(corridor[corridor.length - 1])
    expect(smoothed.length).toBeGreaterThan(corridor.length)
  })

  it('passes a line too short to bend straight through', () => {
    expect(smoothPolyline([{ x: 1, z: 2 }], 6)).toEqual([{ x: 1, z: 2 }])
    expect(smoothPolyline([{ x: 1, z: 2 }, { x: 3, z: 4 }], 6)).toEqual([
      { x: 1, z: 2 },
      { x: 3, z: 4 },
    ])
  })
})

describe('riverProximity', () => {
  it('reports zero distance on the centreline and a unit tangent along it', () => {
    const river = [
      { x: 0, z: 0, halfWidth: 10 },
      { x: 100, z: 0, halfWidth: 10 },
      { x: 200, z: 0, halfWidth: 10 },
    ]
    const on = riverProximity(river, 50, 0)
    expect(on.distance).toBeLessThan(1e-9)
    expect(Math.hypot(on.tangent.x, on.tangent.z)).toBeCloseTo(1, 6)
    expect(Math.abs(on.tangent.x)).toBeCloseTo(1, 6)

    const off = riverProximity(river, 50, 25)
    expect(off.distance).toBeCloseTo(25, 6)
    expect(off.halfWidth).toBeCloseTo(10, 6)
  })
})
