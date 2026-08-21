/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { accessibleObjectLabel, directActivityWidth, shouldAnimateCurrentMarkers, shouldRenderRoute } from './databaseCity'
import type { DatabaseCityObject, DatabaseCityRoute } from './databaseCityContracts'

const object: DatabaseCityObject = {
  objectId: 'object:customer',
  schemaId: 'schema:crm',
  schemaName: 'crm',
  name: 'Customer',
  kind: 'Table',
  reservedPages8KiB: '12',
  usedPages8KiB: '8',
  reservedBytes: '98304',
  usedBytes: '65536',
  sizeStatus: 'Known',
  sizeReason: null,
  layout: { neighborhoodOrdinal: 0, objectOrdinal: 2, x: 28, z: 12 },
  indexes: [{
    indexId: 'index:customer:2',
    name: 'IX_Customer_Email',
    kind: 'Nonclustered',
    directActivity: {
      totalOperations: '9',
      resetEpochToken: 'epoch:1',
      evidence: {
        source: 'LiveDmvCumulative',
        status: 'Available',
        observedAt: '2026-08-17T17:00:00Z',
        freshUntil: '2026-08-17T17:05:00Z',
        reason: 'Direct cumulative index DMV counters.',
      },
    },
  }],
  directActivity: {
    totalOperations: '9',
    resetEpochToken: 'epoch:1',
    evidence: {
      source: 'LiveDmvCumulative',
      status: 'Available',
      observedAt: '2026-08-17T17:00:00Z',
      freshUntil: '2026-08-17T17:05:00Z',
      reason: 'Direct cumulative index DMV counters.',
    },
  },
  attributedExposure: {
    executionCount: '3',
    totalCpuMicroseconds: '120',
    totalDurationMicroseconds: '200',
    totalLogicalReads8KiBPages: '44',
    confidence: 'Confirmed',
    rationale: 'Normalized compiled plans name only this object.',
    evidence: {
      source: 'QueryStoreAggregate',
      status: 'Available',
      observedAt: '2026-08-17T17:00:00Z',
      freshUntil: null,
      reason: 'Aggregate historical exposure.',
    },
  },
}

describe('database city accessibility and motion', () => {
  it('labels object kind, exact size, attached indexes, both evidence styles, and source caveats', () => {
    const label = accessibleObjectLabel(object)
    expect(label).toContain('crm.Customer, Table')
    expect(label).toContain('96 KiB reserved')
    expect(label).toContain('1 attached index')
    expect(label).toContain('direct DMV activity 9 operations')
    expect(label).toContain('attributed Query Store exposure 120 CPU microseconds')
    expect(label).toContain('Normalized compiled plans name only this object')
  })

  it('never animates historical load and respects reduced motion for fresh current samples', () => {
    expect(shouldAnimateCurrentMarkers('QueryStoreAggregate', true, false)).toBe(false)
    expect(shouldAnimateCurrentMarkers('LiveDmvSample', true, true)).toBe(false)
    expect(shouldAnimateCurrentMarkers('LiveDmvSample', true, false)).toBe(true)
    expect(shouldAnimateCurrentMarkers('LiveDmvSample', false, false)).toBe(false)
  })

  it('keeps unavailable direct activity nonquantitative and distinct from measured zero', () => {
    expect(directActivityWidth(null)).toBeNull()
    expect(directActivityWidth('0')).toBe(3)
    expect(directActivityWidth('9')).toBeGreaterThan(3)
  })

  it('does not invent endpoints for filtered or unpaged local objects', () => {
    const route = {
      kind: 'ObjectReference',
      fromObjectId: 'object:customer',
      toId: 'object:orders',
    } as DatabaseCityRoute
    const visibleIds = new Set(['object:customer'])

    expect(shouldRenderRoute(route, visibleIds)).toBe(false)
    expect(shouldRenderRoute({ ...route, kind: 'CrossDatabaseReference' }, visibleIds)).toBe(true)
  })

  it('keeps the evidence qualification wrapped and visible on mobile', () => {
    const css = readFileSync(new URL('./App.css', import.meta.url), 'utf8')
    const mobile = css.slice(css.indexOf('@media (max-width: 860px)'))

    // The evidence prose lives in the sidebar drawer now. Narrow screens may shrink it and wrap it,
    // but must never hide it: the map's claims are only honest while their qualifications are legible.
    expect(mobile).toMatch(/\.mapping-note\s*\{[^}]*overflow-wrap:\s*anywhere/)
    expect(mobile).toMatch(/\.sidebar-drawer > summary\s*\{[^}]*display:\s*block/)
    expect(mobile).not.toMatch(/\.sidebar-drawer[^}]*display:\s*none/)
    expect(mobile).not.toMatch(/\.mapping-note[^}]*display:\s*none/)
  })
})
