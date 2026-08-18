import { describe, expect, it } from 'vitest'
import type { Evidence } from './contracts'
import type { DatabaseCityQueryFamily } from './databaseCityContracts'
import {
  LANE_COLORS,
  LANE_WIDTH_PER_DOUBLING,
  LANE_WIDTH_SATURATION_MILLISECONDS,
  MAX_LANE_WIDTH,
  MIN_LANE_WIDTH,
  WAIT_CATEGORY_ROUTING,
  laneWidth,
  projectFacilityTraffic,
  routeWaitCategory,
} from './cityFacilityTraffic'

const evidence: Evidence = {
  source: 'QueryStoreAggregate',
  status: 'Available',
  observedAt: '2024-05-01T00:00:00Z',
  freshUntil: null,
  reason: 'test',
}

function family(
  overrides: Partial<DatabaseCityQueryFamily> & { familyId: string },
): DatabaseCityQueryFamily {
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

const objects = [{ objectId: 'a' }, { objectId: 'b' }]

describe('routeWaitCategory', () => {
  it('routes resource waits to the facility that owns the resource', () => {
    expect(routeWaitCategory('CPU').facility).toBe('cpu')
    expect(routeWaitCategory('Worker Thread').facility).toBe('cpu')
    expect(routeWaitCategory('Memory').facility).toBe('memory')
    expect(routeWaitCategory('Buffer IO').facility).toBe('storage')
    expect(routeWaitCategory('Other Disk IO').facility).toBe('storage')
    expect(routeWaitCategory('Tran Log IO').facility).toBe('log')
    expect(routeWaitCategory('Log Rate Governor').facility).toBe('log')
    expect(routeWaitCategory('Lock').facility).toBe('lock')
  })

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(routeWaitCategory('  buffer io ').facility).toBe('storage')
    expect(routeWaitCategory('TRAN LOG IO').facility).toBe('log')
  })

  it('refuses to guess tempdb from Buffer Latch, so no category reaches tempdb', () => {
    expect(routeWaitCategory('Buffer Latch').facility).toBeNull()
    expect(routeWaitCategory('Buffer Latch').reason).toMatch(/does not name a database/)
    const facilities = Object.values(WAIT_CATEGORY_ROUTING).map(routing => routing.facility)
    expect(facilities).not.toContain('tempdb')
  })

  it('reports coordination and off-map waits rather than routing them anywhere', () => {
    for (const category of ['Parallelism', 'Network IO', 'Compilation', 'Idle', 'Unknown']) {
      expect(routeWaitCategory(category).facility).toBeNull()
      expect(routeWaitCategory(category).reason.length).toBeGreaterThan(0)
    }
  })

  it('passes an unrecognised category through instead of dropping or guessing it', () => {
    const routing = routeWaitCategory('Some Future Category')
    expect(routing.facility).toBeNull()
    expect(routing.reason).toMatch(/does not recognise/)
  })
})

describe('laneWidth', () => {
  it('grows by a fixed amount per doubling', () => {
    expect(laneWidth(0n)).toBe(MIN_LANE_WIDTH)
    expect(laneWidth(1000n)).toBeGreaterThan(laneWidth(500n))
    const step = laneWidth(1_048_576n) - laneWidth(524_288n)
    expect(step).toBeCloseTo(LANE_WIDTH_PER_DOUBLING, 4)
  })

  it('stays readable across the magnitudes accumulated wait actually spans', () => {
    // One hour of accumulated wait must still be distinguishable from ten minutes.
    expect(laneWidth(3_600_000n)).toBeGreaterThan(laneWidth(600_000n))
    expect(laneWidth(3_600_000n)).toBeLessThan(MAX_LANE_WIDTH)
    expect(LANE_WIDTH_SATURATION_MILLISECONDS).toBeGreaterThan(3_600_000)
  })

  it('clamps rather than growing without bound, and flags the clamp as a floor', () => {
    expect(laneWidth(10n ** 12n)).toBe(MAX_LANE_WIDTH)

    const traffic = projectFacilityTraffic(
      [
        family({ familyId: 'big', objectIds: ['a'], waitMillisecondsByCategory: { 'Lock': '999999999999' } }),
        family({ familyId: 'small', objectIds: ['b'], waitMillisecondsByCategory: { 'Lock': '5000' } }),
      ],
      objects,
    )

    expect(traffic.lanes[0].saturated).toBe(true)
    expect(traffic.lanes[0].rationale).toMatch(/width is a floor/)
    expect(traffic.lanes[1].saturated).toBe(false)
    expect(traffic.lanes[1].rationale).not.toMatch(/width is a floor/)
  })
})

