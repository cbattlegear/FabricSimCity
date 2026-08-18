import { describe, expect, it } from 'vitest'
import type {
  BlockingGraph,
  CounterDelta,
  FileIoDelta,
  LiveIncidentSnapshot,
  MemoryGrant,
  SchedulerSample,
  TempdbFileUsage,
} from './liveContracts'
import { FACILITY_ORDER, projectFacilities } from './cityInfrastructure'

function delta(overrides: Partial<CounterDelta> = {}): CounterDelta {
  return { state: 'Delta', deltaValue: '0', ratePerSecond: 0, reason: 'ok', ...overrides }
}

function scheduler(overrides: Partial<SchedulerSample> & { schedulerId: number }): SchedulerSample {
  return {
    cpuId: overrides.schedulerId,
    status: 'VISIBLE ONLINE',
    isOnline: true,
    isIdle: false,
    currentTasksCount: 0,
    runnableTasksCount: 0,
    currentWorkersCount: 1,
    activeWorkersCount: 1,
    workQueueCount: 0,
    pendingDiskIoCount: 0,
    loadFactor: 1,
    epochId: 1,
    sampleWindowMs: 1000,
    cpuUsageMsDelta: delta(),
    schedulerDelayMsDelta: delta(),
    idealWorkersLimit: null,
    ...overrides,
  }
}

function grant(overrides: Partial<MemoryGrant> & { sessionId: number }): MemoryGrant {
  return {
    requestId: 0,
    schedulerId: 0,
    dop: 1,
    requestTime: null,
    grantTime: null,
    isWaitingForGrant: false,
    requestedKb: '1024',
    grantedKb: '1024',
    requiredKb: '512',
    usedKb: '256',
    maxUsedKb: '256',
    idealKb: '1024',
    queryCost: 1,
    timeoutSec: 60,
    waitTimeMs: '0',
    batchText: null,
    ...overrides,
  }
}

function ioFile(overrides: Partial<FileIoDelta> & { fileId: number }): FileIoDelta {
  return {
    databaseId: 5,
    databaseName: 'sales',
    typeDesc: 'ROWS',
    epochId: 1,
    sampleWindowMs: 1000,
    readsDelta: delta(),
    bytesReadDelta: delta({ ratePerSecond: 1024 }),
    ioStallReadMsDelta: delta(),
    writesDelta: delta(),
    bytesWrittenDelta: delta({ ratePerSecond: 512 }),
    ioStallWriteMsDelta: delta(),
    ...overrides,
  }
}

function tempdbFile(overrides: Partial<TempdbFileUsage> & { fileId: number }): TempdbFileUsage {
  return {
    totalMb: 100,
    allocatedMb: 10,
    freeMb: 90,
    versionStoreMb: 1,
    userObjectsMb: 4,
    internalObjectsMb: 5,
    mixedExtentMb: 0,
    ...overrides,
  }
}

const emptyBlockingGraph: BlockingGraph = {
  nodes: [],
  edges: [],
  rootNodeIds: [],
  cycles: [],
  summary: {
    blockedSessionCount: 0,
    rootBlockerCount: 0,
    sentinelRootCount: 0,
    cycleCount: 0,
    parallelWaitTaskCount: 0,
    note: 'no blocking observed in this sample',
  },
}

function snapshot(overrides: Partial<LiveIncidentSnapshot> = {}): LiveIncidentSnapshot {
  return {
    schemaVersion: '1.0',
    target: {
      targetId: 't1',
      displayName: 'test',
      platform: 'SqlServer',
      visibilityScope: 'ServerWide',
      unavailableServerWideEvidenceReason: null,
    },
    sourceTimestamp: null,
    collectedAt: '2024-05-01T00:00:00Z',
    freshUntil: null,
    status: 'Available',
    reason: 'ok',
    requests: [],
    waitingTasks: [],
    blockingGraph: emptyBlockingGraph,
    memoryGrants: [],
    tempdb: { files: [], sessions: [], tasks: [], status: 'Available', reason: 'ok' },
    fileIo: { files: [], status: 'Available', reason: 'ok' },
    scheduler: { schedulers: [], status: 'Available', reason: 'ok' },
    logSpace: {
      totalLogSizeMb: 100,
      usedLogSpaceMb: 10,
      usedLogSpacePercent: 10,
      status: 'Available',
      reason: 'ok',
    },
    diagnostics: {
      sequence: 1,
      collectedAt: '2024-05-01T00:00:00Z',
      sourceTimestamp: null,
      durationMs: 5,
      missedCycles: 0,
      skippedCycles: 0,
      unavailableFields: [],
    },
    ...overrides,
  }
}

