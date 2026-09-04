import { describe, expect, it } from 'vitest'
import {
  delayIncidentCount,
  incidentDemandsAttention,
  incidentEvidenceState,
  incidentSeverityRank,
  incidentSummaryLabel,
  incidentSummaryTone,
  isRejectionSeverity,
  projectIncidents,
  rejectionIncidentCount,
  severityForStage,
  stopsTraffic,
  type IncidentProjectionInput,
} from './cityIncidents'
import { evidence, family, item } from './operationTraffic.testkit'
import type { ItemOperationCounts, OperationClass, OperationSample } from './capacityCityContracts'
import type { Evidence, ThrottleState } from './fabricContracts'

const items = [item('item:a', 'ws:1', 0, 0), item('item:b', 'ws:1', 0, 1)]

function throttle(overrides: Partial<ThrottleState> = {}): ThrottleState {
  return {
    stage: 'None',
    interactiveDelayPercent: null,
    interactiveRejectionPercent: null,
    backgroundRejectionPercent: null,
    cumulativeCarryOverPercent: null,
    expectedBurndownMinutes: null,
    surgeProtectionActive: false,
    evidence,
    ...overrides,
  }
}

const DELAY = throttle({ stage: 'InteractiveDelay', interactiveDelayPercent: 150 })
const INTERACTIVE_REJECTING = throttle({
  stage: 'InteractiveRejection',
  interactiveDelayPercent: 150,
  interactiveRejectionPercent: 150,
  cumulativeCarryOverPercent: 42,
  expectedBurndownMinutes: 30,
})
const BACKGROUND_REJECTING = throttle({
  stage: 'BackgroundRejection',
  interactiveDelayPercent: 150,
  interactiveRejectionPercent: 150,
  backgroundRejectionPercent: 150,
})

function counts(rejected: string | null): ItemOperationCounts {
  return { total: '10', successful: '7', rejected, failed: null, invalid: null, cancelled: null }
}

function rejectedSample(itemId: string, operationClass: OperationClass = 'Interactive', id = 'op'): OperationSample {
  return {
    operationId: `${id}:${itemId}`,
    operationName: 'Warehouse Query',
    itemId,
    workspaceId: 'ws:1',
    operationClass,
    billingType: 'Billable',
    status: 'Rejected',
    startedAt: '2024-01-01T00:00:00Z',
    endedAt: null,
    durationSeconds: null,
    totalCuSeconds: null,
    timepointCuSeconds: null,
    throttlingSeconds: null,
    smoothingStart: null,
    smoothingEnd: null,
    user: null,
  }
}

