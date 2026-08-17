import { describe, expect, it } from 'vitest'
import {
  POLLING_DISCLOSURE,
  assertLiveIncidentResponse,
  blockingGraphSummaryLabel,
  blockingReferenceLabel,
  collectorStatusLabel,
  counterDeltaLabel,
  dataStatusLabel,
  formatKb,
  isSnapshotFresh,
  memoryGrantLabel,
  requestLabel,
  waitingTaskLabel,
} from './liveIncidents'
import type {
  BlockingReference,
  CounterDelta,
  LiveCollectorStatus,
  LiveIncidentSnapshot,
  LiveRequest,
  MemoryGrant,
  WaitingTask,
} from './liveContracts'

function noneBlocking(sessionId: number | null = null): BlockingReference {
  return { blockingSessionId: sessionId, sentinel: 'None' }
}

function baseRequest(overrides: Partial<LiveRequest> = {}): LiveRequest {
  return {
    requestId: 'r1',
    sessionId: 81,
    loginName: 'app',
    hostName: 'host',
    programName: 'prog',
    sessionStatus: 'running',
    requestStatus: 'suspended',
    command: 'SELECT',
    waitType: 'LCK_M_X',
    waitTimeMs: 1200,
    waitResource: 'KEY: 5:1',
    blocking: noneBlocking(80),
    requestStartTime: '2026-01-01T00:00:00Z',
    totalElapsedMs: 1500,
    cpuTimeMs: 30,
    reads: '10',
    writes: '2',
    logicalReads8KiBPages: '100',
    openTransactionCount: 1,
    databaseId: '5',
    databaseName: 'sales',
    currentStatementText: 'SELECT 1',
    batchText: 'SELECT 1;',
    availability: 'Available',
    availabilityReason: null,
    planState: 'NotRequested',
    planReason: null,
    ...overrides,
  }
}

function baseWaitingTask(overrides: Partial<WaitingTask> = {}): WaitingTask {
  return {
    taskId: 't1',
    sessionId: 81,
    executionContext: 'Coordinator',
    execContextId: 0,
    waitType: 'LCK_M_X',
    waitDurationMs: '1200',
    resourceDescription: 'KEY: 5:1',
    blocking: noneBlocking(80),
    ...overrides,
  }
}

function baseMemoryGrant(overrides: Partial<MemoryGrant> = {}): MemoryGrant {
  return {
    sessionId: 82,
    requestId: 1,
    schedulerId: 0,
    dop: 1,
    requestTime: '2026-01-01T00:00:00Z',
    grantTime: null,
    isWaitingForGrant: true,
    requestedKb: '2048',
    grantedKb: null,
    requiredKb: '2048',
    usedKb: null,
    maxUsedKb: null,
    idealKb: '4096',
    queryCost: 12.5,
    timeoutSec: 0,
    waitTimeMs: '500',
    batchText: 'SELECT 2;',
    ...overrides,
  }
}

function baseSnapshot(overrides: Partial<LiveIncidentSnapshot> = {}): LiveIncidentSnapshot {
  return {
    schemaVersion: '1.0',
    target: { targetId: 't', displayName: 'Test', platform: 'SqlServerOnPremises', visibilityScope: 'Server', unavailableServerWideEvidenceReason: null },
    sourceTimestamp: '2026-01-01T00:00:00Z',
    collectedAt: '2026-01-01T00:00:00Z',
    freshUntil: '2026-01-01T00:00:05Z',
    status: 'Available',
    reason: 'ok',
    requests: [],
    waitingTasks: [],
    blockingGraph: {
      nodes: [],
      edges: [],
      rootNodeIds: [],
      cycles: [],
      summary: { blockedSessionCount: 0, rootBlockerCount: 0, sentinelRootCount: 0, cycleCount: 0, parallelWaitTaskCount: 0, note: 'no blocking observed' },
    },
    memoryGrants: [],
    tempdb: { files: [], sessions: [], tasks: [], status: 'Available', reason: 'ok' },
    fileIo: { files: [], status: 'Available', reason: 'ok' },
    scheduler: { schedulers: [], status: 'Available', reason: 'ok' },
    logSpace: { totalLogSizeMb: null, usedLogSpaceMb: null, usedLogSpacePercent: null, status: 'Available', reason: 'ok' },
    diagnostics: { sequence: 1, collectedAt: '2026-01-01T00:00:00Z', sourceTimestamp: '2026-01-01T00:00:00Z', durationMs: 5, missedCycles: 0, skippedCycles: 0, unavailableFields: [] },
    ...overrides,
  }
}