function facility(snap: LiveIncidentSnapshot | null, kind: (typeof FACILITY_ORDER)[number]) {
  const found = projectFacilities(snap).find(item => item.kind === kind)
  if (!found) throw new Error(`missing facility ${kind}`)
  return found
}

describe('projectFacilities', () => {
  it('always returns every facility in a fixed order so places never move', () => {
    expect(projectFacilities(null).map(f => f.kind)).toEqual([...FACILITY_ORDER])
    expect(projectFacilities(snapshot()).map(f => f.kind)).toEqual([...FACILITY_ORDER])
  })

  it('claims nothing at all before the first snapshot arrives', () => {
    for (const item of projectFacilities(null)) {
      expect(item.known).toBe(false)
      expect(item.units).toEqual([])
      expect(item.reason).toMatch(/no claim/i)
    }
  })
})

describe('CPU Scheduler Yard', () => {
  it('reports online counts and normalizes load against the busiest scheduler', () => {
    const cpu = facility(
      snapshot({
        scheduler: {
          status: 'Available',
          reason: 'ok',
          schedulers: [
            scheduler({ schedulerId: 0, loadFactor: 4, runnableTasksCount: 2 }),
            scheduler({ schedulerId: 1, loadFactor: 8, runnableTasksCount: 0 }),
          ],
        },
      }),
      'cpu',
    )
    expect(cpu.known).toBe(true)
    expect(cpu.units).toHaveLength(2)
    expect(cpu.units[0].fill).toBeCloseTo(0.5, 10)
    expect(cpu.units[1].fill).toBe(1)
    expect(cpu.alertCount).toBe(1)
    expect(cpu.headline).toContain('2 of 2 schedulers online')
  })

  it('makes no load claim for an offline scheduler', () => {
    const cpu = facility(
      snapshot({
        scheduler: {
          status: 'Available',
          reason: 'ok',
          schedulers: [scheduler({ schedulerId: 0, isOnline: false, loadFactor: 3 })],
        },
      }),
      'cpu',
    )
    expect(cpu.units[0].fill).toBeNull()
    expect(cpu.units[0].detail).toContain('offline')
  })

  it('goes nonquantitative when the scheduler probe is unavailable', () => {
    const cpu = facility(
      snapshot({
        scheduler: { schedulers: [], status: 'PermissionDenied', reason: 'VIEW SERVER STATE missing' },
      }),
      'cpu',
    )
    expect(cpu.known).toBe(false)
    expect(cpu.reason).toContain('VIEW SERVER STATE')
    expect(cpu.units).toEqual([])
  })

  it('says so when a scheduler has no CPU rate yet', () => {
    const cpu = facility(
      snapshot({
        scheduler: {
          status: 'Available',
          reason: 'ok',
          schedulers: [
            scheduler({
              schedulerId: 0,
              cpuUsageMsDelta: delta({ state: 'FirstSample', ratePerSecond: null, deltaValue: null }),
            }),
          ],
        },
      }),
      'cpu',
    )
    expect(cpu.units[0].detail).toContain('no CPU rate yet')
  })
})

describe('Memory Grant Office', () => {
  it('queues waiting grants outside the door and makes no fill claim for them', () => {
    const memory = facility(
      snapshot({
        memoryGrants: [
          grant({ sessionId: 51 }),
          grant({ sessionId: 52, isWaitingForGrant: true, grantedKb: null, waitTimeMs: '4200' }),
        ],
      }),
      'memory',
    )
    expect(memory.alertCount).toBe(1)
    expect(memory.units[1].fill).toBeNull()
    expect(memory.units[1].alert).toBe(true)
    expect(memory.units[1].detail).toContain('4200 ms')
  })

  it('fills granted against requested', () => {
    const memory = facility(
      snapshot({ memoryGrants: [grant({ sessionId: 51, requestedKb: '2048', grantedKb: '1024' })] }),
      'memory',
    )
    expect(memory.units[0].fill).toBeCloseTo(0.5, 10)
  })

  it('distinguishes "no grants in flight" from "could not sample grants"', () => {
    const none = facility(snapshot(), 'memory')
    expect(none.known).toBe(true)
    expect(none.reason).toContain('no rows')

    const denied = facility(
      snapshot({
        diagnostics: {
          ...snapshot().diagnostics,
          unavailableFields: [
            { field: 'memoryGrants', status: 'PermissionDenied', reason: 'no VIEW SERVER STATE' },
          ],
        },
      }),
      'memory',
    )
    expect(denied.known).toBe(false)
    expect(denied.reason).toContain('VIEW SERVER STATE')
  })
})

