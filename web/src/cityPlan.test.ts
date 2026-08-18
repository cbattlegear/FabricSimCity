import { describe, expect, it } from 'vitest'
import {
  BLOCK_COLS,
  BLOCK_ROWS,
  CELLS_PER_BLOCK,
  CIVIC_DISTRICT_ID,
  buildingArchetype,
  buildingFootprint,
  buildingHeight,
  nearestIntersectionId,
  planCity,
  streetPath,
  streetPolyline,
} from './cityPlan'
import type { DatabaseCityObject } from './databaseCityContracts'
import type { Evidence } from './contracts'

const evidence: Evidence = {
  source: 'CatalogSnapshot',
  status: 'Available',
  observedAt: null,
  freshUntil: null,
  reason: 'test',
}

function object(
  objectId: string,
  schemaId: string,
  neighborhoodOrdinal: number,
  objectOrdinal: number,
  reservedPages: string | null = '4096',
  usedPages: string | null = '2048',
): DatabaseCityObject {
  return {
    objectId,
    schemaId,
    schemaName: schemaId.replace('schema:', ''),
    name: objectId,
    kind: 'Table',
    reservedPages8KiB: reservedPages,
    usedPages8KiB: usedPages,
    reservedBytes: reservedPages === null ? null : String(BigInt(reservedPages) * 8192n),
    usedBytes: usedPages === null ? null : String(BigInt(usedPages) * 8192n),
    sizeStatus: reservedPages === null ? 'Unknown' : 'Known',
    sizeReason: null,
    layout: { neighborhoodOrdinal, objectOrdinal, x: 0, z: 0 },
    indexes: [],
    directActivity: { totalOperations: '1', resetEpochToken: null, evidence },
    attributedExposure: {
      executionCount: null,
      totalCpuMicroseconds: null,
      totalDurationMicroseconds: null,
      totalLogicalReads8KiBPages: null,
      confidence: 'Unknown',
      rationale: 'test',
      evidence,
    },
  }
}

function sampleCity(): DatabaseCityObject[] {
  const objects: DatabaseCityObject[] = []
  for (let index = 0; index < 11; index += 1) {
    objects.push(object(`object:dbo:${100 + index}`, 'schema:dbo', 0, index))
  }
  for (let index = 0; index < 5; index += 1) {
    objects.push(object(`object:rep:${300 + index}`, 'schema:reporting', 1, index))
  }
  objects.push(object('object:arc:900', 'schema:archive', 2, 0, null, null))
  return objects
}

describe('buildingFootprint / buildingHeight', () => {
  it('maps exact page counts logarithmically and monotonically', () => {
    expect(buildingFootprint('0')).toBeCloseTo(6, 6)
    expect(buildingFootprint('1')).toBeCloseTo(6.75, 6)
    expect(buildingHeight('0')).toBeCloseTo(0, 6)
    expect(buildingHeight('1')).toBeCloseTo(4.8, 6)

    let previousFootprint = -1
    let previousHeight = -1
    for (const pages of ['0', '1', '8', '128', '2048', '65536', '1048576', '17179869184']) {
      const footprint = buildingFootprint(pages)!
      const height = buildingHeight(pages)!
      expect(footprint).toBeGreaterThan(previousFootprint)
      expect(height).toBeGreaterThan(previousHeight)
      previousFootprint = footprint
      previousHeight = height
    }
  })

  it('adds a fixed amount per doubling', () => {
    expect(buildingFootprint('1023')! - buildingFootprint('511')!).toBeCloseTo(0.75, 6)
    expect(buildingHeight('1023')! - buildingHeight('511')!).toBeCloseTo(4.8, 6)
  })

  it('returns null for unknown size rather than inventing a value', () => {
    expect(buildingFootprint(null)).toBeNull()
    expect(buildingHeight(null)).toBeNull()
    expect(buildingFootprint('not-a-number')).toBeNull()
  })

  it('handles page counts beyond Number.MAX_SAFE_INTEGER without throwing', () => {
    expect(buildingHeight('99999999999999999999999')).toBeGreaterThan(0)
  })
})

