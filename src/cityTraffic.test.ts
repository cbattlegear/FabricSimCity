import { describe, expect, it } from 'vitest'
import {
  CONGESTION_COLORS,
  MODERATE_DELAY_SECONDS_PER_OP,
  HEAVY_DELAY_SECONDS_PER_OP,
  SEVERE_DELAY_SECONDS_PER_OP,
  congestionFromDelay,
  confidencePattern,
  describeTrafficEvidence,
  gradeRoads,
  recentRoadDelay,
  roadDelay,
  roadVolume,
  throttleShare,
  trafficEvidenceState,
  trafficModeForClass,
} from './cityTraffic'
import { family, recent, route } from './operationTraffic.testkit'

describe('congestionFromDelay ladder', () => {
  it('grades an unmeasured delay as unknown, never free', () => {
    // The load-bearing rule: a null (unmeasured) throttling ratio is off the scale, not the bottom of
    // it. Folding it into 'free' is exactly the lie the map must never tell.
    expect(congestionFromDelay(null)).toBe('unknown')
    expect(congestionFromDelay(Number.NaN)).toBe('unknown')
  })

  it('places measured ratios on the four bands by their thresholds', () => {
    expect(congestionFromDelay(0)).toBe('free')
    expect(congestionFromDelay(MODERATE_DELAY_SECONDS_PER_OP - 0.001)).toBe('free')
    expect(congestionFromDelay(MODERATE_DELAY_SECONDS_PER_OP)).toBe('moderate')
    expect(congestionFromDelay(HEAVY_DELAY_SECONDS_PER_OP)).toBe('heavy')
    expect(congestionFromDelay(SEVERE_DELAY_SECONDS_PER_OP)).toBe('severe')
  })
})

describe('roadVolume', () => {
  it('returns null when no family names both endpoints — absence, not zero', () => {
    const r = route('item:a', 'item:b')
    const { operations, familyIds } = roadVolume(r, [family({ itemIds: ['item:a', 'item:c'] })])
    expect(operations).toBeNull()
    expect(familyIds).toEqual([])
  })

  it('sums operations across families naming both endpoints', () => {
    const r = route('item:a', 'item:b')
    const families = [
      family({ itemIds: ['item:a', 'item:b'], operationCount: '10', familyId: 'f1' }),
      family({ itemIds: ['item:a', 'item:b'], operationCount: '5', familyId: 'f2' }),
    ]
    const { operations, familyIds } = roadVolume(r, families)
    expect(operations).toBe(15)
    expect(familyIds).toEqual(['f1', 'f2'])
  })
})

describe('trafficModeForClass', () => {
  it('splits interactive to cars, background to freight, and refuses to guess unknown', () => {
    expect(trafficModeForClass('Interactive')).toBe('car')
    expect(trafficModeForClass('Background')).toBe('freight')
    expect(trafficModeForClass('Unknown')).toBe('unknown')
  })
})

