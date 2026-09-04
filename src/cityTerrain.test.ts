import { describe, expect, it } from 'vitest'
import { planField } from './cityField'
import { traceStreamlines } from './cityStreamlines'
import { buildPlanarGraph, breakCrossings, extractFaces } from './cityGraph'
import { buildBlocks, type CityBlockField } from './cityBlocks'
import {
  DISTRICT_CHARACTERS,
  SCENERY_USES,
  blockKey,
  planLandform,
  planTerrain,
  reliefAt,
  riverProximity,
  smoothPolyline,
  waterBlocks,
  type TerrainInput,
} from './cityTerrain'

const CELL = 40
const STREET = 15
const DISTRICTS = ['schema:dbo', 'schema:reporting', 'schema:archive']

/**
 * Builds a real block field the way `cityPlan` does, because terrain now dresses the faces of the
 * street graph rather than a lattice. The parameters mirror the planner's own so the fixture is a
 * fair stand-in for a city the app would actually draw.
 */
function buildField(seed: string, radius: number, separation: number): CityBlockField {
  const span = radius * 1.1
  const field = planField({ seed, centreX: 0, centreZ: 0, radius })
  const lines = traceStreamlines({
    field,
    minX: -span,
    maxX: span,
    minZ: -span,
    maxZ: span,
    separation,
    edgeSeparationScale: 2.3,
    minLength: separation * 1.45,
    maxStreamlines: 700,
  })
  const opts = { weldRadius: separation * 0.12, snapRadius: separation * 0.75, minStub: separation * 0.35 }
  const graph = breakCrossings(
    buildPlanarGraph(lines, opts),
    {
      seed: 7,
      targetCrossroadShare: 0.24,
      protectLength: separation * 7,
      maxRemovalShare: 0.3,
      maxMergedBlocks: 3,
      maxBlockArea: separation * separation * 7,
    },
    opts,
  )
  return buildBlocks(graph, extractFaces(graph), { setback: 5, minCapacity: 10 })
}

/**
 * A whole terrain input: a real field, its landform, and a stable scatter of built and facility
 * blocks drawn only from ground the river does not reach, the same withholding `cityPlan` performs.
 */
function scene(
  overrides: { seed?: string; radius?: number; separation?: number } = {},
): TerrainInput {
  const seed = overrides.seed ?? 'db:sales'
  const radius = overrides.radius ?? 700
  const separation = overrides.separation ?? 58
  const span = radius * 1.1
  const field = buildField(seed, radius, separation)
  const landform = planLandform({ seed, minX: -span, maxX: span, minZ: -span, maxZ: span, streetWidth: STREET, cell: CELL })
  const water = waterBlocks(field, landform.river)
  const dry = field.blocks.filter(block => !water.has(block.id)).map(block => block.id)
  // A fixed pattern so the fixture is stable: every third dry block built, two more given to civic use.
  const occupied = new Set(dry.filter((_id, index) => index % 3 === 0))
  const facilities = new Set(dry.filter((_id, index) => index % 3 === 1).slice(0, 2))
  return { field, landform, occupied, facilities, water, districtIds: DISTRICTS, seed }
}

