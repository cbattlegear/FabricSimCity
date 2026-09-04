import { describe, expect, it } from 'vitest'
import type { ItemOperationCounts, OperationFamily } from './capacityCityContracts'
import type { Evidence, ThrottleState } from './fabricContracts'
import {
  FACILITY_LANE_LEGEND,
  FACILITY_LANE_NOTE,
  POWER_GRID_FACILITY_LEGEND,
  POWER_GRID_STATE_COLORS,
  POWER_GRID_STATE_LEGEND,
  facilityMixLabel,
  facilityShares,
  gateOutcomeForStage,
  projectFacilityTraffic,
} from './cityFacilityTraffic'
import { CONGESTION_COLORS } from './cityTraffic'
import { POWER_GRID_FACILITY_ORDER } from './powerGrid'

const evidence: Evidence = {
  source: 'Fixture',
  status: 'Available',
  observedAt: '2026-09-04T12:00:00Z',
  freshUntil: '2026-09-04T12:05:00Z',
}

const baseCounts: ItemOperationCounts = {
  total: '10',
  successful: '10',
  rejected: '0',
  failed: '0',
  invalid: '0',
  cancelled: '0',
}

function counts(rejected: string | null): ItemOperationCounts {
  return { ...baseCounts, rejected }
}

/** Delay stage active, both rejection gauges hot, so any class can reach any gate a test drives it to. */
function throttle(overrides: Partial<ThrottleState> = {}): ThrottleState {
  return {
    stage: 'BackgroundRejection',
    interactiveDelayPercent: 130,
    interactiveRejectionPercent: 115,
    backgroundRejectionPercent: 108,
    cumulativeCarryOverPercent: 12,
    expectedBurndownMinutes: 30,
    surgeProtectionActive: false,
    evidence,
    ...overrides,
  }
}

function family(
  overrides: Partial<OperationFamily> & { familyId: string },
): OperationFamily {
  const { familyId, ...rest } = overrides
  return {
    familyId,
    operationName: 'Warehouse Query',
    itemId: 'item:1',
    itemIds: ['item:1'],
    workspaceId: 'workspace:1',
    operationClass: 'Interactive',
    billingType: 'Billable',
    cuSeconds: '100',
    durationSeconds: 12,
    operationCount: '10',
    throttlingSeconds: 20,
    distinctUsers: '2',
    counts: baseCounts,
    evidence,
    ...rest,
  }
}

const items = [{ itemId: 'item:1' }, { itemId: 'item:2' }]

describe('gateOutcomeForStage · the delay gate is load, never blackout', () => {
  it('delays interactive work at the delay gate rather than refusing it', () => {
    expect(gateOutcomeForStage('InteractiveDelay')).toBe('delayed')
  })

  it('refuses work at both rejection gates', () => {
    expect(gateOutcomeForStage('InteractiveRejection')).toBe('refused')
    expect(gateOutcomeForStage('BackgroundRejection')).toBe('refused')
  })
})

