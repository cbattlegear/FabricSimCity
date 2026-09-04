import { describe, expect, it } from 'vitest'
import {
  accessibleItemLabel,
  bytesToFootprint,
  cityItemMetricValue,
  cuToHeight,
  itemFootprint,
  itemHeight,
  itemMassing,
  storageSummary,
  shouldRenderRoute,
  MIN_FOOTPRINT,
  VACANT_FOOTPRINT,
  VACANT_HEIGHT,
} from './capacityCity'
import type {
  CapacityCityItem,
  CapacityCityRoute,
  FabricItemKind,
  ItemOperationCounts,
} from './capacityCityContracts'
import type { ByteMeasurement, CuMeasurement, Evidence } from './fabricContracts'
import { itemArchetype } from './itemKind'

const evidence: Evidence = {
  source: 'SemanticModel',
  status: 'Available',
  observedAt: '2026-09-04T12:00:00Z',
  freshUntil: '2026-09-04T12:15:00Z',
}

function bytes(value: string | null): ByteMeasurement {
  return { bytes: value, status: value === null ? 'Unknown' : 'Known', evidence }
}

function cu(value: string | null): CuMeasurement {
  return { cuSeconds: value, status: value === null ? 'Unknown' : 'Known', evidence }
}

const noOps: ItemOperationCounts = {
  total: null,
  successful: null,
  rejected: null,
  failed: null,
  invalid: null,
  cancelled: null,
}

function makeItem(overrides: Partial<CapacityCityItem> = {}): CapacityCityItem {
  const kind: FabricItemKind = overrides.kind ?? 'Lakehouse'
  return {
    itemId: 'item:1',
    workspaceId: 'ws:sales',
    workspaceName: 'Sales',
    name: 'Bronze',
    kind,
    archetype: itemArchetype(kind),
    storage: bytes('1073741824'),
    cuConsumed: cu('4096'),
    durationSeconds: 120,
    operations: { ...noOps, total: '900', rejected: '0' },
    distinctUsers: '7',
    throttlingMinutes: null,
    performanceDeltaPercent: null,
    layout: { neighborhoodOrdinal: 0, itemOrdinal: 3 },
    sizeStatus: 'Known',
    evidence,
    ...overrides,
  }
}

describe('city geometry scales', () => {
  it('footprint grows strictly with bytes and floors at the minimum lot', () => {
    expect(bytesToFootprint(0)).toBe(MIN_FOOTPRINT)
    expect(bytesToFootprint(1024)).toBeGreaterThan(bytesToFootprint(0))
    expect(bytesToFootprint(1_000_000_000)).toBeGreaterThan(bytesToFootprint(1024))
  })

  it('is strictly monotonic so two footprints never collide unless their bytes are equal', () => {
    const a = bytesToFootprint(5_000_000)
    const b = bytesToFootprint(5_000_001)
    expect(b).toBeGreaterThan(a)
  })

  it('rejects a negative or non-finite byte count rather than guessing', () => {
    expect(() => bytesToFootprint(-1)).toThrow(RangeError)
    expect(() => bytesToFootprint(Number.NaN)).toThrow(RangeError)
  })

  it('height grows with CU and is zero at zero CU', () => {
    expect(cuToHeight(0)).toBe(0)
    expect(cuToHeight(1024)).toBeGreaterThan(0)
    expect(cuToHeight(1_000_000)).toBeGreaterThan(cuToHeight(1024))
  })
})