describe('projectFacilityTraffic', () => {
  it('draws one lane per building and destination facility', () => {
    const traffic = projectFacilityTraffic(
      [family({ familyId: 'f1', objectIds: ['a'], waitMillisecondsByCategory: { 'Buffer IO': '400', 'Lock': '100' } })],
      objects,
    )

    expect(traffic.lanes).toHaveLength(2)
    const storage = traffic.lanes.find(lane => lane.facility === 'storage')
    expect(storage?.waitMilliseconds).toBe('400')
    expect(storage?.color).toBe(LANE_COLORS.storage)
    expect(storage?.familyIds).toEqual(['f1'])
    expect(traffic.lanes.find(lane => lane.facility === 'lock')?.waitMilliseconds).toBe('100')
  })

  it('merges categories that share a destination and keeps them listed verbatim', () => {
    const traffic = projectFacilityTraffic(
      [family({
        familyId: 'f1',
        objectIds: ['a'],
        waitMillisecondsByCategory: { 'Buffer IO': '400', 'Other Disk IO': '600' },
      })],
      objects,
    )

    expect(traffic.lanes).toHaveLength(1)
    expect(traffic.lanes[0].waitMilliseconds).toBe('1000')
    expect(traffic.lanes[0].categories).toEqual([
      { category: 'Other Disk IO', waitMilliseconds: '600' },
      { category: 'Buffer IO', waitMilliseconds: '400' },
    ])
  })

  it('never folds a category with no facility into the CPU yard', () => {
    const traffic = projectFacilityTraffic(
      [family({
        familyId: 'f1',
        objectIds: ['a'],
        waitMillisecondsByCategory: { 'Parallelism': '900', 'Network IO': '50' },
      })],
      objects,
    )

    expect(traffic.lanes).toHaveLength(0)
    expect(traffic.unmapped).toEqual([
      { category: 'Parallelism', waitMilliseconds: '900', reason: expect.stringContaining('coordination') },
      { category: 'Network IO', waitMilliseconds: '50', reason: expect.stringContaining('client') },
    ])
  })

  it('draws a multi-object family as one shared lane instead of dividing it between its buildings', () => {
    const traffic = projectFacilityTraffic(
      [family({ familyId: 'f1', objectIds: ['a', 'b'], waitMillisecondsByCategory: { 'Lock': '1000' } })],
      objects,
    )

    // Never a per-object lane: no building may claim time the family measured across several.
    expect(traffic.lanes).toHaveLength(0)
    expect(traffic.shared).toEqual([])
    expect(traffic.sharedLanes).toHaveLength(1)
    const [lane] = traffic.sharedLanes
    // Whole, undivided, and drawn exactly once through both buildings it names.
    expect(lane.waitMilliseconds).toBe('1000')
    expect(lane.objectIds).toEqual(['a', 'b'])
    expect(lane.namedObjectCount).toBe(2)
    expect(lane.offPageObjectCount).toBe(0)
    expect(lane.facility).toBe('lock')
    expect(lane.rationale).toMatch(/not divided/)
    expect(traffic.measuredFamilyCount).toBe(1)
  })

  it('threads a shared lane through only the named objects on this page, and says so', () => {
    // Giving 'a' all 1000 ms because the cross-database object is off this page would be a worse
    // fabrication than splitting it: the family never attributed that time to 'a' alone. The lane
    // still carries the whole figure, but discloses that its drawn path is short of the relationship.
    const traffic = projectFacilityTraffic(
      [family({
        familyId: 'f1',
        objectIds: ['a', 'other-database/table'],
        waitMillisecondsByCategory: { 'Lock': '1000' },
      })],
      objects,
    )

    expect(traffic.lanes).toHaveLength(0)
    expect(traffic.sharedLanes).toHaveLength(1)
    const [lane] = traffic.sharedLanes
    expect(lane.objectIds).toEqual(['a'])
    expect(lane.namedObjectCount).toBe(2)
    expect(lane.offPageObjectCount).toBe(1)
    expect(lane.waitMilliseconds).toBe('1000')
    expect(lane.rationale).toMatch(/not on this page/)
  })

  it('reports a multi-object family whole in text when none of its objects are on this page', () => {
    const traffic = projectFacilityTraffic(
      [family({
        familyId: 'f1',
        objectIds: ['off-page', 'other-database/table'],
        waitMillisecondsByCategory: { 'Lock': '1000' },
      })],
      objects,
    )

    // Nothing to thread a path through, so it stays text rather than being drawn from a building
    // the family never named.
    expect(traffic.lanes).toHaveLength(0)
    expect(traffic.sharedLanes).toHaveLength(0)
    expect(traffic.shared).toEqual([{ category: 'Lock', waitMilliseconds: '1000' }])
  })

  it('keeps a shared lane out of every per-object total', () => {
    const traffic = projectFacilityTraffic(
      [
        family({ familyId: 'solo', objectIds: ['a'], waitMillisecondsByCategory: { 'Lock': '10' } }),
        family({ familyId: 'pair', objectIds: ['a', 'b'], waitMillisecondsByCategory: { 'Lock': '900' } }),
      ],
      objects,
    )

    // 'a' owns only the 10 ms measured against it alone; the 900 ms stays on the shared lane.
    expect(traffic.lanes).toHaveLength(1)
    expect(traffic.lanes[0].objectId).toBe('a')
    expect(traffic.lanes[0].waitMilliseconds).toBe('10')
    expect(traffic.sharedLanes).toHaveLength(1)
    expect(traffic.sharedLanes[0].waitMilliseconds).toBe('900')
  })

  it('keeps wait time from a family whose single named object is off this page', () => {
    const traffic = projectFacilityTraffic(
      [family({ familyId: 'f1', objectIds: ['off-page'], waitMillisecondsByCategory: { 'Memory': '75' } })],
      objects,
    )

    expect(traffic.lanes).toHaveLength(0)
    expect(traffic.unattributed).toEqual([{ category: 'Memory', waitMilliseconds: '75' }])
  })

  it('draws no lane when no category evidence was captured and says why', () => {
    const traffic = projectFacilityTraffic([family({ familyId: 'f1', objectIds: ['a'] })], objects)

    expect(traffic.lanes).toHaveLength(0)
    expect(traffic.measuredFamilyCount).toBe(0)
    expect(traffic.note).toMatch(/2017/)
    expect(traffic.note).toMatch(/not evidence that nothing waited/)
  })

  it('claims nothing at all when no family was returned', () => {
    const traffic = projectFacilityTraffic([], objects)

    expect(traffic.lanes).toHaveLength(0)
    expect(traffic.familyCount).toBe(0)
    expect(traffic.note).toMatch(/no wait lane is drawn and none is claimed/)
  })

  it('carries the weakest contributing attribution into the lane pattern', () => {
    const traffic = projectFacilityTraffic(
      [
        family({ familyId: 'f1', objectIds: ['a'], waitMillisecondsByCategory: { 'Lock': '10' } }),
        family({
          familyId: 'f2',
          objectIds: ['a'],
          confidence: 'Probable',
          waitMillisecondsByCategory: { 'Lock': '90' },
        }),
      ],
      objects,
    )

    expect(traffic.lanes).toHaveLength(1)
    expect(traffic.lanes[0].confidence).toBe('Probable')
    expect(traffic.lanes[0].pattern).toBe('dashed')
    expect(traffic.lanes[0].waitMilliseconds).toBe('100')
    expect(traffic.lanes[0].familyIds).toEqual(['f1', 'f2'])
  })

  it('orders lanes by captured milliseconds so the ordering is stable and readable', () => {
    const traffic = projectFacilityTraffic(
      [
        family({ familyId: 'f1', objectIds: ['a'], waitMillisecondsByCategory: { 'Lock': '10' } }),
        family({ familyId: 'f2', objectIds: ['b'], waitMillisecondsByCategory: { 'Memory': '500' } }),
      ],
      objects,
    )

    expect(traffic.lanes.map(lane => lane.laneId)).toEqual(['b->memory', 'a->lock'])
  })

  it('ignores unusable counters rather than coercing them to zero milliseconds', () => {
    const traffic = projectFacilityTraffic(
      [family({
        familyId: 'f1',
        objectIds: ['a'],
        waitMillisecondsByCategory: { 'Lock': 'n/a', 'Memory': '0', 'Buffer IO': '-5', 'CPU': '42' },
      })],
      objects,
    )

    expect(traffic.lanes.map(lane => lane.facility)).toEqual(['cpu'])
    expect(traffic.lanes[0].waitMilliseconds).toBe('42')
  })

  it('preserves exact counters far beyond IEEE-754 integer precision', () => {
    // 9007199254740995 is odd and above 2^53, so a double cannot hold it: Number() rounds it away.
    const traffic = projectFacilityTraffic(
      [
        family({ familyId: 'f1', objectIds: ['a'], waitMillisecondsByCategory: { 'Lock': '9007199254740993' } }),
        family({ familyId: 'f2', objectIds: ['a'], waitMillisecondsByCategory: { 'Lock': '2' } }),
      ],
      objects,
    )

    expect(traffic.lanes[0].waitMilliseconds).toBe('9007199254740995')
    // The rationale is user-facing text, so it must not round the counter it quotes either.
    expect(traffic.lanes[0].rationale).toContain(BigInt('9007199254740995').toLocaleString())
    expect(traffic.lanes[0].rationale).not.toContain(Number('9007199254740995').toLocaleString())
  })
})