describe('projectFacilityTraffic · lanes from a building to the gate that held its work', () => {
  it('draws a delay-gate lane as load, never a blackout', () => {
    const traffic = projectFacilityTraffic(
      [family({ familyId: 'f1', throttlingSeconds: 30 })],
      items,
      throttle({ interactiveDelayPercent: 130, interactiveRejectionPercent: 40 }),
    )

    expect(traffic.lanes).toHaveLength(1)
    const [lane] = traffic.lanes
    expect(lane.facility).toBe('delayGate')
    // The invariant under test: an interactive-delay lane is delayed load, not a refused blackout.
    expect(lane.outcome).toBe('delayed')
    expect(lane.rationale).toMatch(/delayed, not refused/)
    expect(lane.rationale).not.toMatch(/blackout/)
    expect(lane.mode).toBe('car')
  })

  it('draws a refused blackout lane for rejected interactive work', () => {
    const traffic = projectFacilityTraffic(
      [family({ familyId: 'f1', counts: counts('4'), throttlingSeconds: 30 })],
      items,
      throttle({ stage: 'InteractiveRejection', backgroundRejectionPercent: 20 }),
    )

    expect(traffic.lanes).toHaveLength(1)
    expect(traffic.lanes[0].facility).toBe('interactiveRejectionGate')
    expect(traffic.lanes[0].outcome).toBe('refused')
    expect(traffic.lanes[0].mode).toBe('car')
  })

  it('draws background rejection as refused freight', () => {
    const traffic = projectFacilityTraffic(
      [family({ familyId: 'f1', operationClass: 'Background', counts: counts('2'), throttlingSeconds: 40 })],
      items,
      throttle(),
    )

    expect(traffic.lanes).toHaveLength(1)
    expect(traffic.lanes[0].facility).toBe('backgroundRejectionGate')
    expect(traffic.lanes[0].outcome).toBe('refused')
    expect(traffic.lanes[0].mode).toBe('freight')
  })

  it('colours a lane on the same throttling-per-operation ladder as the roads', () => {
    // 60 s over 10 operations is 6 s each: heavy, exactly as a road with the same ratio grades.
    const traffic = projectFacilityTraffic(
      [family({ familyId: 'f1', throttlingSeconds: 60, operationCount: '10' })],
      items,
      throttle({ interactiveDelayPercent: 130, interactiveRejectionPercent: 40 }),
    )

    const [lane] = traffic.lanes
    expect(lane.delayPerOperation).toBeCloseTo(6, 10)
    expect(lane.grade).toBe('heavy')
    expect(lane.color).toBe(CONGESTION_COLORS.heavy)
  })

  it('grades a lane with no operation count grey, not green', () => {
    // Seconds are measured but the family reports no usable operation count, so no per-operation rate
    // can be computed. A green (free) lane here would be a quiet measured-looking claim the source
    // never made — it must be grey (unknown) instead.
    const traffic = projectFacilityTraffic(
      [family({ familyId: 'f1', throttlingSeconds: 30, operationCount: 'n/a' })],
      items,
      throttle({ interactiveDelayPercent: 130, interactiveRejectionPercent: 40 }),
    )

    expect(traffic.lanes).toHaveLength(1)
    const [lane] = traffic.lanes
    expect(lane.operations).toBeNull()
    expect(lane.delayPerOperation).toBeNull()
    expect(lane.grade).toBe('unknown')
    expect(lane.color).toBe(CONGESTION_COLORS.unknown)
    expect(lane.color).not.toBe(CONGESTION_COLORS.free)
  })

  it('draws no lane for a family whose throttling was not measured', () => {
    // The unmeasured-facility rule at the lane level: absent seconds render as no lane (unbuilt),
    // never as a quiet zero-load lane.
    const traffic = projectFacilityTraffic(
      [family({ familyId: 'f1', throttlingSeconds: null })],
      items,
      throttle({ interactiveDelayPercent: 130, interactiveRejectionPercent: 40 }),
    )

    expect(traffic.lanes).toHaveLength(0)
    expect(traffic.measuredFamilyCount).toBe(0)
    expect(traffic.unmeasuredFamilyCount).toBe(1)
    expect(traffic.note).toContain('not drawn as zero-load gates')
  })

  it('sums the seconds of several families held at one building and gate', () => {
    const traffic = projectFacilityTraffic(
      [
        family({ familyId: 'f2', throttlingSeconds: 5, operationCount: '5' }),
        family({ familyId: 'f1', throttlingSeconds: 7, operationCount: '5' }),
      ],
      items,
      throttle({ interactiveDelayPercent: 130, interactiveRejectionPercent: 40 }),
    )

    expect(traffic.lanes).toHaveLength(1)
    const [lane] = traffic.lanes
    expect(lane.throttlingSeconds).toBe(12)
    expect(lane.operations).toBe(10)
    expect(lane.familyIds).toEqual(['f1', 'f2'])
  })

  it('orders lanes by measured seconds so the ordering is stable and readable', () => {
    const traffic = projectFacilityTraffic(
      [
        family({ familyId: 'small', itemId: 'item:1', itemIds: ['item:1'], throttlingSeconds: 10 }),
        family({ familyId: 'big', itemId: 'item:2', itemIds: ['item:2'], throttlingSeconds: 90 }),
      ],
      items,
      throttle({ interactiveDelayPercent: 130, interactiveRejectionPercent: 40 }),
    )

    expect(traffic.lanes.map(lane => lane.laneId)).toEqual([
      'item:2->delayGate',
      'item:1->delayGate',
    ])
  })

  it('keeps off-page throttling out of the lanes and in the unattributed total', () => {
    const traffic = projectFacilityTraffic(
      [family({ familyId: 'off', itemId: 'item:9', itemIds: ['item:9'], throttlingSeconds: 25 })],
      items,
      throttle({ interactiveDelayPercent: 130, interactiveRejectionPercent: 40 }),
    )

    expect(traffic.lanes).toHaveLength(0)
    expect(traffic.unattributedSeconds).toBe(25)
    expect(traffic.measuredSeconds).toBe(25)
  })

  it('withholds the layer when the source cannot report operation families', () => {
    const measuredTraffic = projectFacilityTraffic(
      [family({ familyId: 'f1', throttlingSeconds: 20 })],
      items,
      throttle({ interactiveDelayPercent: 130, interactiveRejectionPercent: 40 }),
      { operationFamilies: false },
    )
    expect(measuredTraffic.evidence).toBe('unsupported')

    const supportedButEmpty = projectFacilityTraffic([], items, throttle(), { operationFamilies: true })
    expect(supportedButEmpty.evidence).toBe('none')

    const measured = projectFacilityTraffic(
      [family({ familyId: 'f1', throttlingSeconds: 20 })],
      items,
      throttle({ interactiveDelayPercent: 130, interactiveRejectionPercent: 40 }),
      { operationFamilies: true },
    )
    expect(measured.evidence).toBe('measured')
  })

  it('claims nothing at all when no family was returned', () => {
    const traffic = projectFacilityTraffic([], items, throttle())
    expect(traffic.lanes).toHaveLength(0)
    expect(traffic.familyCount).toBe(0)
    expect(traffic.note).toMatch(/no throttle attribution is claimed/)
  })
})

