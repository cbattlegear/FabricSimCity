import { describe, expect, it } from 'vitest'
import type { Evidence } from './contracts'
import type { DatabaseCityQueryFamily, DatabaseCityRoute } from './databaseCityContracts'
import {
  CONGESTION_COLORS,
  HIGH_WAIT_SHARE,
  MAX_ROAD_WIDTH,
  MEDIUM_WAIT_SHARE,
  MIN_ROAD_WIDTH,
  confidencePattern,
  congestionGrade,
  gradeRoads,
  roadVolume,
  roadWidth,
  waitShare,
} from './cityTraffic'

const evidence: Evidence = {
  source: 'QueryStoreAggregate',
  status: 'Available',
  observedAt: '2024-05-01T00:00:00Z',
  freshUntil: null,
  reason: 'test',
}

function family(overrides: Partial<DatabaseCityQueryFamily> & { familyId: string }): DatabaseCityQueryFamily {
  return {
    queryHash: '0x00',
    executionCount: '0',
    totalCpuMicroseconds: '0',
    totalDurationMicroseconds: '0',
    totalLogicalReads8KiBPages: '0',
    totalWaitMilliseconds: '0',
    waitMillisecondsByCategory: {},
    objectIds: [],
    confidence: 'Confirmed',
    rationale: 'test',
    evidence,
    ...overrides,
  }
}

function route(overrides: Partial<DatabaseCityRoute> & { routeId: string }): DatabaseCityRoute {
  return {
    fromObjectId: 'a',
    toId: 'b',
    kind: 'ObjectReference',
    confidence: 'Confirmed',
    rationale: 'test',
    evidence,
    ...overrides,
  }
}

describe('roadVolume', () => {
  it('sums executions only from families naming both endpoints', () => {
    const families = [
      family({ familyId: 'qf:1', objectIds: ['a', 'b'], executionCount: '100' }),
      family({ familyId: 'qf:2', objectIds: ['a', 'b', 'c'], executionCount: '50' }),
      family({ familyId: 'qf:3', objectIds: ['a', 'c'], executionCount: '9999' }),
    ]
    const result = roadVolume({ fromObjectId: 'a', toId: 'b' }, families)
    expect(result.executions).toBe(150)
    expect(result.familyIds).toEqual(['qf:1', 'qf:2'])
  })

  it('reports null rather than zero when nothing names the pair', () => {
    const result = roadVolume({ fromObjectId: 'a', toId: 'b' }, [
      family({ familyId: 'qf:1', objectIds: ['c', 'd'], executionCount: '10' }),
    ])
    expect(result.executions).toBeNull()
    expect(result.familyIds).toEqual([])
  })
})

describe('roadWidth', () => {
  it('is monotonic in executions', () => {
    const widths = [1, 10, 100, 1_000, 10_000].map(roadWidth)
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]).toBeGreaterThan(widths[i - 1])
    }
  })

  it('falls back to the minimum width for unmeasured and zero traffic', () => {
    expect(roadWidth(null)).toBe(MIN_ROAD_WIDTH)
    expect(roadWidth(0)).toBe(MIN_ROAD_WIDTH)
  })

  it('never exceeds the documented maximum', () => {
    expect(roadWidth(Number.MAX_SAFE_INTEGER)).toBeLessThanOrEqual(MAX_ROAD_WIDTH)
  })
})

describe('waitShare', () => {
  it('converts microsecond duration to milliseconds before dividing', () => {
    // 250 ms waiting out of 1,000,000 microseconds (= 1000 ms) of duration.
    const share = waitShare([
      family({ familyId: 'qf:1', totalWaitMilliseconds: '250', totalDurationMicroseconds: '1000000' }),
    ])
    expect(share).toBeCloseTo(0.25, 10)
  })

  it('returns null when duration is unmeasured', () => {
    expect(waitShare([])).toBeNull()
    expect(
      waitShare([family({ familyId: 'qf:1', totalWaitMilliseconds: '5', totalDurationMicroseconds: '0' })]),
    ).toBeNull()
  })

  it('treats a zero wait total as a real measurement of zero', () => {
    const share = waitShare([
      family({ familyId: 'qf:1', totalWaitMilliseconds: '0', totalDurationMicroseconds: '5000' }),
    ])
    expect(share).toBe(0)
  })
})

