import { describe, expect, it } from 'vitest'
import { databaseHeight, databaseSide } from './atlas'
import {
  cityColumns,
  cityGeometrySignature,
  LOT_PITCH,
  MAX_COLUMNS,
  planAtlasCity,
  skylineProfile,
  STREET_RATIO,
  UNKNOWN_SIDE,
  VACANT_HEIGHT,
} from './atlasCity'
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
    for (const columns of [1, 2, 5, MAX_COLUMNS]) {
      const profile = skylineProfile(columns, index => index * 7919 + 13)
      expect(profile).toHaveLength(columns * columns)
      expect(Math.max(...profile)).toBeCloseTo(1, 12)
      expect(Math.min(...profile)).toBeGreaterThan(0)
    }
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
    expect(large.lots.length).toBe(large.columns ** 2)
  })

  it('keeps zero used bytes at zero height, exactly as the database city does', () => {
    const plan = planAtlasCity(database(oneGiB, '0'))

    expect(plan.towerHeight).toBe(0)
    expect(plan.lots.every(lot => lot.height === 0)).toBe(true)
    expect(plan.lots.every(lot => lot.kind === 'tower')).toBe(true)
  })

  it('keeps every lot and its street inside the plot the allocated size paid for', () => {
    const plan = planAtlasCity(database(sixtyFourGiB, oneGiB))
    const half = plan.side / 2
    const cell = plan.side / plan.columns

    for (const lot of plan.lots) {
      expect(Math.abs(lot.x) + lot.footprint / 2).toBeLessThanOrEqual(half + 1e-9)
      expect(Math.abs(lot.z) + lot.footprint / 2).toBeLessThanOrEqual(half + 1e-9)
      expect(lot.footprint).toBeCloseTo(cell * (1 - STREET_RATIO), 10)
    }
    for (const street of plan.streets) {
      expect(Math.abs(street.x1)).toBeLessThanOrEqual(half + 1e-9)
      expect(Math.abs(street.z2)).toBeLessThanOrEqual(half + 1e-9)
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
