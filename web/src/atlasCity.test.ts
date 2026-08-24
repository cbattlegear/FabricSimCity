import { describe, expect, it } from 'vitest'
import { databaseHeight, databaseSide } from './atlas'
import {
  cityColumns,
  cityGeometrySignature,
  gatewayToward,
  LOT_PITCH,
  MAX_COLUMNS,
  outlineRadiusAt,
  planAtlasCity,
  regionalRoadPath,
  skylineProfile,
  townOutline,
  UNKNOWN_SIDE,
  VACANT_HEIGHT,
} from './atlasCity'
import { pointInPolygon, polygonArea } from './mapRibbon'
import type { ByteMeasurement, DatabaseAtlasItem, Evidence } from './contracts'

const observed = '2026-08-17T16:59:52Z'

const evidence: Evidence = {
  source: 'Fixture',
  status: 'Available',
  observedAt: observed,
  freshUntil: '2026-08-17T18:00:00Z',
  reason: 'Fixture bytes.',
}

function bytes(value: string | null): ByteMeasurement {
  return value === null
    ? { bytes: null, status: 'Unknown', reason: 'Metadata not visible.', evidence: { ...evidence, status: 'Unknown' } }
    : { bytes: value, status: 'Known', reason: null, evidence }
}

function database(allocated: string | null, used: string | null, id = 'target/database/sales'): DatabaseAtlasItem {
  return {
    databaseId: id,
    name: 'sales',
    allocated: bytes(allocated),
    used: bytes(used),
    liveActivity: {
      activeSessions: 0,
      runningRequests: 0,
      blockedSessions: 0,
      batchRequestsPerSecond: 0,
      evidence: { ...evidence, source: 'LiveDmvSample' },
    },
    queryStore: {
      executionCount: '0',
      logicalReads8KiBPages: '0',
      averageDurationMicroseconds: 0,
      windowStart: observed,
      windowEnd: observed,
      capability: 'Available',
      health: 'Healthy',
      reason: 'Collecting.',
      evidence: { ...evidence, source: 'QueryStoreAggregate' },
    },
  }
}

/** 1 GiB and 64 GiB, as exact byte strings, so the two cities differ by a wide margin. */
const oneGiB = String(1024 ** 3)
const sixtyFourGiB = String(64 * 1024 ** 3)

describe('cityColumns', () => {
  it('gives a measured database at least one block, because bare ground already means unknown', () => {
    expect(cityColumns(1)).toBe(1)
    expect(cityColumns(12)).toBe(1)
  })

  it('grows the block grid with the plot, at one constant block size for every city', () => {
    expect(cityColumns(LOT_PITCH * 3)).toBe(3)
    expect(cityColumns(LOT_PITCH * 5)).toBe(5)
    expect(cityColumns(LOT_PITCH * 2)).toBeLessThan(cityColumns(LOT_PITCH * 4))
  })

  it('never degenerates into unreadable specks or into nothing', () => {
    expect(cityColumns(100_000)).toBe(MAX_COLUMNS)
    expect(cityColumns(0)).toBe(1)
    expect(cityColumns(Number.NaN)).toBe(1)
  })
})

describe('skylineProfile', () => {
  it('normalizes so exactly one tower reaches the full encoded height', () => {
    for (const count of [1, 4, 25, MAX_COLUMNS ** 2]) {
      const rings = Array.from({ length: count }, (_, index) => index / Math.max(count - 1, 1))
      const profile = skylineProfile(rings, index => index * 7919 + 13)
      expect(profile).toHaveLength(count)
      expect(Math.max(...profile)).toBeCloseTo(1, 12)
      expect(Math.min(...profile)).toBeGreaterThan(0)
    }
  })

  it('falls away from downtown toward the edge, whatever shape the edge is', () => {
    const flat = skylineProfile([0, 0.5, 1], () => 500)
    expect(flat[0]).toBeGreaterThan(flat[1])
    expect(flat[1]).toBeGreaterThan(flat[2])
  })
})

describe('townOutline', () => {
  it('encloses exactly the area the allocated size paid for, however irregular it is', () => {
    for (const side of [12, 26, 47.5, 96]) {
      const outline = townOutline(side, 'target/database/area')
      expect(polygonArea(outline)).toBeCloseTo(side * side, 6)
    }
  })

  it('is not a circle, so two towns are told apart by their shape', () => {
    const outline = townOutline(60, 'target/database/shape')
    const radii = outline.map(point => Math.hypot(point.x, point.z))
    expect(Math.max(...radii) / Math.min(...radii)).toBeGreaterThan(1.15)
    expect(Math.min(...radii)).toBeGreaterThan(0)
  })

  it('draws a different town for a different database and the same one for the same', () => {
    expect(townOutline(60, 'target/database/left')).not.toEqual(
      townOutline(60, 'target/database/right'),
    )
    expect(townOutline(60, 'target/database/left')).toEqual(townOutline(60, 'target/database/left'))
  })
})

