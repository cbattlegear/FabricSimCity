import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { SEVERITY_LABELS, projectIncidents } from './cityIncidents'
import type { DatabaseCityObject } from './databaseCityContracts'
import type { LiveIncidentSnapshot, LockResource } from './liveContracts'

function objectOf(objectId: string, schemaName: string, name: string): DatabaseCityObject {
  return {
    objectId,
    schemaId: `schema:${schemaName}`,
    schemaName,
    name,
    kind: 'Table',
    reservedPages8KiB: '128',
    usedPages8KiB: '64',
    sizeStatus: 'Available',
    sizeReason: 'sys.dm_db_partition_stats',
    layout: { neighborhoodOrdinal: 0, objectOrdinal: 0 },
    indexes: [],
  } as unknown as DatabaseCityObject
}

function lock(overrides: Partial<LockResource> = {}): LockResource {
  return {
    rawResource: 'KEY: 7:72057594043170816 (8194443284a0)',
    kind: 'Key',
    databaseId: 7,
    objectId: 100,
    indexId: 1,
    schemaName: 'dbo',
    objectName: 'Customer',
    indexName: 'PK_Customer',
    status: 'Resolved',
    reason: 'sys.partitions resolved hobt_id 72057594043170816.',
    ...overrides,
  }
}

interface RequestSpec {
  sessionId: number
  lockResource?: LockResource | null
  blockingSessionId?: number | null
  sentinel?: string
  waitTimeMs?: number | null
  waitType?: string | null
}

interface SnapshotSpec {
  requests?: RequestSpec[]
  waitingTasks?: RequestSpec[]
  cycleSessionIds?: number[]
  status?: string
  reason?: string
}

function snapshotOf(spec: SnapshotSpec = {}): LiveIncidentSnapshot {
  const cycles = spec.cycleSessionIds ?? []
  return {
    status: spec.status ?? 'Available',
    reason: spec.reason ?? 'sys.dm_exec_requests sampled at 12:00:00Z.',
    sourceTimestamp: '2024-05-01T12:00:00Z',
    collectedAt: '2024-05-01T12:00:01Z',
    requests: (spec.requests ?? []).map((entry, index) => ({
      requestId: `r${index}`,
      sessionId: entry.sessionId,
      waitType: entry.waitType === undefined ? 'LCK_M_X' : entry.waitType,
      waitTimeMs: entry.waitTimeMs === undefined ? 2500 : entry.waitTimeMs,
      waitResource: entry.lockResource?.rawResource ?? null,
      lockResource: entry.lockResource,
      blocking: {
        blockingSessionId: entry.blockingSessionId ?? null,
        sentinel: entry.sentinel ?? 'None',
      },
    })),
    waitingTasks: (spec.waitingTasks ?? []).map((entry, index) => ({
      taskId: `t${index}`,
      sessionId: entry.sessionId,
      waitType: entry.waitType === undefined ? 'LCK_M_S' : entry.waitType,
      waitDurationMs: String(entry.waitTimeMs ?? 400),
      lockResource: entry.lockResource,
      blocking: {
        blockingSessionId: entry.blockingSessionId ?? null,
        sentinel: entry.sentinel ?? 'None',
      },
    })),
    blockingGraph: {
      nodes: cycles.map(sessionId => ({ nodeId: `n${sessionId}`, sessionId })),
      edges: [],
      rootNodeIds: [],
      cycles: cycles.length > 0 ? [cycles.map(sessionId => `n${sessionId}`)] : [],
      summary: {},
    },
  } as unknown as LiveIncidentSnapshot
}

const objects = [
  objectOf('object:dbo:100', 'dbo', 'Customer'),
  objectOf('7/object/200', 'sales', 'Orders'),
]

describe('projectIncidents · never implies an all-clear', () => {
  it('claims nothing when there is no snapshot at all', () => {
    const projection = projectIncidents(null, objects)
    expect(projection.markers).toEqual([])
    expect(projection.probeReported).toBe(false)
    expect(projection.reason).toMatch(/nothing is claimed/i)
  })

  it('claims nothing when live collection failed, and repeats the collector reason', () => {
    const projection = projectIncidents(
      snapshotOf({ status: 'Unavailable', reason: 'VIEW SERVER STATE was denied.' }),
      objects)
    expect(projection.markers).toEqual([])
    expect(projection.probeReported).toBe(false)
    expect(projection.reason).toContain('VIEW SERVER STATE was denied.')
  })

  it('claims nothing when no sampled request carried a lockResource field at all', () => {
    // The probe never ran. That is "not observed", not "no blocking".
    const projection = projectIncidents(
      snapshotOf({ requests: [{ sessionId: 51, blockingSessionId: 60 }] }),
      objects)
    expect(projection.probeReported).toBe(false)
    expect(projection.markers).toEqual([])
    expect(projection.reason).toMatch(/no blocking is claimed either way/i)
  })

  it('reports the probe ran even when it found nothing to pin', () => {
    const projection = projectIncidents(
      snapshotOf({ requests: [{ sessionId: 51, lockResource: null }] }),
      objects)
    expect(projection.probeReported).toBe(true)
    expect(projection.markers).toEqual([])
  })

  it('accepts a stale snapshot, because stale evidence is still evidence', () => {
    const projection = projectIncidents(
      snapshotOf({
        status: 'Stale',
        requests: [{ sessionId: 51, lockResource: lock(), blockingSessionId: 60 }],
      }),
      objects)
    expect(projection.markers).toHaveLength(1)
  })
})

