import { planCity, type CityPlan } from './cityPlan'
import { itemArchetype } from './itemKind'
import type {
  CapacityCityItem,
  CapacityCityRoute,
  CapacityCityWorkspace,
  FabricItemKind,
  OperationFamily,
  OperationRecentActivity,
} from './capacityCityContracts'
import type { Evidence } from './fabricContracts'

/** A benign "measured" evidence stamp for fixtures. */
export const evidence: Evidence = {
  source: 'SemanticModel',
  status: 'Available',
  observedAt: null,
  freshUntil: null,
}

/**
 * One operation family with sensible measured defaults. Every field is overridable so a test can make
 * exactly one thing unmeasured (a null `throttlingSeconds`, an empty `operationCount`) without having
 * to restate the rest.
 */
export function family(overrides: Partial<OperationFamily> = {}): OperationFamily {
  const itemIds = overrides.itemIds ?? (overrides.itemId ? [overrides.itemId] : ['item:a'])
  const itemId = overrides.itemId ?? itemIds[0]
  return {
    familyId: `fam:${itemIds.join('_')}`,
    operationName: 'Warehouse Query',
    itemId,
    itemIds,
    workspaceId: 'ws:1',
    operationClass: 'Interactive',
    billingType: 'Billable',
    cuSeconds: '10',
    durationSeconds: 100,
    operationCount: '10',
    throttlingSeconds: 5,
    distinctUsers: '2',
    counts: { total: '10', successful: '10', rejected: null, failed: null, invalid: null, cancelled: null },
    recentActivity: null,
    evidence,
    ...overrides,
  }
}

/** A recent-activity window for fixtures that exercise the windowed grading path. */
export function recent(overrides: Partial<OperationRecentActivity> = {}): OperationRecentActivity {
  return {
    windowMinutes: 15,
    windowStart: '2024-01-01T00:00:00Z',
    windowEnd: '2024-01-01T00:15:00Z',
    covered: true,
    operationCount: '4',
    cuSeconds: '2',
    throttlingSeconds: 2,
    ...overrides,
  }
}

export function route(
  fromItemId: string,
  toItemId: string,
  overrides: Partial<CapacityCityRoute> = {},
): CapacityCityRoute {
  return {
    routeId: `${fromItemId}->${toItemId}`,
    fromItemId,
    toItemId,
    kind: 'SharedOperation',
    confidence: 'Confirmed',
    evidence,
    ...overrides,
  }
}

/** One placed building, sized from real bytes/CU so the lot gets a footprint and height. */
export function item(
  itemId: string,
  workspaceId: string,
  neighborhoodOrdinal: number,
  itemOrdinal: number,
  kind: FabricItemKind = 'Lakehouse',
): CapacityCityItem {
  return {
    itemId,
    workspaceId,
    workspaceName: workspaceId.replace('ws:', ''),
    name: itemId,
    kind,
    archetype: itemArchetype(kind),
    storage: { bytes: '4096', status: 'Known', evidence },
    cuConsumed: { cuSeconds: '2048', status: 'Known', evidence },
    durationSeconds: null,
    operations: { total: '1', successful: null, rejected: null, failed: null, invalid: null, cancelled: null },
    distinctUsers: null,
    throttlingMinutes: null,
    performanceDeltaPercent: null,
    layout: { neighborhoodOrdinal, itemOrdinal },
    sizeStatus: 'Known',
    evidence,
  }
}

/** A small two-workspace city with enough items that lots land on distinct blocks. */
export function sampleItems(): CapacityCityItem[] {
  const items: CapacityCityItem[] = []
  for (let i = 0; i < 6; i += 1) items.push(item(`item:a:${i}`, 'ws:alpha', 0, i))
  for (let i = 0; i < 4; i += 1) items.push(item(`item:b:${i}`, 'ws:beta', 1, i))
  return items
}

export function sampleWorkspaces(): CapacityCityWorkspace[] {
  return [
    { workspaceId: 'ws:alpha', name: 'alpha', neighborhoodOrdinal: 0, itemCount: '6', evidence },
    { workspaceId: 'ws:beta', name: 'beta', neighborhoodOrdinal: 1, itemCount: '4', evidence },
  ]
}

export function buildPlan(items: CapacityCityItem[] = sampleItems()): CityPlan {
  return planCity(items, { seed: 'capacity:test', totalItems: String(items.length), workspaces: sampleWorkspaces() })
}