describe('planAtlasCity', () => {
  it('claims no city at all when allocated size is unknown', () => {
    const plan = planAtlasCity(database(null, null))

    expect(plan.sizeKnown).toBe(false)
    expect(plan.side).toBe(UNKNOWN_SIDE)
    expect(plan.towerHeight).toBeNull()
    expect(plan.lots).toHaveLength(0)
    expect(plan.streets).toHaveLength(0)
  })

  it('draws the measured ground but no skyline when only used size is unknown', () => {
    const plan = planAtlasCity(database(sixtyFourGiB, null))

    expect(plan.sizeKnown).toBe(true)
    expect(plan.side).toBe(databaseSide(database(sixtyFourGiB, null)))
    expect(plan.towerHeight).toBeNull()
    expect(plan.lots.length).toBeGreaterThan(0)
    expect(plan.lots.every(lot => lot.kind === 'vacant')).toBe(true)
    expect(plan.lots.every(lot => lot.height === VACANT_HEIGHT)).toBe(true)
  })

  it('makes the tallest tower exactly the encoded used size, so two skylines can be compared', () => {
    const item = database(sixtyFourGiB, oneGiB)
    const plan = planAtlasCity(item)
    const tallest = Math.max(...plan.lots.map(lot => lot.height))

    expect(plan.towerHeight).toBe(databaseHeight(item))
    expect(tallest).toBeCloseTo(plan.towerHeight!, 10)
  })

  it('gives equal used bytes equal skylines even when the two cities are different sizes', () => {
    const small = planAtlasCity(database(oneGiB, oneGiB, 'target/database/small'))
    const large = planAtlasCity(database(sixtyFourGiB, oneGiB, 'target/database/large'))

    expect(large.side).toBeGreaterThan(small.side)
    expect(large.lots.length).toBeGreaterThan(small.lots.length)
    expect(large.towerHeight).toBe(small.towerHeight)
  })

  it('grows into a larger city rather than a taller one when only allocated size grows', () => {
    const small = planAtlasCity(database(oneGiB, oneGiB, 'target/database/small'))
    const large = planAtlasCity(database(sixtyFourGiB, oneGiB, 'target/database/large'))

    expect(large.columns).toBeGreaterThan(small.columns)
    // Block pitch is a single constant, so lot count tracks ground area rather than being a second
    // encoding of its own. The outline is irregular, so this is a proportion rather than a square.
    const areaRatio = (large.side * large.side) / (small.side * small.side)
    expect(large.lots.length / small.lots.length).toBeGreaterThan(areaRatio * 0.6)
  })

  it('keeps zero used bytes at zero height, exactly as the database city does', () => {
    const plan = planAtlasCity(database(oneGiB, '0'))

    expect(plan.towerHeight).toBe(0)
    expect(plan.lots.every(lot => lot.height === 0)).toBe(true)
    expect(plan.lots.every(lot => lot.kind === 'tower')).toBe(true)
  })

  it('encloses exactly the ground the allocated size paid for, in an irregular outline', () => {
    const plan = planAtlasCity(database(sixtyFourGiB, oneGiB))

    expect(polygonArea(plan.outline)).toBeCloseTo(plan.side * plan.side, 6)
    expect(plan.radius.max).toBeGreaterThan(plan.radius.min)
  })

  it('keeps every building and every street inside the town it belongs to', () => {
    for (const item of [
      database(oneGiB, oneGiB, 'target/database/tiny'),
      database(sixtyFourGiB, oneGiB, 'target/database/mid'),
      database('34359738368', oneGiB, 'target/database/big'),
    ]) {
      const plan = planAtlasCity(item)
      expect(plan.lots.length).toBeGreaterThan(0)

      for (const lot of plan.lots) {
        const half = lot.footprint / 2
        for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
          expect(pointInPolygon(plan.outline, lot.x + dx * half, lot.z + dz * half)).toBe(true)
        }
      }
      for (const street of plan.streets) {
        for (const point of street.points) {
          expect(Math.hypot(point.x, point.z)).toBeLessThanOrEqual(plan.radius.max + 1e-9)
        }
      }
    }
  })

  it('gives every town a ring road and radials that reach its edge, so roads arrive on a street', () => {
    const plan = planAtlasCity(database(sixtyFourGiB, oneGiB))

    expect(plan.streets.filter(street => street.kind === 'ring')).toHaveLength(1)
    expect(plan.streets.filter(street => street.kind === 'radial').length).toBeGreaterThanOrEqual(3)
    expect(plan.gateways.length).toBe(plan.streets.filter(s => s.kind === 'radial').length)
    for (const gateway of plan.gateways) {
      const reach = outlineRadiusAt(plan.outline, Math.atan2(gateway.z, gateway.x))
      expect(Math.hypot(gateway.x, gateway.z)).toBeLessThanOrEqual(reach + 1e-6)
      expect(Math.hypot(gateway.x, gateway.z)).toBeGreaterThan(reach * 0.5)
    }
  })

  it('draws the same city every time, so a refresh never reshuffles a skyline', () => {
    const item = database(sixtyFourGiB, oneGiB)
    expect(planAtlasCity(item)).toEqual(planAtlasCity({ ...item }))
  })

  it('gives two databases different skylines from their ids alone, not from their measurements', () => {
    const left = planAtlasCity(database(sixtyFourGiB, oneGiB, 'target/database/left'))
    const right = planAtlasCity(database(sixtyFourGiB, oneGiB, 'target/database/right'))

    expect(right.side).toBe(left.side)
    expect(right.towerHeight).toBe(left.towerHeight)
    expect(right.lots.map(lot => lot.height)).not.toEqual(left.lots.map(lot => lot.height))
  })
})