describe('buildingArchetype', () => {
  it('selects a style family from exact reserved pages', () => {
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '1', '1'))).toBe('house')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '127', '1'))).toBe('house')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '128', '1'))).toBe('rowhouse')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '2047', '1'))).toBe('rowhouse')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '2048', '1'))).toBe('midrise')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '32768', '1'))).toBe('tower')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '524288', '1'))).toBe('skyscraper')
  })

  it('renders unknown size as a vacant parcel that makes no quantity claim', () => {
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, null, null))).toBe('vacant')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '4096', null))).toBe('vacant')
  })

  it('gives indexed views their own civic style', () => {
    const view = { ...object('a', 'schema:dbo', 0, 0, '4096', '2048'), kind: 'IndexedView' as const }
    expect(buildingArchetype(view)).toBe('civic')
  })
})

describe('planCity', () => {
  it('is independent of the order rows arrive in', () => {
    const forward = planCity(sampleCity())
    const reversed = planCity([...sampleCity()].reverse())
    const shuffled = planCity(
      [...sampleCity()].sort((left, right) => left.objectId.localeCompare(right.objectId)).reverse(),
    )
    for (const plan of [reversed, shuffled]) {
      expect(plan.blockCols).toBe(forward.blockCols)
      expect(plan.blockRows).toBe(forward.blockRows)
      for (const [objectId, lot] of forward.lots) {
        expect(plan.lots.get(objectId)).toEqual(lot)
      }
    }
  })

  it('keeps a building on the same lot when a later bounded page is appended', () => {
    const firstPage = sampleCity().filter(item => item.schemaId === 'schema:dbo')
    const planned = planCity(firstPage)
    const withMorePages = planCity(sampleCity())
    for (const item of firstPage) {
      const before = planned.lots.get(item.objectId)!
      const after = withMorePages.lots.get(item.objectId)!
      expect({ x: after.x, z: after.z }).toEqual({ x: before.x, z: before.z })
    }
  })

  it('never overlaps two lots', () => {
    const plan = planCity(sampleCity())
    const lots = [...plan.lots.values()]
    for (let left = 0; left < lots.length; left += 1) {
      for (let right = left + 1; right < lots.length; right += 1) {
        const a = lots[left]!
        const b = lots[right]!
        const separated =
          Math.abs(a.x - b.x) >= plan.cell - 0.001 || Math.abs(a.z - b.z) >= plan.cell - 0.001
        expect(separated).toBe(true)
      }
    }
  })

  it('keeps every building inside its own district rectangle', () => {
    const plan = planCity(sampleCity())
    for (const lot of plan.lots.values()) {
      const district = plan.districts.find(item => item.districtId === lot.districtId)!
      expect(lot.x).toBeGreaterThan(district.minX)
      expect(lot.x).toBeLessThan(district.maxX)
      expect(lot.z).toBeGreaterThan(district.minZ)
      expect(lot.z).toBeLessThan(district.maxZ)
    }
  })

  it('fronts every lot onto a street it can be entered from', () => {
    const plan = planCity(sampleCity())
    const streetIds = new Set(plan.streets.map(street => street.id))
    for (const lot of plan.lots.values()) {
      expect(streetIds.has(lot.frontageStreetId)).toBe(true)
      expect(Math.abs(lot.accessZ - lot.z)).toBeLessThanOrEqual(plan.cell * BLOCK_ROWS)
      expect(lot.accessX).toBeCloseTo(lot.x, 6)
      expect(lot.rotationY).toBe(lot.facing === 'north' ? Math.PI : 0)
    }
  })

  it('always reserves an infrastructure district that holds no schema objects', () => {
    const plan = planCity(sampleCity())
    expect(plan.civic.districtId).toBe(CIVIC_DISTRICT_ID)
    expect(plan.civic.objectCount).toBe(0)
    expect(plan.districts.some(item => item.districtId === CIVIC_DISTRICT_ID)).toBe(false)
    // The civic district must not move schema districts when live data appears or disappears.
    expect(planCity(sampleCity()).civic).toEqual(plan.civic)
  })

  it('packs a full block before starting the next one', () => {
    const objects = Array.from({ length: CELLS_PER_BLOCK + 1 }, (_unused, index) =>
      object(`object:dbo:${index}`, 'schema:dbo', 0, index))
    const plan = planCity(objects)
    const blocks = new Set([...plan.lots.values()].map(lot => lot.blockId))
    expect(blocks.size).toBe(2)
    expect(BLOCK_COLS * BLOCK_ROWS).toBe(CELLS_PER_BLOCK)
  })

  it('plans a usable city from a single object', () => {
    const plan = planCity([object('object:dbo:1', 'schema:dbo', 0, 0)])
    expect(plan.lots.size).toBe(1)
    expect(plan.streets.length).toBeGreaterThan(0)
    expect(plan.bounds.width).toBeGreaterThan(0)
  })

  it('plans an empty city without throwing', () => {
    const plan = planCity([])
    expect(plan.lots.size).toBe(0)
    expect(plan.districts).toHaveLength(0)
    expect(plan.civic.districtId).toBe(CIVIC_DISTRICT_ID)
  })
})

