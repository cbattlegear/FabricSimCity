import { describe, expect, it } from 'vitest'
import type { CapacityCityItem, CapacityCityWorkspace } from './capacityCityContracts'
import type { CapacitySourceCapabilities } from './collect/source'
import type { Evidence } from './fabricContracts'
import { TIMEPOINT_SECONDS } from './fabricContracts'
import {
  cityLayoutSignature,
  citySchemaSignature,
  refreshIntervalMs,
  stableByContent,
} from './cityRefresh'

const evidence: Evidence = {
  source: 'SemanticModel',
  status: 'Available',
  observedAt: '2024-05-01T00:00:00Z',
  freshUntil: null,
}

function item(overrides: Partial<CapacityCityItem> & { itemId: string }): CapacityCityItem {
  return {
    workspaceId: 'ws:1',
    workspaceName: 'Sales',
    name: 'Orders',
    kind: 'Lakehouse',
    archetype: 'Storage',
    storage: { bytes: '1000', status: 'Known', evidence },
    cuConsumed: { cuSeconds: '900', status: 'Known', evidence },
    durationSeconds: null,
    operations: {
      total: '0',
      successful: null,
      rejected: null,
      failed: null,
      invalid: null,
      cancelled: null,
    },
    distinctUsers: null,
    throttlingMinutes: null,
    performanceDeltaPercent: null,
    layout: { neighborhoodOrdinal: 0, itemOrdinal: 0 },
    sizeStatus: 'Known',
    evidence,
    ...overrides,
  }
}

function capsWith(latencySeconds: number): Pick<CapacitySourceCapabilities, 'latencySeconds'> {
  return { latencySeconds }
}

describe('refreshIntervalMs derives cadence from the source, not a hardcoded SQL-era interval', () => {
  it('floors at the 30-second timepoint cadence for a zero-latency source', () => {
    // The fixture and any always-fresh source: telemetry still only appears one 30-second timepoint
    // at a time, so nothing is gained by polling faster.
    expect(refreshIntervalMs(capsWith(0))).toBe(TIMEPOINT_SECONDS * 1000)
  })

  it('never polls faster than the source declares it runs behind', () => {
    // A source ten minutes behind live advances its landed frontier no faster than that, so the
    // cadence follows the declared latency rather than hammering it every 30 seconds.
    expect(refreshIntervalMs(capsWith(600))).toBe(600 * 1000)
  })

  it('keeps the 30-second floor when latency is below one timepoint', () => {
    expect(refreshIntervalMs(capsWith(5))).toBe(TIMEPOINT_SECONDS * 1000)
  })

  it('treats a non-finite latency as zero rather than producing a NaN interval', () => {
    expect(refreshIntervalMs(capsWith(Number.NaN))).toBe(TIMEPOINT_SECONDS * 1000)
  })
})

describe('cityLayoutSignature', () => {
  it('ignores the activity that changes on every single refresh', () => {
    // The whole point: a poll that only moved the traffic must not re-run a 16-second layout.
    const before = [item({ itemId: 'o:1' })]
    const after = [item({
      itemId: 'o:1',
      operations: { ...before[0].operations, total: '99999' },
      throttlingMinutes: 4,
      performanceDeltaPercent: -12,
      evidence: { ...evidence, observedAt: '2024-05-01T00:00:30Z' },
    })]

    expect(cityLayoutSignature(after)).toBe(cityLayoutSignature(before))
  })

  it.each([
    ['a resized building', { storage: { bytes: '2000', status: 'Known' as const, evidence } }],
    ['a building that consumed more CU', { cuConsumed: { cuSeconds: '950', status: 'Known' as const, evidence } }],
    ['a rekinded item', { kind: 'Warehouse' as const }],
    ['a moved neighbourhood', { layout: { neighborhoodOrdinal: 7, itemOrdinal: 0 } }],
    ['a renamed workspace', { workspaceName: 'Marketing' }],
  ])('still re-plans for %s', (_label, change) => {
    const before = [item({ itemId: 'o:1' })]
    const after = [item({ itemId: 'o:1', ...change })]

    expect(cityLayoutSignature(after)).not.toBe(cityLayoutSignature(before))
  })

  it('re-plans when a measurement goes missing rather than keeping the stale footprint', () => {
    // A building whose bytes vanished must re-plan onto a vacant lot, not keep the last known size.
    const before = [item({ itemId: 'o:1' })]
    const after = [item({ itemId: 'o:1', storage: { bytes: null, status: 'Unknown', evidence } })]

    expect(cityLayoutSignature(after)).not.toBe(cityLayoutSignature(before))
  })

  it('re-plans when an item arrives or leaves', () => {
    const one = [item({ itemId: 'o:1' })]
    const two = [item({ itemId: 'o:1' }), item({ itemId: 'o:2', name: 'Lines' })]

    expect(cityLayoutSignature(two)).not.toBe(cityLayoutSignature(one))
  })
})

describe('citySchemaSignature', () => {
  function workspace(overrides: Partial<CapacityCityWorkspace> = {}): CapacityCityWorkspace {
    return { workspaceId: 'ws:1', name: 'Sales', neighborhoodOrdinal: 0, itemCount: '4', evidence, ...overrides }
  }

  it('ignores evidence, which is re-dated by every refresh', () => {
    const before = [workspace()]
    const after = [workspace({ evidence: { ...evidence, observedAt: '2024-05-01T00:00:30Z' } })]

    expect(citySchemaSignature(after)).toBe(citySchemaSignature(before))
  })

  it('re-plans when a workspace gains a member', () => {
    expect(citySchemaSignature([workspace({ itemCount: '5' })])).not.toBe(citySchemaSignature([workspace()]))
  })

  it('treats an absent workspace list as its own value', () => {
    expect(citySchemaSignature(undefined)).toBe('')
    expect(citySchemaSignature([])).toBe('')
  })
})

describe('stableByContent', () => {
  it('hands back the previous value when the content matches', () => {
    const previous = [item({ itemId: 'o:1' })]
    const next = [item({ itemId: 'o:1' })]

    expect(next).not.toBe(previous)
    expect(stableByContent(previous, next, cityLayoutSignature)).toBe(previous)
  })

  it('hands back the new value when the content differs', () => {
    const previous = [item({ itemId: 'o:1' })]
    const next = [item({ itemId: 'o:1', storage: { bytes: '2000', status: 'Known', evidence } })]

    expect(stableByContent(previous, next, cityLayoutSignature)).toBe(next)
  })
})
