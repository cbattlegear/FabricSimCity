import { describe, expect, it } from 'vitest'
import { mergeCityPage } from './cityPaging'
import type {
  CapacityCityItem,
  CapacityCityPage,
  OperationFamily,
  CapacityCityRoute,
  CapacityCityWorkspace,
  ItemOperationCounts,
} from './capacityCityContracts'
import type { Evidence, ThrottleState } from './fabricContracts'
import { itemArchetype } from './itemKind'

const evidence: Evidence = {
  source: 'SemanticModel',
  status: 'Available',
  observedAt: null,
  freshUntil: null,
}

const noCounts: ItemOperationCounts = {
  total: null,
  successful: null,
  rejected: null,
  failed: null,
  invalid: null,
  cancelled: null,
}

const throttle: ThrottleState = {
  stage: 'None',
  interactiveDelayPercent: null,
  interactiveRejectionPercent: null,
  backgroundRejectionPercent: null,
  cumulativeCarryOverPercent: null,
  expectedBurndownMinutes: null,
  surgeProtectionActive: false,
  evidence,
}

function item(itemId: string, workspaceId: string): CapacityCityItem {
  return {
    itemId,
    workspaceId,
    workspaceName: workspaceId,
    name: itemId,
    kind: 'Lakehouse',
    archetype: itemArchetype('Lakehouse'),
    storage: { bytes: '1024', status: 'Known', evidence },
    cuConsumed: { cuSeconds: '8', status: 'Known', evidence },
    durationSeconds: 1,
    operations: { ...noCounts, total: '1' },
    distinctUsers: null,
    throttlingMinutes: null,
    performanceDeltaPercent: null,
    layout: { neighborhoodOrdinal: 0, itemOrdinal: 0 },
    sizeStatus: 'Known',
    evidence,
  }
}

function route(routeId: string, from: string, to: string): CapacityCityRoute {
  return { routeId, fromItemId: from, toItemId: to, kind: 'Lineage', confidence: 'Probable', evidence }
}

function workspace(workspaceId: string, ordinal: number, count: string | null): CapacityCityWorkspace {
  return { workspaceId, name: workspaceId, neighborhoodOrdinal: ordinal, itemCount: count, evidence }
}

function family(familyId: string, itemIds: string[]): OperationFamily {
  return {
    familyId,
    operationName: `op ${familyId}`,
    itemId: itemIds[0] ?? 'x',
    itemIds,
    workspaceId: 's1',
    operationClass: 'Interactive',
    billingType: 'Billable',
    cuSeconds: '100',
    durationSeconds: 2,
    operationCount: '10',
    throttlingSeconds: null,
    distinctUsers: null,
    counts: { ...noCounts },
    evidence,
  }
}

function page(overrides: Partial<CapacityCityPage> = {}): CapacityCityPage {
  return {
    schemaVersion: '1.0',
    capacityId: 'cap:1',
    capacityName: 'Sales',
    metric: 'Cu',
    pageSize: 50,
    nextPageToken: null,
    totalItems: '4',
    window: { start: '2026-09-04T00:00:00Z', end: '2026-09-04T01:00:00Z' },
    workspaces: [],
    items: [],
    topOperationFamilies: [],
    otherWorkload: {
      familyCount: null,
      operationCount: null,
      cuSeconds: null,
      durationSeconds: null,
      evidence,
    },
    routes: [],
    throttle,
    evidence,
    ...overrides,
  }
}

