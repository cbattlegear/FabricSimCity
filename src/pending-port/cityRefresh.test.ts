import { describe, expect, it } from 'vitest'
import type { CapacityCityItem, CapacityCityWorkspace } from '../capacityCityContracts'
import type { Evidence } from '../fabricContracts'
import { cityLayoutSignature, citySchemaSignature, stableByContent } from './cityRefresh'

const evidence: Evidence = {
  source: 'QueryStoreAggregate',
  status: 'Available',
  observedAt: '2024-05-01T00:00:00Z',
  freshUntil: null,
  reason: 'test',
}

function object(overrides: Partial<CapacityCityItem> & { itemId: string }): CapacityCityItem {
  return {
    workspaceId: 'schema:1',
    workspaceName: 'dbo',
    name: 'Orders',
    kind: 'Table',
    storageBytes: '1000',
    cuSecondsRaw: '900',
    reservedBytes: null,
    usedBytes: null,
    sizeStatus: 'Known',
    sizeReason: null,
    layout: { neighborhoodOrdinal: 0, itemOrdinal: 0, x: 0, z: 0 },
    indexes: [],
    directActivity: {
      totalOperations: '0',
      resetEpochToken: null,
      evidence,
    },
    attributedExposure: {
      executionCount: null,
      totalCpuMicroseconds: null,
      totalDurationMicroseconds: null,
      totalLogicalReads8KiBPages: null,
      confidence: 'Confirmed',
      rationale: 'test',
      evidence,
    },
    ...overrides,
  }
}

describe('cityLayoutSignature', () => {
  it('ignores the activity that changes on every single refresh', () => {
    // The whole point: a poll that only moved the traffic must not re-run a 16-second layout.
    const before = [object({ itemId: 'o:1' })]
    const after = [object({
      itemId: 'o:1',
      directActivity: { ...before[0].directActivity, totalOperations: '99999' },
      attributedExposure: { ...before[0].attributedExposure, rationale: 'refreshed' },
    })]

    expect(cityLayoutSignature(after)).toBe(cityLayoutSignature(before))
  })

  it.each([
    ['a resized table', { storageBytes: '2000' }],
    ['a table that grew into its pages', { cuSecondsRaw: '950' }],
    ['a rekinded object', { kind: 'IndexedView' as const }],
    ['a moved neighbourhood', { layout: { neighborhoodOrdinal: 7, itemOrdinal: 0, x: 0, z: 0 } }],
    ['a renamed schema', { workspaceName: 'sales' }],
  ])('still re-plans for %s', (_label, change) => {
    const before = [object({ itemId: 'o:1' })]
    const after = [object({ itemId: 'o:1', ...change })]

    expect(cityLayoutSignature(after)).not.toBe(cityLayoutSignature(before))
  })

  it('re-plans when an object arrives or leaves', () => {
    const one = [object({ itemId: 'o:1' })]
    const two = [object({ itemId: 'o:1' }), object({ itemId: 'o:2', name: 'Lines' })]

    expect(cityLayoutSignature(two)).not.toBe(cityLayoutSignature(one))
  })
})

describe('citySchemaSignature', () => {
  function schema(overrides: Partial<CapacityCityWorkspace> = {}): CapacityCityWorkspace {
    return { workspaceId: 's:1', name: 'dbo', neighborhoodOrdinal: 0, itemCount: '4', evidence, ...overrides }
  }

  it('ignores evidence, which is re-dated by every refresh', () => {
    const before = [schema()]
    const after = [schema({ evidence: { ...evidence, observedAt: '2024-05-01T00:00:30Z' } })]

    expect(citySchemaSignature(after)).toBe(citySchemaSignature(before))
  })

  it('re-plans when a schema gains a member', () => {
    expect(citySchemaSignature([schema({ itemCount: '5' })])).not.toBe(citySchemaSignature([schema()]))
  })

  it('treats an absent schema list as its own value', () => {
    expect(citySchemaSignature(undefined)).toBe('')
    expect(citySchemaSignature([])).toBe('')
  })
})

describe('stableByContent', () => {
  it('hands back the previous value when the content matches', () => {
    const previous = [object({ itemId: 'o:1' })]
    const next = [object({ itemId: 'o:1' })]

    expect(next).not.toBe(previous)
    expect(stableByContent(previous, next, cityLayoutSignature)).toBe(previous)
  })

  it('hands back the new value when the content differs', () => {
    const previous = [object({ itemId: 'o:1' })]
    const next = [object({ itemId: 'o:1', storageBytes: '2000' })]

    expect(stableByContent(previous, next, cityLayoutSignature)).toBe(next)
  })
})
