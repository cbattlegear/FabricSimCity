import { describe, expect, it } from 'vitest'
import { attributedWaits, familyCostShares, familyWaitByObject } from './cityThrottleAttribution'
import type { OperationFamily, ThrottleAttribution } from '../capacityCityContracts'
import type { Evidence } from '../fabricContracts'

const evidence: Evidence = {
  source: 'QueryStoreAggregate',
  status: 'Available',
  observedAt: null,
  freshUntil: null,
  reason: 'test',
}

function attribution(
  objects: Array<[string, number, string]>,
  unattributed = '0',
): ThrottleAttribution {
  return {
    objects: objects.map(([itemId, estimatedCostShare, waitMilliseconds]) => ({
      itemId,
      estimatedCostShare,
      waitMilliseconds,
    })),
    unattributedWaitMilliseconds: unattributed,
    plansRead: 1,
    rationale: 'test',
  }
}

function family(
  familyId: string,
  throttlingSeconds: string,
  waitAttribution: ThrottleAttribution | null = null,
  itemIds: string[] = [],
): OperationFamily {
  return {
    familyId,
    familyId: '0x00',
    executionCount: '10',
    totalCpuMicroseconds: '0',
    totalDurationMicroseconds: '0',
    totalLogicalReads8KiBPages: '0',
    throttlingSeconds,
    waitMillisecondsByCategory: {},
    itemIds,
    confidence: 'Confirmed',
    rationale: 'test',
    evidence,
    waitAttribution,
  }
}

describe('familyWaitByObject', () => {
  it('is empty when the family carries no attribution', () => {
    expect(familyWaitByObject(family('f1', '100')).size).toBe(0)
  })

  it('is empty when the attribution reached no object', () => {
    expect(familyWaitByObject(family('f1', '100', attribution([], '100'))).size).toBe(0)
  })

  it('reads each object\u2019s apportioned milliseconds', () => {
    const waits = familyWaitByObject(
      family('f1', '100', attribution([['object:1', 0.75, '75'], ['object:2', 0.25, '25']])),
    )
    expect(waits.get('object:1')).toBe(75n)
    expect(waits.get('object:2')).toBe(25n)
  })

  it('keeps very large totals exact', () => {
    const huge = '123456789012345678901234'
    const waits = familyWaitByObject(family('f1', huge, attribution([['object:1', 1, huge]])))
    expect(waits.get('object:1')).toBe(BigInt(huge))
  })

  it('ignores a malformed figure rather than throwing', () => {
    const waits = familyWaitByObject(family('f1', '100', attribution([['object:1', 1, 'not-a-number']])))
    expect(waits.size).toBe(0)
  })
})

describe('familyCostShares', () => {
  it('reads the estimated share the split placed on each object', () => {
    const shares = familyCostShares(
      family('f1', '100', attribution([['object:1', 0.8, '80'], ['object:2', 0.2, '20']])),
    )
    expect(shares.get('object:1')).toBeCloseTo(0.8, 9)
    expect(shares.get('object:2')).toBeCloseTo(0.2, 9)
  })
})

describe('attributedWaits', () => {
  it('reports nothing for an empty page', () => {
    const totals = attributedWaits([])
    expect(totals.byObject.size).toBe(0)
    expect(totals.note).toContain('No ranked query family')
  })

  it('sums one building\u2019s share across every family that named it', () => {
    const totals = attributedWaits([
      family('f1', '100', attribution([['object:1', 0.5, '50'], ['object:2', 0.5, '50']])),
      family('f2', '40', attribution([['object:1', 1, '40']])),
    ])
    expect(totals.byObject.get('object:1')!.milliseconds).toBe(90n)
    expect(totals.byObject.get('object:1')!.familyIds).toEqual(['f1', 'f2'])
    expect(totals.byObject.get('object:2')!.milliseconds).toBe(50n)
  })

  it('reconciles: every part plus the remainder equals the measured total', () => {
    const families = [
      family('f1', '100', attribution([['object:1', 0.6, '55'], ['object:2', 0.4, '37']], '8')),
      family('f2', '40', attribution([['object:1', 1, '31']], '9')),
    ]
    const totals = attributedWaits(families)
    let placed = 0n
    for (const entry of totals.byObject.values()) placed += entry.milliseconds
    expect(placed + totals.unattributed).toBe(totals.measured)
    expect(totals.measured).toBe(140n)
  })

  it('treats a family with no attribution as wholly unplaced, never as zero wait', () => {
    const totals = attributedWaits([family('f1', '250')])
    expect(totals.byObject.size).toBe(0)
    expect(totals.unattributed).toBe(250n)
    expect(totals.measured).toBe(250n)
    expect(totals.apportioned).toBe(0)
  })

  it('moves a share for a building this page does not draw into the remainder', () => {
    const totals = attributedWaits(
      [family('f1', '100', attribution([['object:1', 0.5, '50'], ['object:off', 0.5, '50']]))],
      new Set(['object:1']),
    )
    expect(totals.byObject.size).toBe(1)
    expect(totals.byObject.get('object:1')!.milliseconds).toBe(50n)
    expect(totals.unattributed).toBe(50n)
    let placed = 0n
    for (const entry of totals.byObject.values()) placed += entry.milliseconds
    expect(placed + totals.unattributed).toBe(totals.measured)
  })

  it('says plainly that the split is estimated and the milliseconds are not', () => {
    const totals = attributedWaits([family('f1', '100', attribution([['object:1', 1, '100']]))])
    expect(totals.note).toContain('measured')
    expect(totals.note).toContain('cost estimate')
  })
})