describe('street graph', () => {
  it('connects every intersection to every other intersection', () => {
    const plan = planCity(sampleCity())
    const ids = [...plan.intersections.keys()]
    const first = ids[0]!
    for (const id of ids) {
      expect(streetPath(plan, first, id).length).toBeGreaterThan(0)
    }
  })

  it('produces a continuous path along lattice edges only', () => {
    const plan = planCity(sampleCity())
    const ids = [...plan.intersections.keys()].sort()
    const path = streetPath(plan, ids[0]!, ids[ids.length - 1]!)
    expect(path[0]).toBe(ids[0])
    expect(path[path.length - 1]).toBe(ids[ids.length - 1])
    for (let index = 1; index < path.length; index += 1) {
      const previous = plan.intersections.get(path[index - 1]!)!
      const current = plan.intersections.get(path[index]!)!
      const step = Math.abs(previous.col - current.col) + Math.abs(previous.row - current.row)
      expect(step).toBe(1)
    }
  })

  it('is deterministic and symmetric in length', () => {
    const plan = planCity(sampleCity())
    const ids = [...plan.intersections.keys()].sort()
    const forward = streetPath(plan, ids[0]!, ids[ids.length - 1]!)
    expect(streetPath(plan, ids[0]!, ids[ids.length - 1]!)).toEqual(forward)
    expect(streetPath(plan, ids[ids.length - 1]!, ids[0]!)).toHaveLength(forward.length)
  })

  it('returns an empty path for an unknown intersection', () => {
    const plan = planCity(sampleCity())
    expect(streetPath(plan, 'x0:z0', 'nowhere')).toEqual([])
  })

  it('walks streets between two buildings instead of cutting across blocks', () => {
    const plan = planCity(sampleCity())
    const lots = [...plan.lots.values()]
    const line = streetPolyline(
      plan,
      { x: lots[0]!.accessX, z: lots[0]!.accessZ },
      { x: lots[lots.length - 1]!.accessX, z: lots[lots.length - 1]!.accessZ },
    )
    expect(line.length).toBeGreaterThan(2)
    for (let index = 1; index < line.length; index += 1) {
      const previous = line[index - 1]!
      const current = line[index]!
      const axisAligned =
        Math.abs(previous.x - current.x) < 0.001 || Math.abs(previous.z - current.z) < 0.001
      expect(axisAligned).toBe(true)
    }
  })

  it('snaps a world point to the nearest intersection', () => {
    const plan = planCity(sampleCity())
    expect(nearestIntersectionId(plan, 0, 0)).toBe('x0:z0')
    expect(plan.intersections.has(nearestIntersectionId(plan, -9999, -9999))).toBe(true)
    expect(plan.intersections.has(nearestIntersectionId(plan, 9999, 9999))).toBe(true)
  })

  it('marks district boundaries as arterials', () => {
    const plan = planCity(sampleCity())
    expect(plan.streets.some(street => street.streetClass === 'arterial')).toBe(true)
    for (const street of plan.streets) {
      expect(street.width).toBeGreaterThan(0)
    }
  })
})