describe('facilityShares · where one building was held', () => {
  it('splits one building\'s throttling by gate, busiest first', () => {
    const traffic = projectFacilityTraffic(
      [
        family({ familyId: 'reject', counts: counts('3'), throttlingSeconds: 75, operationCount: '5' }),
        family({ familyId: 'delay', throttlingSeconds: 25, operationCount: '5' }),
      ],
      items,
      throttle({ stage: 'InteractiveRejection', backgroundRejectionPercent: 20 }),
    )

    const shares = facilityShares('item:1', traffic)
    expect(shares.map(share => share.facility)).toEqual(['interactiveRejectionGate', 'delayGate'])
    expect(shares[0].seconds).toBe(75)
    expect(shares[0].share).toBeCloseTo(0.75, 10)
    expect(shares[0].outcome).toBe('refused')
    expect(shares[1].outcome).toBe('delayed')
  })

  it('answers for the building asked about and not for its neighbours', () => {
    const traffic = projectFacilityTraffic(
      [
        family({ familyId: 'f1', itemId: 'item:1', itemIds: ['item:1'], throttlingSeconds: 10 }),
        family({ familyId: 'f2', itemId: 'item:2', itemIds: ['item:2'], throttlingSeconds: 90 }),
      ],
      items,
      throttle({ interactiveDelayPercent: 130, interactiveRejectionPercent: 40 }),
    )

    expect(facilityShares('item:1', traffic).map(share => share.seconds)).toEqual([10])
    expect(facilityShares('item:2', traffic).map(share => share.seconds)).toEqual([90])
  })

  it('claims nothing for a building with no attributed throttling', () => {
    const traffic = projectFacilityTraffic(
      [family({ familyId: 'f1', itemId: 'item:1', itemIds: ['item:1'], throttlingSeconds: 10 })],
      items,
      throttle({ interactiveDelayPercent: 130, interactiveRejectionPercent: 40 }),
    )
    expect(facilityShares('item:2', traffic)).toEqual([])
    expect(facilityShares('nowhere', traffic)).toEqual([])
  })

  it('breaks a dead-heat on facility name so the readout does not flicker', () => {
    const traffic = projectFacilityTraffic(
      [
        family({ familyId: 'delay', throttlingSeconds: 50, operationCount: '5' }),
        family({ familyId: 'reject', counts: counts('3'), throttlingSeconds: 50, operationCount: '5' }),
      ],
      items,
      throttle({ stage: 'InteractiveRejection', backgroundRejectionPercent: 20 }),
    )
    // delayGate and interactiveRejectionGate tie at 50 s each; the tie-break is the facility name.
    expect(facilityShares('item:1', traffic).map(share => share.facility)).toEqual([
      'delayGate',
      'interactiveRejectionGate',
    ])
  })
})