describe('Storage & I/O Depot', () => {
  it('normalizes bays against the busiest file and flags stalls', () => {
    const storage = facility(
      snapshot({
        fileIo: {
          status: 'Available',
          reason: 'ok',
          files: [
            ioFile({ fileId: 1, bytesReadDelta: delta({ ratePerSecond: 1000 }), bytesWrittenDelta: delta({ ratePerSecond: 0 }) }),
            ioFile({
              fileId: 2,
              bytesReadDelta: delta({ ratePerSecond: 500 }),
              bytesWrittenDelta: delta({ ratePerSecond: 0 }),
              ioStallReadMsDelta: delta({ deltaValue: '90' }),
            }),
          ],
        },
      }),
      'storage',
    )
    expect(storage.units[0].fill).toBe(1)
    expect(storage.units[1].fill).toBeCloseTo(0.5, 10)
    expect(storage.alertCount).toBe(1)
  })

  it('explains an epoch reset instead of reporting zero throughput', () => {
    const storage = facility(
      snapshot({
        fileIo: {
          status: 'Available',
          reason: 'ok',
          files: [
            ioFile({
              fileId: 1,
              readsDelta: delta({ state: 'EpochReset', ratePerSecond: null, deltaValue: null }),
              bytesReadDelta: delta({ state: 'EpochReset', ratePerSecond: null, deltaValue: null }),
              bytesWrittenDelta: delta({ state: 'EpochReset', ratePerSecond: null, deltaValue: null }),
            }),
          ],
        },
      }),
      'storage',
    )
    expect(storage.units[0].fill).toBeNull()
    expect(storage.units[0].detail).toContain('restarted')
  })
})

describe('tempdb Works and Log Yard', () => {
  it('fills tempdb files by allocation and alerts above 85%', () => {
    const tempdb = facility(
      snapshot({
        tempdb: {
          status: 'Available',
          reason: 'ok',
          sessions: [],
          tasks: [],
          files: [tempdbFile({ fileId: 1, allocatedMb: 90, freeMb: 10 })],
        },
      }),
      'tempdb',
    )
    expect(tempdb.units[0].fill).toBeCloseTo(0.9, 10)
    expect(tempdb.alertCount).toBe(1)
  })

  it('fills the log tank by percent and alerts at 80%', () => {
    const quiet = facility(snapshot(), 'log')
    expect(quiet.units[0].fill).toBeCloseTo(0.1, 10)
    expect(quiet.alertCount).toBe(0)

    const full = facility(
      snapshot({
        logSpace: {
          totalLogSizeMb: 100,
          usedLogSpaceMb: 92,
          usedLogSpacePercent: 92,
          status: 'Available',
          reason: 'ok',
        },
      }),
      'log',
    )
    expect(full.alertCount).toBe(1)
  })

  it('makes no log claim when the percentage is unavailable', () => {
    const unknown = facility(
      snapshot({
        logSpace: {
          totalLogSizeMb: null,
          usedLogSpaceMb: null,
          usedLogSpacePercent: null,
          status: 'Available',
          reason: 'ok',
        },
      }),
      'log',
    )
    expect(unknown.units[0].fill).toBeNull()
    expect(unknown.headline).toContain('not reported')
  })
})

describe('Lock Authority', () => {
  it('summarizes the blocking graph and ranks root blockers by blast radius', () => {
    const lock = facility(
      snapshot({
        blockingGraph: {
          edges: [],
          cycles: [],
          rootNodeIds: ['s:51', 's:60'],
          nodes: [
            {
              nodeId: 's:51',
              kind: 'Session',
              sessionId: 51,
              sentinel: 'None',
              isRoot: true,
              isIdleWithOpenTransaction: true,
              inCycle: false,
              directlyBlockedCount: 1,
            },
            {
              nodeId: 's:60',
              kind: 'Session',
              sessionId: 60,
              sentinel: 'None',
              isRoot: true,
              isIdleWithOpenTransaction: false,
              inCycle: false,
              directlyBlockedCount: 3,
            },
            {
              nodeId: 's:70',
              kind: 'Session',
              sessionId: 70,
              sentinel: 'None',
              isRoot: false,
              isIdleWithOpenTransaction: false,
              inCycle: false,
              directlyBlockedCount: 0,
            },
          ],
          summary: {
            blockedSessionCount: 4,
            rootBlockerCount: 2,
            sentinelRootCount: 0,
            cycleCount: 0,
            parallelWaitTaskCount: 0,
            note: 'two root blockers observed',
          },
        },
      }),
      'lock',
    )
    expect(lock.units.map(u => u.id)).toEqual(['blocker:s:60', 'blocker:s:51'])
    expect(lock.units[0].fill).toBeCloseTo(0.75, 10)
    expect(lock.units[1].detail).toContain('idle with an open transaction')
    expect(lock.alertCount).toBe(4)
    expect(lock.headline).toContain('4 blocked')
  })
})