describe('mergeCityPage', () => {
  it('keeps the routes an earlier page carried when a later page carries none', () => {
    const first = page({
      nextPageToken: 'cursor',
      items: [item('a', 's1'), item('b', 's1')],
      routes: [route('r1', 'a', 'b')],
    })
    const second = page({ items: [item('c', 's1')], routes: [] })

    const merged = mergeCityPage(first, second)

    expect(merged.routes.map(r => r.routeId)).toEqual(['r1'])
    expect(merged.items.map(i => i.itemId)).toEqual(['a', 'b', 'c'])
    expect(merged.nextPageToken).toBeNull()
  })

  it('sums per-page workspace counts into the capacity-wide count the layout needs', () => {
    const first = page({
      nextPageToken: 'cursor',
      items: [item('a', 's1'), item('b', 's2')],
      workspaces: [workspace('s1', 0, '1'), workspace('s2', 1, '1')],
    })
    const second = page({
      items: [item('c', 's2'), item('d', 's3')],
      workspaces: [workspace('s2', 1, '1'), workspace('s3', 2, '1')],
    })

    const merged = mergeCityPage(first, second)

    expect(merged.workspaces.map(w => `${w.workspaceId}:${w.itemCount}`))
      .toEqual(['s1:1', 's2:2', 's3:1'])
  })

  it('keeps a workspace count null when either page did not report it, never zero-filling', () => {
    // A missing count is not a zero: summing a real count against an unmeasured one would publish a
    // total the map never had, which is the "missing rather than zero" rule at the workspace level.
    const first = page({
      nextPageToken: 'cursor',
      items: [item('a', 's1')],
      workspaces: [workspace('s1', 0, '2')],
    })
    const second = page({
      items: [item('b', 's1')],
      workspaces: [workspace('s1', 0, null)],
    })

    const merged = mergeCityPage(first, second)

    expect(merged.workspaces[0].itemCount).toBeNull()
  })

  it('is idempotent, so a repeated page never doubles a count', () => {
    const first = page({
      nextPageToken: 'cursor',
      items: [item('a', 's1')],
      workspaces: [workspace('s1', 0, '1')],
      routes: [route('r1', 'a', 'a')],
    })

    const once = mergeCityPage(first, first)
    const twice = mergeCityPage(once, first)

    expect(once.workspaces.map(w => w.itemCount)).toEqual(['1'])
    expect(twice.workspaces.map(w => w.itemCount)).toEqual(['1'])
    expect(twice.items).toHaveLength(1)
    expect(twice.routes).toHaveLength(1)
  })

  it('takes capacity-wide fields from the newer page and never loses the total', () => {
    const first = page({ nextPageToken: 'cursor', totalItems: '9' })
    const second = page({ totalItems: null, capacityName: 'Sales' })

    const merged = mergeCityPage(first, second)

    expect(merged.totalItems).toBe('9')
    expect(merged.capacityName).toBe('Sales')
  })

  it("unions a family's item ids across pages so an operation keeps every item it touched", () => {
    const first = page({ nextPageToken: 'cursor', topOperationFamilies: [family('f1', ['b', 'a'])] })
    const second = page({ topOperationFamilies: [family('f1', ['c', 'a'])] })

    const merged = mergeCityPage(first, second)

    expect(merged.topOperationFamilies).toHaveLength(1)
    expect(merged.topOperationFamilies[0].itemIds).toEqual(['a', 'b', 'c'])
  })

  it('is idempotent for families, so a repeated page changes the id set not at all', () => {
    const first = page({ nextPageToken: 'cursor', topOperationFamilies: [family('f1', ['a', 'b'])] })

    const once = mergeCityPage(first, first)
    const twice = mergeCityPage(once, first)

    expect(twice.topOperationFamilies[0].itemIds).toEqual(['a', 'b'])
  })

  it('retains a family only an earlier page carried, appended after the newest ranking', () => {
    const first = page({
      nextPageToken: 'cursor',
      topOperationFamilies: [family('f1', ['a']), family('f2', ['b'])],
    })
    const second = page({ topOperationFamilies: [family('f1', ['c'])] })

    const merged = mergeCityPage(first, second)

    expect(merged.topOperationFamilies.map(f => f.familyId)).toEqual(['f1', 'f2'])
    expect(merged.topOperationFamilies[0].itemIds).toEqual(['a', 'c'])
  })
})