describe('planTerrain', () => {
  it('is a pure function of its input', () => {
    const first = planTerrain(scene())
    const second = planTerrain(scene())
    expect([...second.blocks.entries()]).toEqual([...first.blocks.entries()])
    expect(second.river).toEqual(first.river)
    expect([...second.characters.entries()]).toEqual([...first.characters.entries()])
    expect(second.relief).toEqual(first.relief)
  })

  it('gives two different databases two different landscapes', () => {
    const sales = planTerrain(scene({ seed: 'db:sales' }))
    const warehouse = planTerrain(scene({ seed: 'db:warehouse' }))
    expect(warehouse.river).not.toEqual(sales.river)
  })

  it('dresses every block in the field exactly once', () => {
    const input = scene()
    const terrain = planTerrain(input)
    expect(terrain.blocks.size).toBe(input.field.blocks.length)
    for (const block of input.field.blocks) {
      const dressed = terrain.blocks.get(blockKey(block.id))
      expect(dressed).toBeDefined()
      // The block id rides in the legacy `col`; the row is gone, fixed at zero.
      expect(dressed!.col).toBe(block.id)
      expect(dressed!.row).toBe(0)
    }
  })

  it('never dresses a measured block as scenery', () => {
    const input = scene()
    const terrain = planTerrain(input)
    for (const id of input.occupied) expect(terrain.blocks.get(blockKey(id))!.use).toBe('built')
    for (const id of input.facilities) expect(terrain.blocks.get(blockKey(id))!.use).toBe('facility')
    // And the converse: scenery only ever lands on ground the plan left empty.
    for (const block of terrain.blocks.values()) {
      if (SCENERY_USES.includes(block.use)) {
        expect(input.occupied.has(block.col)).toBe(false)
        expect(input.facilities.has(block.col)).toBe(false)
      }
    }
  })

  it('leaves every measured block at ground level so heights stay comparable', () => {
    const terrain = planTerrain(scene())
    for (const block of terrain.blocks.values()) {
      if (block.use === 'built' || block.use === 'facility') expect(block.relief).toBe(0)
    }
    // Relief is not simply switched off everywhere — the point is a horizon at the edges.
    expect([...terrain.blocks.values()].some(block => Math.abs(block.relief) > 0.01)).toBe(true)
  })

  it('routes a river across a city large enough to hold one', () => {
    const terrain = planTerrain(scene())
    expect(terrain.river.length).toBeGreaterThan(2)
    const first = terrain.river[0]
    const last = terrain.river[terrain.river.length - 1]
    // It crosses, rather than tracing an edge or doubling back on itself.
    const spans = Math.hypot(last.x - first.x, last.z - first.z)
    expect(spans).toBeGreaterThan(terrain.bounds.maxX * 0.5)
  })

  it('leaves a small town dry rather than drowning it', () => {
    const seed = 'db:sales'
    const field = buildField(seed, 700, 58)
    // A crossing under the minimum span gets no river at all, however large the field beneath it.
    const landform = planLandform({ seed, minX: -120, maxX: 120, minZ: -120, maxZ: 120, streetWidth: STREET, cell: CELL })
    const terrain = planTerrain({
      field,
      landform,
      occupied: new Set(),
      facilities: new Set(),
      water: new Set(),
      districtIds: DISTRICTS,
      seed,
    })
    expect(terrain.river).toEqual([])
    expect([...terrain.blocks.values()].every(block => block.use !== 'water')).toBe(true)
  })

  it('never floods a measured building', () => {
    for (const seed of ['db:sales', 'db:warehouse', 'db:archive', 'db:ops', 'db:telemetry']) {
      const input = scene({ seed })
      const terrain = planTerrain(input)
      if (input.landform.river.length < 2) continue
      // Water is withheld from placement, so no occupied or facility block is ever drawn as water.
      for (const id of [...input.occupied, ...input.facilities]) {
        expect(terrain.blocks.get(blockKey(id))!.use).not.toBe('water')
      }
      // And every block the river actually reaches is one placement was kept off, and is drawn as water.
      for (const id of input.water) {
        expect(input.occupied.has(id)).toBe(false)
        expect(input.facilities.has(id)).toBe(false)
        expect(terrain.blocks.get(blockKey(id))!.use).toBe('water')
      }
    }
  })

  it('gives every district a character without claiming anything about it', () => {
    const terrain = planTerrain(scene())
    for (const districtId of DISTRICTS) {
      expect(DISTRICT_CHARACTERS).toContain(terrain.characters.get(districtId))
    }
    // Stable across plans, because it is hashed from the id alone.
    expect([...planTerrain(scene()).characters.entries()]).toEqual([...terrain.characters.entries()])
  })
})

describe('reliefAt', () => {
  it('is continuous and bounded by its own amplitude', () => {
    const terrain = planTerrain(scene())
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
