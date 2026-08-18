import { describe, expect, it } from 'vitest'
import {
  FINDINGS_DISCLOSURE,
  TRUSTED_NETWORK_DISCLOSURE,
  assertFindingsEngineStatus,
  assertFindingsPage,
  confidenceGlyph,
  countBySeverity,
  formatImpact,
  loadPresentation,
  savePresentation,
  severityGlyph,
  severityRank,
  togglePresentation,
} from './findings'
import type { PresentationStore } from './findings'
import type { Finding, FindingSeverity, MeasuredImpact } from './findingsContracts'

function impact(overrides: Partial<MeasuredImpact>): MeasuredImpact {
  return { dimension: 'DurationMicroseconds', magnitude: '1000', unit: 'µs', basis: 'test', ...overrides }
}

function finding(severity: FindingSeverity, id = 'f1'): Finding {
  return {
    schemaVersion: '1.0', findingId: id, ruleId: 'r', ruleVersion: '1', title: 't',
    scope: { targetId: 't', databaseId: null, queryFamilyId: null, planId: null, displayName: 'd' },
    observedWindow: { start: null, end: null, kind: 'k', caveat: 'c' },
    status: 'Firing', severity, impact: impact({}), confidence: 'High',
    evidence: [], caveats: [], alternateExplanations: [], recommendedNextChecks: [],
    readOnlyRecommendation: 'r',
    sourceFreshness: { source: 'QueryStoreAggregate', status: 'Available', observedAt: null, freshUntil: null, reason: 'r' },
  }
}

class FakeStore implements PresentationStore {
  private readonly map = new Map<string, string>()
  getItem(key: string): string | null { return this.map.get(key) ?? null }
  setItem(key: string, value: string): void { this.map.set(key, value) }
}

describe('severity and confidence are color-independent', () => {
  it('encodes severity ordering with distinct glyphs', () => {
    expect(severityRank('Serious')).toBeGreaterThan(severityRank('Advisory'))
    const glyphs = new Set(['Serious', 'Notable', 'Advisory', 'Informational'].map(s => severityGlyph(s as FindingSeverity)))
    expect(glyphs.size).toBe(4)
  })

  it('encodes confidence with distinct glyphs', () => {
    const glyphs = new Set(['High', 'Medium', 'Low'].map(c => confidenceGlyph(c as 'High' | 'Medium' | 'Low')))
    expect(glyphs.size).toBe(3)
  })
})

describe('formatImpact', () => {
  it('formats a share as a percentage', () => {
    expect(formatImpact(impact({ dimension: 'AbortedExecutionShare', magnitude: '0.4' }))).toContain('40.0%')
  })

  it('never shows a fabricated zero for a null magnitude', () => {
    expect(formatImpact(impact({ dimension: 'None', magnitude: null }))).toContain('Qualitative')
  })

  it('groups large decimal-string magnitudes without precision loss', () => {
    expect(formatImpact(impact({ dimension: 'CpuMicroseconds', magnitude: '2089500' }))).toContain('2,089,500')
  })
})

describe('countBySeverity', () => {
  it('counts each severity', () => {
    const counts = countBySeverity([finding('Serious', 'a'), finding('Serious', 'b'), finding('Advisory', 'c')])
    expect(counts.Serious).toBe(2)
    expect(counts.Advisory).toBe(1)
    expect(counts.Notable).toBe(0)
  })
})

describe('assertions', () => {
  it('accepts a valid page and rejects a bad schema', () => {
    expect(() => assertFindingsPage({ schemaVersion: '1.0', items: [] })).not.toThrow()
    expect(() => assertFindingsPage({ schemaVersion: '2.0', items: [] })).toThrow()
    expect(() => assertFindingsPage(null)).toThrow()
  })

  it('accepts a valid engine status and rejects a bad one', () => {
    expect(() => assertFindingsEngineStatus({ schemaVersion: '1.0', rules: [] })).not.toThrow()
    expect(() => assertFindingsEngineStatus({ schemaVersion: '1.0' })).toThrow()
  })
})

describe('local presentation state', () => {
  it('toggles and persists acknowledgment and suppression keyed by finding id', () => {
    const store = new FakeStore()
    let state = loadPresentation(store)
    expect(state.suppressed.has('f1')).toBe(false)

    state = togglePresentation(state, 'suppressed', 'f1')
    state = togglePresentation(state, 'acknowledged', 'f2')
    savePresentation(store, state)

    const reloaded = loadPresentation(store)
    expect(reloaded.suppressed.has('f1')).toBe(true)
    expect(reloaded.acknowledged.has('f2')).toBe(true)

    const untoggled = togglePresentation(reloaded, 'suppressed', 'f1')
    expect(untoggled.suppressed.has('f1')).toBe(false)
  })

  it('falls back to an empty clean state on a corrupt or foreign value', () => {
    const store = new FakeStore()
    store.setItem('sqlsimcity.findings.presentation.v1', '{ not valid json')
    const state = loadPresentation(store)
    expect(state.suppressed.size).toBe(0)
    expect(state.acknowledged.size).toBe(0)
  })

  it('ignores a mismatched stored version', () => {
    const store = new FakeStore()
    store.setItem('sqlsimcity.findings.presentation.v1', JSON.stringify({ version: 99, suppressed: ['x'], acknowledged: [] }))
    expect(loadPresentation(store).suppressed.size).toBe(0)
  })
})

describe('disclosures', () => {
  it('states the evidence-first and trusted-network posture', () => {
    expect(FINDINGS_DISCLOSURE).toContain('evidence-backed')
    expect(TRUSTED_NETWORK_DISCLOSURE).toContain('trusted network')
  })
})