describe('projectIncidents · what earns a pin', () => {
  it('pins a blocked waiter to the object it is blocked on', () => {
    const projection = projectIncidents(
      snapshotOf({ requests: [{ sessionId: 51, lockResource: lock(), blockingSessionId: 60 }] }),
      objects)
    expect(projection.markers).toHaveLength(1)
    expect(projection.markers[0].objectId).toBe('object:dbo:100')
    expect(projection.markers[0].severity).toBe('blocked')
    expect(projection.markers[0].headline).toContain('51')
  })

  it('does not pin a session that holds a lock nobody is waiting behind', () => {
    const projection = projectIncidents(
      snapshotOf({ requests: [{ sessionId: 51, lockResource: lock(), blockingSessionId: null }] }),
      objects)
    expect(projection.probeReported).toBe(true)
    expect(projection.markers).toEqual([])
  })

  it('pins a waiter blocked behind a sentinel with no named blocker', () => {
    const projection = projectIncidents(
      snapshotOf({
        requests: [{ sessionId: 51, lockResource: lock(), blockingSessionId: null, sentinel: 'Orphan' }],
      }),
      objects)
    expect(projection.markers).toHaveLength(1)
    expect(projection.markers[0].details.join(' ')).toContain('Orphan')
  })

  it('resolves a connected-mode id by databaseId/object/objectId', () => {
    const projection = projectIncidents(
      snapshotOf({
        requests: [{
          sessionId: 51,
          lockResource: lock({ objectId: 200, schemaName: null, objectName: null }),
          blockingSessionId: 60,
        }],
      }),
      objects)
    expect(projection.markers.map(marker => marker.objectId)).toEqual(['7/object/200'])
  })

  it('pins waiting tasks as well as requests', () => {
    const projection = projectIncidents(
      snapshotOf({ waitingTasks: [{ sessionId: 71, lockResource: lock(), blockingSessionId: 60 }] }),
      objects)
    expect(projection.markers).toHaveLength(1)
    expect(projection.markers[0].source).toContain('dm_os_waiting_tasks')
  })
})

describe('projectIncidents · what cannot be pinned is still counted', () => {
  it('counts an off-page object instead of pinning it to the wrong lot', () => {
    const projection = projectIncidents(
      snapshotOf({
        requests: [{
          sessionId: 51,
          lockResource: lock({ objectId: 999, schemaName: 'dbo', objectName: 'NotLoaded' }),
          blockingSessionId: 60,
        }],
      }),
      objects)
    expect(projection.markers).toEqual([])
    expect(projection.offPageCount).toBe(1)
  })

  it('records an unresolvable lock resource with the parser reason, and never guesses', () => {
    const projection = projectIncidents(
      snapshotOf({
        requests: [{
          sessionId: 51,
          lockResource: lock({
            status: 'NotObjectScoped',
            rawResource: 'PAGE: 7:1:4242',
            reason: 'A page lock does not name an object.',
          }),
          blockingSessionId: 60,
        }],
      }),
      objects)
    expect(projection.markers).toEqual([])
    expect(projection.offPageCount).toBe(0)
    expect(projection.unresolved).toEqual([
      { rawResource: 'PAGE: 7:1:4242', reason: 'A page lock does not name an object.' },
    ])
  })
})

describe('projectIncidents · severity and merging', () => {
  it('marks a session in a wait-graph cycle, and says a cycle is what was measured', () => {
    const projection = projectIncidents(
      snapshotOf({
        requests: [{ sessionId: 51, lockResource: lock(), blockingSessionId: 60 }],
        cycleSessionIds: [51, 60],
      }),
      objects)
    expect(projection.markers[0].severity).toBe('deadlock')
    expect(projection.markers[0].headline).toContain('wait cycle')
    const detail = projection.markers[0].details.join(' ')
    expect(detail).toContain('cycle in the current wait graph')
    expect(detail).toMatch(/resolves real deadlocks before they can be sampled/i)
  })

  it('gives one object one pin and folds the other waiters into its details', () => {
    const projection = projectIncidents(
      snapshotOf({
        requests: [
          { sessionId: 51, lockResource: lock(), blockingSessionId: 60 },
          { sessionId: 52, lockResource: lock(), blockingSessionId: 60 },
        ],
      }),
      objects)
    expect(projection.markers).toHaveLength(1)
    const detail = projection.markers[0].details.join(' ')
    expect(detail).toContain('session 51')
    expect(detail).toContain('session 52')
  })

  it('lets a cycle take the pin from a plain block on the same object', () => {
    const projection = projectIncidents(
      snapshotOf({
        requests: [
          { sessionId: 51, lockResource: lock(), blockingSessionId: 60 },
          { sessionId: 52, lockResource: lock(), blockingSessionId: 60 },
        ],
        cycleSessionIds: [52],
      }),
      objects)
    expect(projection.markers).toHaveLength(1)
    expect(projection.markers[0].severity).toBe('deadlock')
    // The demoted waiter is not lost; it is still described.
    expect(projection.markers[0].details.join(' ')).toContain('session 51')
  })

  it('orders markers stably so the map does not reshuffle between samples', () => {
    const spec: SnapshotSpec = {
      requests: [
        {
          sessionId: 52,
          lockResource: lock({ objectId: 200, schemaName: null, objectName: null }),
          blockingSessionId: 60,
        },
        { sessionId: 51, lockResource: lock(), blockingSessionId: 60 },
      ],
    }
    const ids = projectIncidents(snapshotOf(spec), objects).markers.map(marker => marker.objectId)
    expect(ids).toEqual([...ids].sort())
  })
})