describe('measurements that are missing rather than zero', () => {
  it('draws a storage-bearing item with no reported bytes as wireframe, not a speck', () => {
    const lakehouse = makeItem({ kind: 'Lakehouse', storage: bytes(null) })
    // A Lakehouse can hold OneLake storage, so absent bytes is missing evidence.
    expect(itemFootprint(lakehouse)).toBeNull()
    expect(itemMassing(lakehouse).kind).toBe('vacant')
    expect(itemMassing(lakehouse).footprint).toBe(VACANT_FOOTPRINT)
  })

  it('gives a compute-only item with no bytes a real minimum lot, because that is measured', () => {
    const notebook = makeItem({ kind: 'Notebook', storage: bytes(null) })
    // A Notebook holds no OneLake storage by nature — null bytes is a complete measurement.
    expect(itemFootprint(notebook)).toBe(MIN_FOOTPRINT)
    // With CU known it is a real tower on a minimum lot, never wireframe.
    expect(itemMassing(notebook).kind).toBe('built')
  })

  it('never renders a paused item (unknown CU) as an idle one (zero CU)', () => {
    const paused = makeItem({ cuConsumed: cu(null) })
    const idle = makeItem({ cuConsumed: cu('0') })
    // Unknown CU claims no height at all: wireframe.
    expect(itemHeight(paused)).toBeNull()
    expect(itemMassing(paused).kind).toBe('vacant')
    expect(itemMassing(paused).height).toBe(VACANT_HEIGHT)
    // Zero CU is a measured, paved lot at height zero: a built lot, not wireframe.
    expect(itemHeight(idle)).toBe(0)
    expect(itemMassing(idle).kind).toBe('built')
    expect(itemMassing(idle).height).toBe(0)
  })

  it('is vacant when storage is known but consumption is missing, drawn on its real footprint', () => {
    const item = makeItem({ storage: bytes('2048'), cuConsumed: cu(null) })
    const massing = itemMassing(item)
    expect(massing.kind).toBe('vacant')
    // The footprint is measured even though the height is not, so the fence stands on the real lot.
    expect(massing.footprint).toBe(bytesToFootprint(2048))
    expect(massing.footprint).not.toBe(VACANT_FOOTPRINT)
  })

  it('keeps a missing metric value null rather than sorting it as a zero', () => {
    const item = makeItem({
      cuConsumed: cu(null),
      storage: bytes(null),
      durationSeconds: null,
      operations: { ...noOps },
    })
    expect(cityItemMetricValue(item, 'Cu')).toBeNull()
    expect(cityItemMetricValue(item, 'Storage')).toBeNull()
    expect(cityItemMetricValue(item, 'Duration')).toBeNull()
    expect(cityItemMetricValue(item, 'Operations')).toBeNull()
  })
})

describe('metric values and labels', () => {
  it('reads the raw decimal string for each metric so precision survives', () => {
    const item = makeItem({
      cuConsumed: cu('90071992547409999'),
      storage: bytes('18446744073709551615'),
      durationSeconds: 42,
      operations: { ...noOps, total: '123456789012345' },
    })
    expect(cityItemMetricValue(item, 'Cu')).toBe('90071992547409999')
    expect(cityItemMetricValue(item, 'Storage')).toBe('18446744073709551615')
    expect(cityItemMetricValue(item, 'Duration')).toBe('42')
    expect(cityItemMetricValue(item, 'Operations')).toBe('123456789012345')
  })

  it('distinguishes "stores nothing" from "storage unavailable" from a measured size', () => {
    expect(storageSummary(makeItem({ kind: 'Notebook', storage: bytes(null) }))).toBe(
      'no OneLake storage',
    )
    expect(storageSummary(makeItem({ kind: 'Lakehouse', storage: bytes(null) }))).toBe(
      'OneLake storage unavailable',
    )
    expect(storageSummary(makeItem({ storage: bytes('1024') }))).toContain('OneLake storage')
    expect(storageSummary(makeItem({ storage: bytes('1024') }))).not.toContain('unavailable')
  })

  it('labels an item from measured evidence, naming workspace, kind, storage and CU', () => {
    const label = accessibleItemLabel(makeItem({ throttlingMinutes: 3, operations: { ...noOps, total: '900', rejected: '5' } }))
    expect(label).toContain('Sales / Bronze, lakehouse')
    expect(label).toContain('OneLake storage')
    expect(label).toContain('CU')
    expect(label).toContain('900 operations')
    expect(label).toContain('5 rejected')
    expect(label).toContain('throttled')
  })

  it('omits a zero rejection count and absent throttling from the label', () => {
    const label = accessibleItemLabel(makeItem())
    expect(label).not.toContain('rejected')
    expect(label).not.toContain('throttled')
  })
})

describe('route rendering does not invent endpoints', () => {
  const route: CapacityCityRoute = {
    routeId: 'route:1',
    fromItemId: 'item:1',
    toItemId: 'item:2',
    kind: 'Lineage',
    confidence: 'Probable',
    evidence,
  }

  it('draws a route only when both of its buildings are on screen', () => {
    expect(shouldRenderRoute(route, new Set(['item:1', 'item:2']))).toBe(true)
    expect(shouldRenderRoute(route, new Set(['item:1']))).toBe(false)
    expect(shouldRenderRoute(route, new Set(['item:2']))).toBe(false)
    expect(shouldRenderRoute(route, new Set())).toBe(false)
  })
})
