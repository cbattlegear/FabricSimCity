/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { accessibleObjectLabel, attributedAbsenceLabel, databaseCitySharedMetricValue, directActivityWidth, shouldAnimateCurrentMarkers, shouldRenderRoute } from './capacityCity'
import type { CapacityCityItem, CapacityCityRoute } from '../capacityCityContracts'

const object: CapacityCityItem = {
  itemId: 'object:customer',
  workspaceId: 'schema:crm',
  workspaceName: 'crm',
  name: 'Customer',
  kind: 'Table',
  storageBytes: '12',
  cuSecondsRaw: '8',
  reservedBytes: '98304',
  usedBytes: '65536',
  sizeStatus: 'Known',
  sizeReason: null,
  layout: { neighborhoodOrdinal: 0, itemOrdinal: 2, x: 28, z: 12 },
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
      fromItemId: 'object:customer',
      toId: 'object:orders',
    } as CapacityCityRoute
    const visibleIds = new Set(['object:customer'])

    expect(shouldRenderRoute(route, visibleIds)).toBe(false)
    expect(shouldRenderRoute({ ...route, kind: 'CrossDatabaseReference' }, visibleIds)).toBe(true)
  })

  it('reports shared query totals separately and never as this object\'s own measurement', () => {
    // Absent shared exposure must stay absent. A missing figure is not a zero.
    expect(databaseCitySharedMetricValue(object, 'cpu')).toBeNull()

    const joined: CapacityCityItem = {
      ...object,
      attributedExposure: {
        ...object.attributedExposure,
        executionCount: null,
        totalCpuMicroseconds: null,
        totalDurationMicroseconds: null,
        totalLogicalReads8KiBPages: null,
        confidence: 'Unknown',
        rationale: 'No ranked family names this object on its own.',
        shared: {
          familyCount: '2',
          executionCount: '9',
          totalCpuMicroseconds: '900',
          totalDurationMicroseconds: '1200',
          totalLogicalReads8KiBPages: '300',
          rationale: 'Totals belong to queries naming several objects and must not be summed across buildings.',
        },
      },
    }

    expect(databaseCitySharedMetricValue(joined, 'cpu')).toBe('900')
    // The attributed figure stays unavailable: shared totals must never be promoted into it.
    expect(joined.attributedExposure.totalCpuMicroseconds).toBeNull()

    const label = accessibleObjectLabel(joined)
    // A probe that ran fine but attributed nothing is "not attributed", not "unavailable": the
    // Query Store data was there, it simply never named this object on its own.
    expect(label).toContain('attributed Query Store exposure not attributed')
    expect(attributedAbsenceLabel(joined)).toBe('Not attributed')
    // The other absence must keep its own word: a probe that could not run still reports why.
    expect(attributedAbsenceLabel({
      ...joined,
      attributedExposure: {
        ...joined.attributedExposure,
        evidence: { ...joined.attributedExposure.evidence, status: 'PermissionDenied' },
      },
    })).toBe('PermissionDenied')
    expect(label).toContain('Shared with other objects: 900 CPU microseconds across 2 joined query families')
    expect(label).toContain('not additive across buildings')
  })

  it('shows shared exposure in the panel, the table, and the legend', () => {
    const view = readFileSync(new URL('./CapacityCityView.tsx', import.meta.url), 'utf8')
    const viewport = readFileSync(new URL('./CapacityCityViewport.tsx', import.meta.url), 'utf8')

    // The shared rationale is the sentence that stops the figure being read as this object's own.
    expect(view).toContain('object.attributedExposure.shared.rationale')
    expect(view).toContain('databaseCitySharedMetricValue')
    // The legend must distinguish the outlined cap from the solid one, or the map asserts a total it
    // never measured for one building.
    expect(viewport).toContain('Outlined amber cap')
    expect(viewport).toContain('not additive across buildings')
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