describe('facilityMixLabel', () => {
  it('names the gate the way the map labels it, so it can be found', () => {
    const traffic = projectFacilityTraffic(
      [family({ familyId: 'f1', throttlingSeconds: 30 })],
      items,
      throttle({ interactiveDelayPercent: 130, interactiveRejectionPercent: 40 }),
    )
    expect(facilityMixLabel(facilityShares('item:1', traffic))).toBe('delay gate 100%')
  })

  it('lists at most three, because the fourth is noise in a hover readout', () => {
    const shares = [
      { facility: 'delayGate' as const, label: 'One', seconds: 4, share: 0.4, outcome: 'delayed' as const },
      { facility: 'interactiveRejectionGate' as const, label: 'Two', seconds: 3, share: 0.3, outcome: 'refused' as const },
      { facility: 'backgroundRejectionGate' as const, label: 'Three', seconds: 2, share: 0.2, outcome: 'refused' as const },
      { facility: 'reservoir' as const, label: 'Four', seconds: 1, share: 0.1, outcome: 'delayed' as const },
    ]
    expect(facilityMixLabel(shares)).toBe('one 40%, two 30%, three 20%')
  })

  it('returns null when there is nothing to report', () => {
    expect(facilityMixLabel([])).toBeNull()
  })
})

describe('legend entries exported for the scene to render', () => {
  it('has one facility row per power-grid facility, in placement order', () => {
    expect(POWER_GRID_FACILITY_LEGEND.map(entry => entry.kind)).toEqual([...POWER_GRID_FACILITY_ORDER])
    for (const entry of POWER_GRID_FACILITY_LEGEND) {
      expect(entry.label.length).toBeGreaterThan(0)
      expect(entry.meaning.length).toBeGreaterThan(0)
    }
  })

  it('marks the delay gate as delayed load and the rejection gates as refused', () => {
    const outcomeOf = (kind: string) =>
      POWER_GRID_FACILITY_LEGEND.find(entry => entry.kind === kind)?.gateOutcome
    expect(outcomeOf('delayGate')).toBe('delayed')
    expect(outcomeOf('interactiveRejectionGate')).toBe('refused')
    expect(outcomeOf('backgroundRejectionGate')).toBe('refused')
    // Non-gate facilities carry no load/blackout outcome.
    expect(outcomeOf('powerPlant')).toBeNull()
    expect(outcomeOf('reservoir')).toBeNull()
  })

  it('keys facility state colours to the road congestion palette so lanes and facilities agree', () => {
    expect(POWER_GRID_STATE_COLORS.healthy).toBe(CONGESTION_COLORS.free)
    expect(POWER_GRID_STATE_COLORS.loaded).toBe(CONGESTION_COLORS.moderate)
    expect(POWER_GRID_STATE_COLORS.brownout).toBe(CONGESTION_COLORS.heavy)
    expect(POWER_GRID_STATE_COLORS.blackout).toBe(CONGESTION_COLORS.severe)
    expect(POWER_GRID_STATE_COLORS.unbuilt).toBe(CONGESTION_COLORS.unknown)
    expect(POWER_GRID_STATE_LEGEND.map(entry => entry.state)).toContain('unbuilt')
  })

  it('uses the road congestion ladder verbatim as the lane colour key', () => {
    for (const entry of FACILITY_LANE_LEGEND) {
      expect(entry.color).toBe(CONGESTION_COLORS[entry.grade])
    }
    expect(FACILITY_LANE_NOTE).toMatch(/delayed, not refused/)
    expect(FACILITY_LANE_NOTE).toMatch(/grey rather than green/)
  })
})