describe('congestionGrade', () => {
  it('grades on the documented thresholds, inclusive at the boundary', () => {
    expect(congestionGrade(0)).toBe('low')
    expect(congestionGrade(MEDIUM_WAIT_SHARE - 0.0001)).toBe('low')
    expect(congestionGrade(MEDIUM_WAIT_SHARE)).toBe('medium')
    expect(congestionGrade(HIGH_WAIT_SHARE - 0.0001)).toBe('medium')
    expect(congestionGrade(HIGH_WAIT_SHARE)).toBe('high')
    expect(congestionGrade(1)).toBe('high')
  })

  it('never claims "low" for missing or non-finite evidence', () => {
    expect(congestionGrade(null)).toBe('unknown')
    expect(congestionGrade(Number.NaN)).toBe('unknown')
    expect(congestionGrade(Number.POSITIVE_INFINITY)).toBe('unknown')
  })
})

describe('confidencePattern', () => {
  it('maps each confidence to a distinct pattern so colour stays free for congestion', () => {
    const patterns = new Set([
      confidencePattern('Confirmed'),
      confidencePattern('Probable'),
      confidencePattern('Unknown'),
    ])
    expect(patterns.size).toBe(3)
    expect(confidencePattern('Confirmed')).toBe('solid')
  })
})

describe('gradeRoads', () => {
  const families = [
    family({
      familyId: 'qf:hot',
      objectIds: ['a', 'b'],
      executionCount: '1000',
      totalWaitMilliseconds: '900',
      totalDurationMicroseconds: '1000000',
    }),
    family({
      familyId: 'qf:cool',
      objectIds: ['c', 'd'],
      executionCount: '10',
      totalWaitMilliseconds: '1',
      totalDurationMicroseconds: '1000000',
    }),
  ]

  it('grades a heavily-waiting road red and a light one green', () => {
    const graded = gradeRoads(
      [route({ routeId: 'r:hot' }), route({ routeId: 'r:cool', fromObjectId: 'c', toId: 'd' })],
      families,
    )
    expect(graded[0].grade).toBe('high')
    expect(graded[0].color).toBe(CONGESTION_COLORS.high)
    expect(graded[1].grade).toBe('low')
    expect(graded[1].color).toBe(CONGESTION_COLORS.low)
    expect(graded[0].width).toBeGreaterThan(graded[1].width)
  })

  it('leaves roads with no captured family unknown and grey', () => {
    const [graded] = gradeRoads([route({ routeId: 'r:x', fromObjectId: 'x', toId: 'y' })], families)
    expect(graded.grade).toBe('unknown')
    expect(graded.color).toBe(CONGESTION_COLORS.unknown)
    expect(graded.executions).toBeNull()
    expect(graded.waitShare).toBeNull()
    expect(graded.rationale).toContain('no traffic volume is claimed')
  })

  it('upgrades to high when a live lock wait resolves to an endpoint', () => {
    const [graded] = gradeRoads(
      [route({ routeId: 'r:cool', fromObjectId: 'c', toId: 'd' })],
      families,
      [{ objectKey: 'd', blockedSessionCount: 3 }],
    )
    expect(graded.grade).toBe('high')
    expect(graded.rationale).toContain('live lock wait')
  })

  it('ignores live entries that report no blocked sessions', () => {
    const [graded] = gradeRoads(
      [route({ routeId: 'r:cool', fromObjectId: 'c', toId: 'd' })],
      families,
      [{ objectKey: 'd', blockedSessionCount: 0 }],
    )
    expect(graded.grade).toBe('low')
  })

  it('preserves route identity and carries the driving family ids for drill-down', () => {
    const [graded] = gradeRoads([route({ routeId: 'r:hot' })], families)
    expect(graded.routeId).toBe('r:hot')
    expect(graded.fromObjectId).toBe('a')
    expect(graded.toId).toBe('b')
    expect(graded.familyIds).toEqual(['qf:hot'])
  })

  it('always explains itself', () => {
    const graded = gradeRoads(
      [route({ routeId: 'r:hot' }), route({ routeId: 'r:x', fromObjectId: 'x', toId: 'y' })],
      families,
    )
    for (const road of graded) {
      expect(road.rationale.length).toBeGreaterThan(0)
    }
  })
})