describe('projectIncidents · provenance', () => {
  it('names its source and observation time on every marker', () => {
    const projection = projectIncidents(
      snapshotOf({ requests: [{ sessionId: 51, lockResource: lock(), blockingSessionId: 60 }] }),
      objects)
    expect(projection.markers[0].source).toContain('sys.dm_exec_requests')
    expect(projection.markers[0].observedAt).toBe('2024-05-01T12:00:00Z')
  })

  it('falls back to collection time when the source timestamp is missing', () => {
    const snapshot = snapshotOf({
      requests: [{ sessionId: 51, lockResource: lock(), blockingSessionId: 60 }],
    })
    const projection = projectIncidents(
      { ...snapshot, sourceTimestamp: null } as LiveIncidentSnapshot,
      objects)
    expect(projection.markers[0].observedAt).toBe('2024-05-01T12:00:01Z')
  })

  it('says a wait duration is not reported rather than showing it as zero', () => {
    const projection = projectIncidents(
      snapshotOf({
        requests: [{ sessionId: 51, lockResource: lock(), blockingSessionId: 60, waitTimeMs: null }],
      }),
      objects)
    expect(projection.markers[0].details.join(' ')).toContain('wait duration not reported')
  })

  it('says a wait type is not reported rather than inventing one', () => {
    const projection = projectIncidents(
      snapshotOf({
        requests: [{ sessionId: 51, lockResource: lock(), blockingSessionId: 60, waitType: null }],
      }),
      objects)
    expect(projection.markers[0].details.join(' ')).toContain('wait type not reported')
  })

  it('formats sub-second and multi-second waits differently but never rounds to nothing', () => {
    const fast = projectIncidents(
      snapshotOf({
        requests: [{ sessionId: 51, lockResource: lock(), blockingSessionId: 60, waitTimeMs: 250 }],
      }),
      objects)
    expect(fast.markers[0].details[0]).toBe('250 ms waited')

    const slow = projectIncidents(
      snapshotOf({
        requests: [{ sessionId: 51, lockResource: lock(), blockingSessionId: 60, waitTimeMs: 4200 }],
      }),
      objects)
    expect(slow.markers[0].details[0]).toBe('4.2 s waited')
  })

  it('labels every severity it can emit', () => {
    expect(Object.keys(SEVERITY_LABELS).sort()).toEqual(['blocked', 'deadlock', 'waiting'])
  })
})


/**
 * An incident pin is a sphere in a 3D scene, so pointer-picking is the only way a mouse reaches it.
 * Without a text route, a keyboard or screen-reader user could not read an incident at all -- the
 * evidence would exist but be unreachable. These guard the route rather than the styling.
 */
describe('incident popups are reachable without a pointer', () => {
  const popup = readFileSync(new URL('./IncidentPopup.tsx', import.meta.url), 'utf8')
  const viewport = readFileSync(new URL('./DatabaseCityViewport.tsx', import.meta.url), 'utf8')

  it('lists every marker in the summary as a real button', () => {
    expect(popup).toContain('{markers.map(marker => (')
    expect(popup).toMatch(/<button\s+type="button"\s+className={`incident-jump/)
    expect(popup).toContain('onClick={() => onOpen(marker.id)}')
    // Not a div with a click handler: it has to be focusable and announce its state.
    expect(popup).toContain("aria-expanded={openId === marker.id}")
  })

  it('centres the building before opening, so the popup cannot anchor off screen', () => {
    expect(viewport).toContain('const openIncidentFromList = useCallback((markerId: string) => {')
    expect(viewport).toContain('sceneRef.current?.focusObject(marker.objectId)')
    expect(viewport).toContain('onOpen={openIncidentFromList}')
  })

  it('keeps the qualification text even when markers are listed', () => {
    expect(popup).toContain('<small>{reason}</small>')
    expect(popup).toContain("<span className=\"is-unknown\">Blocking not observed</span>")
  })
})