function input(overrides: Partial<IncidentProjectionInput> = {}): IncidentProjectionInput {
  return {
    families: [],
    items,
    samples: null,
    throttle: throttle(),
    capabilities: { operationFamilies: true, operationSamples: true },
    observedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('projectIncidents · an incident pins to the item whose operations drove the overload', () => {
  it('pins one marker to the driven item, naming its stage and gate', () => {
    const projection = projectIncidents(input({
      families: [family({ itemId: 'item:a', counts: counts('3') })],
      throttle: INTERACTIVE_REJECTING,
    }))
    expect(projection.markers).toHaveLength(1)
    expect(projection.markers[0]).toMatchObject({
      itemId: 'item:a',
      severity: 'interactiveRejection',
      stage: 'InteractiveRejection',
      facility: 'interactiveRejectionGate',
    })
    expect(projection.markers[0].headline).toContain('item:a')
  })

  it('names the responsible operations and the carry-forward debt in the details', () => {
    const projection = projectIncidents(input({
      families: [family({ itemId: 'item:a', operationName: 'Semantic model refresh', counts: counts('3') })],
      throttle: INTERACTIVE_REJECTING,
    }))
    const details = projection.markers[0].details.join('\n')
    expect(details).toContain('Operations responsible: Semantic model refresh')
    expect(details).toContain('Carry-forward debt 42.0%')
  })

  it('offers the road between the driven item and a counterpart the operation also touched', () => {
    const projection = projectIncidents(input({
      families: [family({ itemId: 'item:a', itemIds: ['item:a', 'item:b'], counts: counts('3') })],
      throttle: INTERACTIVE_REJECTING,
    }))
    expect(projection.markers[0].counterpartObjectIds).toEqual(['item:b'])
  })

  it('escalates to background rejection when the 24-hour gate is over the line', () => {
    const projection = projectIncidents(input({
      families: [family({ itemId: 'item:a', operationClass: 'Background', counts: counts('2') })],
      throttle: BACKGROUND_REJECTING,
    }))
    expect(projection.markers[0]).toMatchObject({ severity: 'backgroundRejection', facility: 'backgroundRejectionGate' })
  })
})

describe('projectIncidents · the delay/rejection severity ladder must not collapse', () => {
  it('ranks a delay strictly below both rejection stages', () => {
    expect(incidentSeverityRank('delay')).toBeLessThan(incidentSeverityRank('interactiveRejection'))
    expect(incidentSeverityRank('interactiveRejection')).toBeLessThan(incidentSeverityRank('backgroundRejection'))
  })

  it('stops traffic at a rejection but never at a mere delay', () => {
    expect(stopsTraffic({ severity: 'delay' })).toBe(false)
    expect(stopsTraffic({ severity: 'interactiveRejection' })).toBe(true)
    expect(stopsTraffic({ severity: 'backgroundRejection' })).toBe(true)
    expect(isRejectionSeverity('delay')).toBe(false)
  })

  it('draws an interactive delay as busy, not as a rejection incident', () => {
    // An interactive delay adds ~20s to a request: a busy capacity, not a broken one. Promoting it
    // to a rejection here would cry wolf and park cars at a gate that only queues them.
    const projection = projectIncidents(input({
      families: [family({ itemId: 'item:a' })],
      throttle: DELAY,
    }))
    expect(projection.markers[0].severity).toBe('delay')
    expect(rejectionIncidentCount(projection)).toBe(0)
    expect(delayIncidentCount(projection)).toBe(1)
    expect(stopsTraffic(projection.markers[0])).toBe(false)
  })

  it('maps each throttle stage onto its severity', () => {
    expect(severityForStage('InteractiveDelay')).toBe('delay')
    expect(severityForStage('InteractiveRejection')).toBe('interactiveRejection')
    expect(severityForStage('BackgroundRejection')).toBe('backgroundRejection')
  })
})

describe('projectIncidents · an absence of evidence is "not observed", not "all clear"', () => {
  it('reads an unmeasured throttle gauge as not observed rather than as no throttling', () => {
    // A paused capacity emits no gauges. Reading its null gauges as "No throttling" is exactly the
    // clean bill of health the codebase refuses to invent from an absence of measurement.
    const unmeasured: Evidence = { ...evidence, status: 'Unknown' }
    const projection = projectIncidents(input({ throttle: throttle({ evidence: unmeasured }) }))
    expect(projection.evidence).toBe('unsupported')
    expect(incidentSummaryLabel(projection)).toBe('Not observed')
    expect(incidentSummaryLabel(projection)).not.toBe('No throttling')
    expect(incidentSummaryTone(projection)).toBe('is-unknown')
    expect(incidentDemandsAttention(projection)).toBe(true)
  })

  it('reads a source that can report neither families nor samples as not observed', () => {
    const projection = projectIncidents(input({
      capabilities: { operationFamilies: false, operationSamples: false },
    }))
    expect(projection.evidence).toBe('unsupported')
    expect(incidentSummaryLabel(projection)).toBe('Not observed')
  })

  it('reads a readable, quiet capacity as genuinely no throttling', () => {
    const projection = projectIncidents(input({ throttle: throttle({ stage: 'None' }) }))
    expect(projection.evidence).toBe('none')
    expect(incidentSummaryLabel(projection)).toBe('No throttling')
  })

  it('proves the direct helper distinguishes the three states', () => {
    expect(incidentEvidenceState({ operationFamilies: true, operationSamples: true }, throttle(), 1, 'none')).toBe('measured')
    expect(incidentEvidenceState({ operationFamilies: true, operationSamples: true }, throttle({ evidence: { ...evidence, status: 'Unknown' } }), 0, 'none')).toBe('unsupported')
    expect(incidentEvidenceState({ operationFamilies: false, operationSamples: false }, throttle(), 0, 'none')).toBe('unsupported')
    expect(incidentEvidenceState({ operationFamilies: true, operationSamples: true }, throttle(), 0, 'measured')).toBe('measured')
    expect(incidentEvidenceState({ operationFamilies: true, operationSamples: true }, throttle(), 0, 'none')).toBe('none')
  })
})

describe('projectIncidents · live rejections corroborate or stand up their own pin', () => {
  it('stands up a marker for a live rejection the retained window has not attributed', () => {
    const projection = projectIncidents(input({
      families: [],
      throttle: INTERACTIVE_REJECTING,
      samples: [rejectedSample('item:a')],
    }))
    expect(projection.markers).toHaveLength(1)
    expect(projection.markers[0]).toMatchObject({ itemId: 'item:a', throttlingSeconds: 0, liveRejections: 1 })
    expect(projection.markers[0].details.join('\n')).toContain('rejected in the latest live sample')
  })

  it('corroborates a retained marker with the live count instead of drawing a second pin', () => {
    const projection = projectIncidents(input({
      families: [family({ itemId: 'item:a', counts: counts('3') })],
      throttle: INTERACTIVE_REJECTING,
      samples: [rejectedSample('item:a')],
    }))
    expect(projection.markers).toHaveLength(1)
    expect(projection.markers[0]).toMatchObject({ liveRejections: 1 })
    expect(projection.markers[0].throttlingSeconds).toBeGreaterThan(0)
  })

  it('counts an off-page live rejection without pinning it, and still calls the layer measured', () => {
    const projection = projectIncidents(input({
      throttle: throttle({ stage: 'None' }),
      samples: [rejectedSample('item:offscreen')],
    }))
    expect(projection.markers).toHaveLength(0)
    expect(projection.offPageRejectionCount).toBe(1)
    expect(projection.evidence).toBe('measured')
    expect(incidentSummaryLabel(projection)).toBe('Overload off-map')
  })

  it('keeps an unclassed live rejection apart from any gate', () => {
    const projection = projectIncidents(input({
      throttle: throttle({ stage: 'None' }),
      samples: [rejectedSample('item:a', 'Unknown')],
    }))
    expect(projection.markers).toHaveLength(0)
    expect(projection.unclassedRejectionCount).toBe(1)
  })
})

describe('projectIncidents · folded summary', () => {
  it('counts pinned incidents and flags a rejection as an alert', () => {
    const projection = projectIncidents(input({
      families: [family({ itemId: 'item:a', counts: counts('3') })],
      throttle: INTERACTIVE_REJECTING,
    }))
    expect(incidentSummaryLabel(projection)).toBe('1 throttling incident')
    expect(incidentSummaryTone(projection)).toBe('is-alert')
  })

  it('surfaces measured overload that could not be pinned as off-map rather than clear', () => {
    const projection = projectIncidents(input({
      families: [family({ itemId: 'item:offscreen', counts: counts('3') })],
      throttle: INTERACTIVE_REJECTING,
    }))
    expect(projection.markers).toHaveLength(0)
    expect(projection.unattributedSeconds).toBeGreaterThan(0)
    expect(incidentSummaryLabel(projection)).toBe('Overload off-map')
    expect(incidentSummaryTone(projection)).toBe('is-unknown')
  })
})