function baseCollectorStatus(overrides: Partial<LiveCollectorStatus> = {}): LiveCollectorStatus {
  return {
    state: 'Running',
    sequence: 1,
    lastSuccessAt: '2026-01-01T00:00:00Z',
    lastAttemptAt: '2026-01-01T00:00:00Z',
    consecutiveFailures: 0,
    nextAttemptInMs: null,
    lastErrorReason: null,
    missedCycles: 0,
    skippedCycles: 0,
    ...overrides,
  }
}

describe('blocking sentinel semantics', () => {
  it('names an ordinary blocker by session id', () => {
    expect(blockingReferenceLabel(noneBlocking(80))).toBe('blocked by session 80')
  })

  it('reports "not blocked" for null or zero, never a fabricated blocker', () => {
    expect(blockingReferenceLabel(noneBlocking(null))).toBe('not blocked')
    expect(blockingReferenceLabel(noneBlocking(0))).toBe('not blocked')
  })

  it('preserves all four negative sentinel meanings distinctly', () => {
    expect(blockingReferenceLabel({ blockingSessionId: -2, sentinel: 'OrphanedDistributedTransaction' })).toContain('orphaned distributed transaction (-2)')
    expect(blockingReferenceLabel({ blockingSessionId: -3, sentinel: 'DeferredRecoveryTransaction' })).toContain('deferred recovery transaction (-3)')
    expect(blockingReferenceLabel({ blockingSessionId: -4, sentinel: 'IndeterminateLatchOwner' })).toContain('indeterminate latch owner (-4)')
  })

  it('never describes -5 (untracked latch owner) as a blocking problem by itself', () => {
    const label = blockingReferenceLabel({ blockingSessionId: -5, sentinel: 'UntrackedLatchOwner' })
    expect(label).toContain('untracked latch owner (-5)')
    expect(label).toContain('commonly benign')
    expect(label).toContain('not necessarily a blocking problem')
  })
})

describe('requirement 8: accessible, exact-value labels', () => {
  it('never claims complete query capture; it explicitly disclaims completeness', () => {
    expect(POLLING_DISCLOSURE).toContain('not a complete record')
    expect(POLLING_DISCLOSURE).toContain('may never appear')
  })

  it('discloses a disappeared request rather than omitting it silently', () => {
    const label = requestLabel(baseRequest({ availability: 'Disappeared', availabilityReason: 'completed or was killed' }))
    expect(label).toContain('Session 81')
    expect(label).toContain('disappeared between samples')
    expect(label).toContain('completed or was killed')
  })

  it('exposes the exact wait type and duration for a request, and its blocker', () => {
    const label = requestLabel(baseRequest())
    expect(label).toContain('LCK_M_X')
    expect(label).toContain('1200 ms')
    expect(label).toContain('blocked by session 80')
  })

  it('labels every parallel worker wait individually with its exec_context_id, never as a bare coordinator wait', () => {
    const worker = waitingTaskLabel(baseWaitingTask({ executionContext: 'Worker', execContextId: 3, sessionId: 90 }))
    expect(worker).toContain('parallel worker')
    expect(worker).toContain('exec_context_id 3')
    expect(worker).toContain('Session 90')

    const coordinator = waitingTaskLabel(baseWaitingTask({ executionContext: 'Coordinator' }))
    expect(coordinator).toContain('coordinator')
    expect(coordinator).not.toContain('exec_context_id')
  })

  it('labels a memory grant waiting on grant_time IS NULL as waiting, with exact requested KB', () => {
    const waiting = memoryGrantLabel(baseMemoryGrant({ requestedKb: '512' }))
    expect(waiting).toContain('waiting for a memory grant')
    expect(waiting).toContain('500 ms')
    expect(waiting).toContain('512 KiB')

    const satisfied = memoryGrantLabel(baseMemoryGrant({ isWaitingForGrant: false, grantTime: '2026-01-01T00:00:01Z' }))
    expect(satisfied).toContain('grant satisfied')
  })

  it('formats KiB values losslessly, including above Number.MAX_SAFE_INTEGER', () => {
    expect(formatKb('512')).toBe('512 KiB')
    expect(formatKb(null)).toBe('Unavailable')
    expect(formatKb('9007199254740993')).toMatch(/MiB$/)
  })

  it('summarizes the blocking graph without ever substituting for the per-task detail', () => {
    const snapshot = baseSnapshot({
      blockingGraph: {
        nodes: [
          { nodeId: 's80', kind: 'Session', sessionId: 80, sentinel: 'None', isRoot: true, isIdleWithOpenTransaction: true, inCycle: false, directlyBlockedCount: 2 },
        ],
        edges: [],
        rootNodeIds: ['s80'],
        cycles: [],
        summary: { blockedSessionCount: 2, rootBlockerCount: 1, sentinelRootCount: 0, cycleCount: 0, parallelWaitTaskCount: 3, note: 'one idle root blocking two sessions' },
      },
    })
    const label = blockingGraphSummaryLabel(snapshot)
    expect(label).toContain('2 blocked session(s)')
    expect(label).toContain('1 root blocker(s)')
    expect(label).toContain('3 parallel wait task(s)')
    expect(label).toContain('one idle root blocking two sessions')
  })

  it('reports cycle counts explicitly when present', () => {
    const snapshot = baseSnapshot({
      blockingGraph: {
        nodes: [],
        edges: [],
        rootNodeIds: [],
        cycles: [['s1', 's2']],
        summary: { blockedSessionCount: 2, rootBlockerCount: 0, sentinelRootCount: 0, cycleCount: 1, parallelWaitTaskCount: 2, note: 'mutual blocking cycle' },
      },
    })
    expect(blockingGraphSummaryLabel(snapshot)).toContain('1 cycle(s) detected');
  })
})

