import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { planAtlasCity, UNKNOWN_SIDE, VACANT_HEIGHT } from './atlasCity'
import { buildAtlasCityGeometry, PAD_HEIGHT } from './atlasCityBuildings'
import type { ByteMeasurement, DatabaseAtlasItem, Evidence } from './contracts'

const evidence: Evidence = {
  source: 'Fixture',
  status: 'Available',
  observedAt: '2026-08-17T16:59:52Z',
  freshUntil: '2026-08-17T18:00:00Z',
  reason: 'Fixture bytes.',
}

function bytes(value: string | null): ByteMeasurement {
  return value === null
    ? { bytes: null, status: 'Unknown', reason: 'Metadata not visible.', evidence: { ...evidence, status: 'Unknown' } }
    : { bytes: value, status: 'Known', reason: null, evidence }
}

function database(allocated: string | null, used: string | null): DatabaseAtlasItem {
  return {
    databaseId: 'target/database/sales',
    name: 'sales',
    allocated: bytes(allocated),
    used: bytes(used),
    liveActivity: {
      activeSessions: null,
      runningRequests: null,
      blockedSessions: null,
      batchRequestsPerSecond: null,
      evidence: { ...evidence, source: 'LiveDmvSample' },
    },
    queryStore: {
      executionCount: null,
      logicalReads8KiBPages: null,
      averageDurationMicroseconds: null,
      windowStart: null,
      windowEnd: null,
      capability: 'Unknown',
      health: 'Unknown',
      reason: 'Not probed.',
      evidence: { ...evidence, source: 'NotProbed', status: 'Unknown' },
    },
  }
}

const sixtyFourGiB = String(64 * 1024 ** 3)
const oneGiB = String(1024 ** 3)

function boundingBox(geometry: THREE.BufferGeometry): THREE.Box3 {
  geometry.computeBoundingBox()
  return geometry.boundingBox!
}

describe('buildAtlasCityGeometry', () => {
  it('draws only the nonquantitative pad when allocated size is unknown', () => {
    const geometry = buildAtlasCityGeometry(planAtlasCity(database(null, null)))
    const box = boundingBox(geometry.pad)

    expect(geometry.massing).toBeNull()
    expect(geometry.trim).toBeNull()
    expect(geometry.streets).toBeNull()
    expect(box.max.x - box.min.x).toBeCloseTo(UNKNOWN_SIDE)
    expect(box.max.y).toBeCloseTo(PAD_HEIGHT)
  })

  it('tops the massing out at exactly the encoded tallest tower, above the pad it stands on', () => {
    const plan = planAtlasCity(database(sixtyFourGiB, oneGiB))
    const geometry = buildAtlasCityGeometry(plan)

    expect(geometry.massing).not.toBeNull()
    expect(boundingBox(geometry.massing!).max.y).toBeCloseTo(PAD_HEIGHT + plan.towerHeight!, 4)
  })

  it('never lets a building cross the plot the allocated size paid for', () => {
    const plan = planAtlasCity(database(sixtyFourGiB, oneGiB))
    const box = boundingBox(buildAtlasCityGeometry(plan).massing!)

    expect(box.max.x).toBeLessThanOrEqual(plan.side / 2)
    expect(box.min.z).toBeGreaterThanOrEqual(-plan.side / 2)
  })

  it('fences every lot with no massing above it when used size is unknown', () => {
    const plan = planAtlasCity(database(sixtyFourGiB, null))
    const box = boundingBox(buildAtlasCityGeometry(plan).massing!)

    expect(box.max.y).toBeCloseTo(PAD_HEIGHT + VACANT_HEIGHT + 0.12, 4)
  })

  it('paves a measured zero rather than raising anything on it', () => {
    const geometry = buildAtlasCityGeometry(planAtlasCity(database(oneGiB, '0')))

    expect(geometry.massing).toBeNull()
    expect(boundingBox(geometry.trim!).max.y).toBeCloseTo(PAD_HEIGHT + 0.245, 4)
  })

  it('emits one street segment pair per planned centreline', () => {
    const plan = planAtlasCity(database(sixtyFourGiB, oneGiB))
    const streets = buildAtlasCityGeometry(plan).streets!

    expect(streets.getAttribute('position').count).toBe(plan.streets.length * 2)
  })

  it('builds the same city twice, so a refresh cannot reshape a database that did not change', () => {
    const plan = planAtlasCity(database(sixtyFourGiB, oneGiB))
    const first = buildAtlasCityGeometry(plan).massing!.getAttribute('position').array
    const second = buildAtlasCityGeometry(plan).massing!.getAttribute('position').array

    expect(Array.from(second)).toEqual(Array.from(first))
  })
})
