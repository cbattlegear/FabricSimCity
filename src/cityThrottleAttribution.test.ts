import { describe, expect, it } from 'vitest'
import type { OperationClass, OperationFamily, ItemOperationCounts } from './capacityCityContracts'
import type { Evidence, ThrottleState } from './fabricContracts'
import {
  attributedThrottling,
  familyThrottleAttribution,
  familyThrottleStage,
} from './cityThrottleAttribution'

const evidence: Evidence = {
  source: 'Fixture',
  status: 'Available',
  observedAt: '2026-09-04T12:00:00Z',
  freshUntil: '2026-09-04T12:05:00Z',
}

const noCounts: ItemOperationCounts = {
  total: '10',
  successful: '10',
  rejected: '0',
  failed: '0',
  invalid: '0',
  cancelled: '0',
}

function throttle(overrides: Partial<ThrottleState> = {}): ThrottleState {
  return {
    stage: 'InteractiveDelay',
    interactiveDelayPercent: 125,
    interactiveRejectionPercent: 40,
    backgroundRejectionPercent: 20,
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
    counts: noCounts,
    evidence,
    ...rest,
  }
}

function counts(rejected: string | null): ItemOperationCounts {
  return { ...noCounts, rejected }
}

describe('familyThrottleStage', () => {
  it('routes delayed interactive work to the delay gate stage', () => {
    const stage = familyThrottleStage(family({ familyId: 'f1' }), throttle())
    expect(stage).toBe('InteractiveDelay')
  })

  it('routes rejected interactive work to the interactive rejection stage', () => {
    const stage = familyThrottleStage(
      family({ familyId: 'f1', counts: counts('3') }),
      throttle({
        stage: 'InteractiveRejection',
        interactiveDelayPercent: 130,
        interactiveRejectionPercent: 115,
      }),
    )
    expect(stage).toBe('InteractiveRejection')
  })

  it('routes rejected background work only to the background rejection stage', () => {
    const background = family({
      familyId: 'f1',
      operationClass: 'Background',
      counts: counts('2'),
    })
    expect(
      familyThrottleStage(
        background,
        throttle({
          stage: 'InteractiveRejection',
          interactiveDelayPercent: 130,
          interactiveRejectionPercent: 115,
          backgroundRejectionPercent: 42,
        }),
      ),
    ).toBeNull()
    expect(
      familyThrottleStage(
        background,
        throttle({
          stage: 'BackgroundRejection',
          interactiveDelayPercent: 130,
          interactiveRejectionPercent: 115,
          backgroundRejectionPercent: 108,
        }),
      ),
    ).toBe('BackgroundRejection')
  })

  it('does not invent a gate when rejection-stage rejected-count evidence is absent', () => {
    const stage = familyThrottleStage(
      family({ familyId: 'f1', counts: counts(null) }),
      throttle({
        stage: 'InteractiveRejection',
        interactiveDelayPercent: 130,
        interactiveRejectionPercent: 115,
      }),
    )
    expect(stage).toBeNull()
  })

  it('does not route unknown operation classes to a guessed gate', () => {
    const stage = familyThrottleStage(
      family({ familyId: 'f1', operationClass: 'Unknown' as OperationClass }),
      throttle(),
    )
    expect(stage).toBeNull()
  })
})

describe('familyThrottleAttribution', () => {
  it('keeps measured seconds and identifies the later geometry endpoint', () => {
    const attribution = familyThrottleAttribution(family({ familyId: 'f1' }), throttle())
    expect(attribution).toEqual({
      familyId: 'f1',
      itemId: 'item:1',
      stage: 'InteractiveDelay',
      facility: 'delayGate',
      seconds: 20,
    })
  })

  it('returns no attribution when throttling seconds are absent rather than zero', () => {
    expect(
      familyThrottleAttribution(family({ familyId: 'f1', throttlingSeconds: null }), throttle()),
    ).toBeNull()
  })
})

describe('attributedThrottling', () => {
  it('sums one item and stage across every family that named it', () => {
    const totals = attributedThrottling(
      [
        family({ familyId: 'f2', throttlingSeconds: 5 }),
        family({ familyId: 'f1', throttlingSeconds: 7 }),
      ],
      throttle(),
    )

    const item = totals.byItemStage.get('item:1:InteractiveDelay')!
    expect(item.seconds).toBe(12)
    expect(item.familyIds).toEqual(['f1', 'f2'])
    expect(totals.byStage.get('InteractiveDelay')?.facility).toBe('delayGate')
    expect(totals.byStage.get('InteractiveDelay')?.seconds).toBe(12)
  })

  it('keeps off-page and unrouteable throttling in the unattributed total', () => {
    const totals = attributedThrottling(
      [
        family({ familyId: 'off-page', itemId: 'item:2', itemIds: ['item:2'], throttlingSeconds: 8 }),
        family({ familyId: 'unknown-class', operationClass: 'Unknown', throttlingSeconds: 4 }),
      ],
      throttle(),
      new Set(['item:1']),
    )

    expect(totals.byItemStage.size).toBe(0)
    expect(totals.unattributedSeconds).toBe(12)
    expect(totals.measuredSeconds).toBe(12)
  })

  it('counts missing throttling measurements without adding healthy zero-load seconds', () => {
    const totals = attributedThrottling(
      [
        family({ familyId: 'missing', throttlingSeconds: null }),
        family({ familyId: 'idle', throttlingSeconds: 0 }),
      ],
      throttle(),
    )

    expect(totals.measuredSeconds).toBe(0)
    expect(totals.measuredFamilyCount).toBe(1)
    expect(totals.unmeasuredFamilyCount).toBe(1)
    expect(totals.note).toContain('had no throttling measurement')
  })

  it('does not turn an absent active gauge into an inactive healthy gate', () => {
    const totals = attributedThrottling(
      [family({ familyId: 'f1', throttlingSeconds: 30 })],
      throttle({ interactiveDelayPercent: null }),
    )

    expect(totals.byItemStage.size).toBe(0)
    expect(totals.unattributedSeconds).toBe(30)
    expect(totals.measuredSeconds).toBe(30)
  })
})