describe('requirement 5/6: counter delta and status text', () => {
  const delta = (overrides: Partial<CounterDelta> = {}): CounterDelta => ({
    state: 'Delta',
    deltaValue: '100',
    ratePerSecond: 33.3,
    reason: 'ok',
    ...overrides,
  })

  it('reports "no rate yet" for a first sample, never a fabricated rate', () => {
    expect(counterDeltaLabel(delta({ state: 'FirstSample', ratePerSecond: null }), 'reads')).toBe('first sample — no rate yet')
  })

  it('reports an epoch reset explicitly rather than a fake negative/zero rate', () => {
    const label = counterDeltaLabel(delta({ state: 'EpochReset', ratePerSecond: null, reason: 'counter regression detected' }), 'reads')
    expect(label).toContain('epoch reset')
    expect(label).toContain('counter regression detected')
  })

  it('reports the exact rate for a valid delta', () => {
    expect(counterDeltaLabel(delta(), 'reads')).toBe('33.3 reads/s')
  })

  it('splits and lowercases PascalCase data status values for prose', () => {
    expect(dataStatusLabel('PermissionDenied')).toBe('permission denied')
    expect(dataStatusLabel('Disconnected')).toBe('disconnected')
  })
})

describe('freshness and collector status', () => {
  it('is fresh only when Available and within freshUntil', () => {
    const snapshot = baseSnapshot()
    expect(isSnapshotFresh(snapshot, '2026-01-01T00:00:04Z')).toBe(true)
    expect(isSnapshotFresh(snapshot, '2026-01-01T00:00:06Z')).toBe(false)
    expect(isSnapshotFresh({ ...snapshot, status: 'Stale' }, '2026-01-01T00:00:01Z')).toBe(false)
  })

  it('surfaces reconnect/backoff state and reason distinctly from ordinary running', () => {
    const running = collectorStatusLabel(baseCollectorStatus())
    expect(running).toContain('running')

    const reconnecting = collectorStatusLabel(baseCollectorStatus({
      state: 'Reconnecting',
      consecutiveFailures: 2,
      lastErrorReason: 'connection timeout',
      nextAttemptInMs: 4000,
    }))
    expect(reconnecting).toContain('reconnecting after an error')
    expect(reconnecting).toContain('connection timeout')
    expect(reconnecting).toContain('4s')
  })

  it('surfaces missed/skipped cycle counts when nonzero', () => {
    const label = collectorStatusLabel(baseCollectorStatus({ missedCycles: 3, skippedCycles: 1 }))
    expect(label).toContain('Missed 3, skipped 1')
  })
})

describe('response validation and source labeling', () => {
  it('accepts a well-formed response with a null snapshot (no cycle completed yet)', () => {
    const response = { snapshot: null, collector: baseCollectorStatus() }
    expect(assertLiveIncidentResponse(response)).toEqual(response)
  })

  it('accepts a well-formed response with schema version 1.0', () => {
    const response = { snapshot: baseSnapshot(), collector: baseCollectorStatus() }
    expect(assertLiveIncidentResponse(response).snapshot?.schemaVersion).toBe('1.0')
  })

  it('rejects a response missing collector status', () => {
    expect(() => assertLiveIncidentResponse({ snapshot: null })).toThrow()
  })

  it('rejects a snapshot with the wrong schema version', () => {
    const response = { snapshot: baseSnapshot({ schemaVersion: '2.0' }), collector: baseCollectorStatus() }
    expect(() => assertLiveIncidentResponse(response)).toThrow()
  })

  it('rejects a non-object payload', () => {
    expect(() => assertLiveIncidentResponse(null)).toThrow()
    expect(() => assertLiveIncidentResponse('not an object')).toThrow()
  })
})