describe('gradeRoads — never draws a guess', () => {
  it('grades a route with no measured throttling as unknown, not free or zero', () => {
    // A family ran here (10 operations) but the source did not measure its throttling. We do not know
    // whether it was held at a gate, so the road is grey. operations is still the measured count.
    const roads = gradeRoads(
      [route('item:a', 'item:b')],
      [family({ itemIds: ['item:a', 'item:b'], operationCount: '10', throttlingSeconds: null })],
    )
    expect(roads).toHaveLength(1)
    expect(roads[0].grade).toBe('unknown')
    expect(roads[0].color).toBe(CONGESTION_COLORS.unknown)
    expect(roads[0].delayPerOperation).toBeNull()
    expect(roads[0].throttleShare).toBeNull()
    expect(roads[0].operations).toBe(10)
  })

  it('grades a route no family names as unknown with null operations', () => {
    const roads = gradeRoads([route('item:a', 'item:b')], [family({ itemIds: ['item:x'] })])
    expect(roads[0].grade).toBe('unknown')
    expect(roads[0].operations).toBeNull()
    expect(roads[0].carOperations).toBeNull()
    expect(roads[0].freightOperations).toBeNull()
  })

  it('grades a measured road with zero throttling as free — measured quiet, not grey', () => {
    const roads = gradeRoads(
      [route('item:a', 'item:b')],
      [family({ itemIds: ['item:a', 'item:b'], operationCount: '10', throttlingSeconds: 0 })],
    )
    expect(roads[0].grade).toBe('free')
    expect(roads[0].delayPerOperation).toBe(0)
  })

  it('grades by throttling seconds per operation', () => {
    // 60 s of throttling over 10 operations = 6 s/op → heavy (>= 5, < 20).
    const roads = gradeRoads(
      [route('item:a', 'item:b')],
      [family({ itemIds: ['item:a', 'item:b'], operationCount: '10', throttlingSeconds: 60 })],
    )
    expect(roads[0].grade).toBe('heavy')
    expect(roads[0].delayPerOperation).toBeCloseTo(6)
  })

  it('splits interactive and background operations into cars and freight', () => {
    const roads = gradeRoads(
      [route('item:a', 'item:b')],
      [
        family({ itemIds: ['item:a', 'item:b'], familyId: 'car', operationClass: 'Interactive', operationCount: '10' }),
        family({ itemIds: ['item:a', 'item:b'], familyId: 'freight', operationClass: 'Background', operationCount: '4' }),
      ],
    )
    expect(roads[0].operations).toBe(14)
    expect(roads[0].carOperations).toBe(10)
    expect(roads[0].freightOperations).toBe(4)
  })

  it('upgrades a road touching a live rejection to severe', () => {
    const roads = gradeRoads(
      [route('item:a', 'item:b')],
      [family({ itemIds: ['item:a', 'item:b'], operationCount: '10', throttlingSeconds: 0 })],
      [{ objectKey: 'item:b', blockedSessionCount: 3 }],
    )
    expect(roads[0].grade).toBe('severe')
  })
})

describe('recent traffic window', () => {
  it('greys a road whose window was published but covered nothing', () => {
    const matched = [family({ itemIds: ['item:a', 'item:b'], recentActivity: recent({ covered: false }) })]
    const result = recentRoadDelay(matched)
    expect(result.published).toBe(true)
    expect(result.covered).toBe(false)
    expect(result.delay).toBeNull()
    // gradeRoads must then grade unknown — an empty window is not a clear road.
    const roads = gradeRoads([route('item:a', 'item:b')], matched)
    expect(roads[0].grade).toBe('unknown')
  })

  it('grades from the window when it is covered', () => {
    const matched = [
      family({ itemIds: ['item:a', 'item:b'], throttlingSeconds: 0, operationCount: '2', recentActivity: recent({ covered: true, operationCount: '4', throttlingSeconds: 40 }) }),
    ]
    const roads = gradeRoads([route('item:a', 'item:b')], matched)
    // 40 s over 4 recent operations = 10 s/op → heavy, using the window not the retained totals.
    expect(roads[0].grade).toBe('heavy')
  })
})

describe('throttleShare and roadDelay null-handling', () => {
  it('returns null when throttling was never measured', () => {
    const families = [family({ itemIds: ['item:a', 'item:b'], throttlingSeconds: null })]
    expect(throttleShare(families)).toBeNull()
    expect(roadDelay(families)).toBeNull()
  })
})

describe('confidencePattern', () => {
  it('maps confidence to a line pattern so colour stays free for congestion', () => {
    expect(confidencePattern('Confirmed')).toBe('solid')
    expect(confidencePattern('Probable')).toBe('dashed')
    expect(confidencePattern('Unknown')).toBe('sparse')
  })
})

describe('trafficEvidenceState — cannot-know is not the same as none', () => {
  it('withholds the road layer when the source cannot report families', () => {
    const state = trafficEvidenceState({ operationFamilies: false }, [])
    expect(state).toBe('unsupported')
    const disclosure = describeTrafficEvidence({ operationFamilies: false }, [])
    expect(disclosure.drawRoads).toBe(false)
    expect(disclosure.state).toBe('unsupported')
  })

  it('reports a measured-quiet capacity when the source can report families and returned none', () => {
    expect(trafficEvidenceState({ operationFamilies: true }, [])).toBe('none')
    expect(describeTrafficEvidence({ operationFamilies: true }, []).drawRoads).toBe(false)
  })

  it('draws roads when families were measured', () => {
    const families = [family({ itemIds: ['item:a', 'item:b'] })]
    expect(trafficEvidenceState({ operationFamilies: true }, families)).toBe('measured')
    expect(describeTrafficEvidence({ operationFamilies: true }, families).drawRoads).toBe(true)
  })
})
