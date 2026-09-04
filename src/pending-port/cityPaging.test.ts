import { describe, expect, it } from 'vitest'
import { mergeCityPage } from './cityPaging'
import type {
  CapacityCityItem,
  CapacityCityPage,
  OperationFamily,
  CapacityCityRoute,
  CapacityCityWorkspace,
  ThrottleAttribution,
} from '../capacityCityContracts'
import type { Evidence } from '../fabricContracts'

const evidence: Evidence = {
  source: 'CatalogSnapshot',
  status: 'Available',
  observedAt: null,
  freshUntil: null,
  reason: 'test',
}

function object(itemId: string, workspaceId: string): CapacityCityItem {
  return {
    itemId,
    workspaceId,
    workspaceName: workspaceId,
    name: itemId,
    kind: 'Table',
    storageBytes: '8',
    cuSecondsRaw: '4',
    reservedBytes: String(8n * 8192n),
    usedBytes: String(4n * 8192n),
    sizeStatus: 'Known',
    sizeReason: null,
    layout: { neighborhoodOrdinal: 0, itemOrdinal: 0, x: 0, z: 0 },
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

function route(routeId: string, from: string, to: string): CapacityCityRoute {
  return {
    routeId,
    fromItemId: from,
    toId: to,
    kind: 'ObjectReference',
    confidence: 'Confirmed',
    rationale: 'test',
    evidence,
  }
}

function schema(workspaceId: string, ordinal: number, count: string): CapacityCityWorkspace {
  return { workspaceId, name: workspaceId, neighborhoodOrdinal: ordinal, itemCount: count, evidence }
}

function family(
  familyId: string,
  itemIds: string[],
  overrides: Partial<OperationFamily> = {},
): OperationFamily {
  return {
    familyId,
    familyId: `0x${familyId}`,
    executionCount: '10',
    totalCpuMicroseconds: '100',
    totalDurationMicroseconds: '200',
    totalLogicalReads8KiBPages: '30',
    throttlingSeconds: '90',
    waitMillisecondsByCategory: {},
    itemIds,
    confidence: itemIds.length === 1 ? 'Confirmed' : itemIds.length > 1 ? 'Probable' : 'Unknown',
    rationale: 'named on this page',
    evidence,
    ...overrides,
  }
}

function waitAttribution(
  shares: Array<[string, string]>,
  throttlingSeconds: string,
  plansRead: number,
): ThrottleAttribution {
  const sum = shares.reduce((running, [, ms]) => running + BigInt(ms), 0n)
  return {
    objects: shares.map(([itemId, waitMilliseconds]) => ({
      itemId,
      estimatedCostShare: 0.5,
      waitMilliseconds,
    })),
    unattributedWaitMilliseconds: String(BigInt(throttlingSeconds) - sum),
    plansRead,
    rationale: 'split by estimated cost',
  }
}

function page(overrides: Partial<CapacityCityPage> = {}): CapacityCityPage {
  return {
    schemaVersion: '1.0',
    databaseId: 'db',
    databaseName: 'sales',
    metric: 'Cpu',
    pageSize: 50,
    nextPageToken: null,
    totalItems: '4',
    schemas: [],
    objects: [],
    topOperationFamilies: [],
    otherWorkload: {
      familyCount: null,
      executionCount: null,
      totalCpuMicroseconds: null,
      totalDurationMicroseconds: null,
      totalLogicalReads8KiBPages: null,
      throttlingSeconds: null,
      evidence,
    },
    routes: [],
    evidence,
    ...overrides,
  }
}

describe('mergeCityPage', () => {
  it('keeps the routes an earlier page carried when a later page carries none', () => {
    // The bug this exists for: co-references are reported per page, so a database whose routes all
    // sit among the first fifty objects returns an empty `routes` on page two. Replacing the page
    // wholesale erased every road ribbon the moment a second page landed.
    const first = page({
      nextPageToken: 'cursor',
      objects: [object('a', 's1'), object('b', 's1')],
      routes: [route('r1', 'a', 'b')],
    })
    const second = page({ objects: [object('c', 's1')], routes: [] })

    const merged = mergeCityPage(first, second)

    expect(merged.routes.map(item => item.routeId)).toEqual(['r1'])
    expect(merged.objects.map(item => item.itemId)).toEqual(['a', 'b', 'c'])
    expect(merged.nextPageToken).toBeNull()
  })

  it('sums per-page schema counts into the database-wide count the layout needs', () => {
    // `page.schemas` counts that page's objects, not the schema's. The city is laid out from these
    // counts, so they have to accumulate or a neighbourhood is sized for a fraction of its tables.
    const first = page({
      nextPageToken: 'cursor',
      objects: [object('a', 's1'), object('b', 's2')],
      schemas: [schema('s1', 0, '1'), schema('s2', 1, '1')],
    })
    const second = page({
      objects: [object('c', 's2'), object('d', 's3')],
      schemas: [schema('s2', 1, '1'), schema('s3', 2, '1')],
    })

    const merged = mergeCityPage(first, second)

    expect(merged.schemas.map(item => `${item.workspaceId}:${item.itemCount}`))
      .toEqual(['s1:1', 's2:2', 's3:1'])
  })

  it('is idempotent, so a repeated page never doubles a count', () => {
    const first = page({
      nextPageToken: 'cursor',
      objects: [object('a', 's1')],
      schemas: [schema('s1', 0, '1')],
      routes: [route('r1', 'a', 'a')],
    })

    const once = mergeCityPage(first, first)
    const twice = mergeCityPage(once, first)

    expect(once.schemas.map(item => item.itemCount)).toEqual(['1'])
    expect(twice.schemas.map(item => item.itemCount)).toEqual(['1'])
    expect(twice.objects).toHaveLength(1)
    expect(twice.routes).toHaveLength(1)
  })

  it('takes database-wide fields from the newer page and never loses the total', () => {
    const first = page({ nextPageToken: 'cursor', totalItems: '9' })
    const second = page({ totalItems: null, databaseName: 'sales' })

    const merged = mergeCityPage(first, second)

    expect(merged.totalItems).toBe('9')
    expect(merged.databaseName).toBe('sales')
  })

  it('unions a family\'s object ids across pages so a plan keeps every table it touched', () => {
    // The bug this exists for: a family's references are resolved against only the current page's
    // objects, so each page names a different subset. Taking the newest page wholesale left the
    // family carrying just the last page's ids — the "no loaded object named" the user saw.
    const first = page({ nextPageToken: 'cursor', topOperationFamilies: [family('f1', ['b', 'a'])] })
    const second = page({ topOperationFamilies: [family('f1', ['c', 'a'])] })

    const merged = mergeCityPage(first, second)

    expect(merged.topOperationFamilies).toHaveLength(1)
    // Deduplicated and sorted so the result does not depend on which page arrived first.
    expect(merged.topOperationFamilies[0].itemIds).toEqual(['a', 'b', 'c'])
  })

  it('is idempotent for families, so a repeated page changes neither ids nor rationale', () => {
    const first = page({
      nextPageToken: 'cursor',
      topOperationFamilies: [family('f1', ['a', 'b'], { confidence: 'Probable' })],
    })

    const once = mergeCityPage(first, first)
    const twice = mergeCityPage(once, first)

    expect(twice.topOperationFamilies[0].itemIds).toEqual(['a', 'b'])
    // Re-folding must not stack the merge note onto the rationale.
    expect(twice.topOperationFamilies[0].rationale).toBe(once.topOperationFamilies[0].rationale)
  })

  it('unions wait shares while keeping the exact sum invariant the contract states', () => {
    const first = page({
      nextPageToken: 'cursor',
      topOperationFamilies: [family('f1', ['a'], {
        throttlingSeconds: '90',
        waitAttribution: waitAttribution([['a', '30']], '90', 2),
      })],
    })
    const second = page({
      topOperationFamilies: [family('f1', ['b'], {
        throttlingSeconds: '90',
        waitAttribution: waitAttribution([['b', '40']], '90', 5),
      })],
    })

    const merged = mergeCityPage(first, second)
    const attribution = merged.topOperationFamilies[0].waitAttribution!

    expect(attribution.objects.map(share => share.itemId).sort()).toEqual(['a', 'b'])
    expect(attribution.plansRead).toBe(5)
    // parts + unattributed === total, checked in BigInt so no float rounding can hide a drift.
    const parts = attribution.objects.reduce((sum, share) => sum + BigInt(share.waitMilliseconds), 0n)
    expect(parts + BigInt(attribution.unattributedWaitMilliseconds)).toBe(90n)
    expect(attribution.unattributedWaitMilliseconds).toBe('20')
  })

  it('downgrades confidence to Probable once the union names more than one object', () => {
    const first = page({
      nextPageToken: 'cursor',
      topOperationFamilies: [family('f1', ['a'], { confidence: 'Confirmed' })],
    })
    const second = page({ topOperationFamilies: [family('f1', ['b'], { confidence: 'Confirmed' })] })

    const merged = mergeCityPage(first, second)

    // A total the plan spread across two buildings belongs to no single one, so it can only be Probable.
    expect(merged.topOperationFamilies[0].confidence).toBe('Probable')
  })

  it('keeps a single-object union at the confidence of the page that named it', () => {
    const first = page({
      nextPageToken: 'cursor',
      topOperationFamilies: [family('f1', ['a'], { confidence: 'Confirmed' })],
    })
    const second = page({ topOperationFamilies: [family('f1', [], { confidence: 'Unknown' })] })

    const merged = mergeCityPage(first, second)

    expect(merged.topOperationFamilies[0].itemIds).toEqual(['a'])
    expect(merged.topOperationFamilies[0].confidence).toBe('Confirmed')
  })

  it('retains a family only an earlier page carried, appended after the newest ranking', () => {
    const first = page({
      nextPageToken: 'cursor',
      topOperationFamilies: [family('f1', ['a']), family('f2', ['b'])],
    })
    const second = page({ topOperationFamilies: [family('f1', ['c'])] })

    const merged = mergeCityPage(first, second)

    // f1 keeps the newest page's slot; f2, which only page one carried, survives appended after.
    expect(merged.topOperationFamilies.map(item => item.familyId)).toEqual(['f1', 'f2'])
  })
})