describe('cityGeometrySignature', () => {
  it('changes when a measurement that reshapes the city changes', () => {
    const before = cityGeometrySignature(planAtlasCity(database(oneGiB, oneGiB)))

    expect(cityGeometrySignature(planAtlasCity(database(sixtyFourGiB, oneGiB)))).not.toBe(before)
    expect(cityGeometrySignature(planAtlasCity(database(oneGiB, sixtyFourGiB)))).not.toBe(before)
    expect(cityGeometrySignature(planAtlasCity(database(oneGiB, null)))).not.toBe(before)
  })

  it('holds steady across a refresh that moved no bytes, so geometry is not rebuilt', () => {
    const item = database(oneGiB, oneGiB)
    const refreshed: DatabaseAtlasItem = {
      ...item,
      liveActivity: { ...item.liveActivity, activeSessions: 42 },
    }

    expect(cityGeometrySignature(planAtlasCity(refreshed)))
      .toBe(cityGeometrySignature(planAtlasCity(item)))
  })
})

describe('regionalRoadPath', () => {
  const from = { x: 0, z: 0 }
  const to = { x: 300, z: 120 }
  const a = planAtlasCity(database(sixtyFourGiB, oneGiB, 'target/database/a'))
  const b = planAtlasCity(database(sixtyFourGiB, oneGiB, 'target/database/b'))

  it('leaves and arrives at town edges rather than running through their centres', () => {
    const path = regionalRoadPath(from, a, to, b, 'a->b')
    const startOffset = Math.hypot(path[0].x - from.x, path[0].z - from.z)
    const endOffset = Math.hypot(path[path.length - 1].x - to.x, path[path.length - 1].z - to.z)

    expect(startOffset).toBeGreaterThan(a.radius.min * 0.5)
    expect(endOffset).toBeGreaterThan(b.radius.min * 0.5)
  })

  it('draws the same road every time, so a refresh does not move the map', () => {
    expect(regionalRoadPath(from, a, to, b, 'a->b'))
      .toEqual(regionalRoadPath(from, a, to, b, 'a->b'))
  })

  it('bows, so a sheet of roads does not read as a wire diagram', () => {
    const path = regionalRoadPath(from, a, to, b, 'a->b')
    const start = path[0]
    const end = path[path.length - 1]
    const dx = end.x - start.x
    const dz = end.z - start.z
    const length = Math.hypot(dx, dz)
    const worst = Math.max(
      ...path.map(p => Math.abs(((p.x - start.x) * dz - (p.z - start.z) * dx) / length)),
    )

    expect(worst).toBeGreaterThan(0.5)
  })

  it('draws nothing between two towns at the same place', () => {
    expect(regionalRoadPath(from, a, from, a, 'a->a')).toEqual([])
  })
})

describe('gatewayToward', () => {
  it('picks the gateway facing the direction of travel', () => {
    const plan = planAtlasCity(database(sixtyFourGiB, oneGiB))
    const center = { x: 10, z: -4 }
    const east = gatewayToward(center, plan, { x: 500, z: -4 })
    const west = gatewayToward(center, plan, { x: -500, z: -4 })

    expect(east.x).toBeGreaterThan(center.x)
    expect(west.x).toBeLessThan(center.x)
  })

  it('keeps the centre for a town with no measured size, which has no edge to arrive at', () => {
    const plan = planAtlasCity(database(null, null))
    const center = { x: 3, z: 7 }

    expect(gatewayToward(center, plan, { x: 400, z: 7 }).x).toBeGreaterThanOrEqual(center.x)
  })
})
