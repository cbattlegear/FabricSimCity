import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  SEVERITY_LABELS,
  deadlockSummaryLabel,
  deadlockSummaryTone,
  incidentDemandsAttention,
  incidentSummaryLabel,
  incidentSummaryTone,
  incidentUnpinnedCount,
  projectIncidents,
  stopsTraffic,
} from './cityIncidents'
import type { DatabaseCityObject } from './databaseCityContracts'
import type { IncidentSeverity } from './cityIncidents'
import type {
  DeadlockGraph,
  DeadlockParticipant,
  DeadlockResource,
  DeadlockSample,
  LiveIncidentSnapshot,
  LockResource,
} from './liveContracts'

function part(processId: string, mode: string): DeadlockParticipant {
  return { processId, mode, requestType: 'wait' }
}

function resource(overrides: Partial<DeadlockResource> = {}): DeadlockResource {
  return {
    resourceKind: 'keylock',
    databaseId: 7,
    objectName: 'sim.dbo.Customer',
    indexName: 'PK_Customer',
    associatedObjectId: 100,
    owners: [part('p1', 'X')],
    waiters: [part('p2', 'S')],
    ...overrides,
  } as DeadlockResource
}

function graph(overrides: Partial<DeadlockGraph> = {}): DeadlockGraph {
  return {
    id: 'dl:1',
    occurredAt: '2024-05-01T11:40:00Z',
    // A graph names its database on the processes, which is what gates the numeric object join.
    processes: [
      { id: 'p1', sessionId: 51, isVictim: false, databaseName: 'CityDb' },
      { id: 'p2', sessionId: 52, isVictim: true, databaseName: 'CityDb' },
    ],
    resources: [resource()],
    victimProcessIds: ['p2'],
    includesSqlText: true,
    ...overrides,
  } as unknown as DeadlockGraph
}

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
  /** Null models a sample that named no database, which switches the numeric object join off. */
  databaseName?: string | null
}

interface SnapshotSpec {
  requests?: RequestSpec[]
  waitingTasks?: RequestSpec[]
  cycleSessionIds?: number[]
  status?: string
  reason?: string
  deadlocks?: Partial<DeadlockSample>
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
      databaseId: '7',
      databaseName: entry.databaseName === undefined ? 'CityDb' : entry.databaseName,
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
    // Omitted unless a test asks for it: a fixture that always carries a reader would hide the case
    // where an older API build serves a snapshot without one.
    ...(spec.deadlocks
      ? {
        deadlocks: {
          graphs: [],
          totalRetainedCount: 0,
          collectedAt: '2024-05-01T12:00:00Z',
          status: 'Available',
          reason: 'Read 0 deadlock graph(s) from system_health.',
          ...spec.deadlocks,
        },
      }
      : {}),
  } as unknown as LiveIncidentSnapshot
}

/*
 * Object ids in the shape the API actually serves: `<endpoint>/database/<name>/object/<object_id>`.
 *
 * An earlier fixture used `7/object/200` here, which was the key format `lockKeys` happened to
 * build rather than anything a running instance ever returns. Measured against a live SQL Server,
 * `/api/v1/database-city/primary/database/SimCitySmall` serves
 * `primary/database/SimCitySmall/object/901578250`, so a test written to the old shape asserted the
 * implementation agreed with itself and could not see that the join was dead on real data.
 */
const objects = [
  objectOf('primary/database/CityDb/object/100', 'dbo', 'Customer'),
  objectOf('primary/database/CityDb/object/200', 'sales', 'Orders'),
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
    expect(projection.markers[0].objectId).toBe('primary/database/CityDb/object/100')
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

  /*
   * The regression this file previously could not see.
   *
   * An `OBJECT:`/`TAB:` lock is parsed straight out of the wait-resource text with no catalog
   * lookup, so it carries `objectId` and nothing else — `schemaName` and `objectName` are null by
   * design. Measured against a live instance, a table-level block produced exactly this and was
   * counted off-map every time, so the live feed showed rows badged "blocked" with no pin beside
   * them on the city.
   */
  it('pins a table-level lock that names an object id and no names at all', () => {
    const projection = projectIncidents(
      snapshotOf({
        requests: [{
          sessionId: 51,
          lockResource: lock({
            rawResource: 'OBJECT: 7:200:15',
            kind: 'Object',
            objectId: 200,
            schemaName: null,
            objectName: null,
          }),
          blockingSessionId: 60,
        }],
      }),
      objects)
    expect(projection.markers.map(marker => marker.objectId))
      .toEqual(['primary/database/CityDb/object/200'])
    expect(projection.offPageCount).toBe(0)
  })

  /*
   * An object_id is unique only inside its own database. Two databases on one instance reuse the
   * same numbers routinely, so a numeric join without a database check would pin another
   * database's block onto this city's buildings — a worse failure than not pinning it.
   */
  it('refuses a numeric object id from a different database rather than pinning it here', () => {
    const projection = projectIncidents(
      snapshotOf({
        requests: [{
          sessionId: 51,
          databaseName: 'SomewhereElse',
          lockResource: lock({ objectId: 200, schemaName: null, objectName: null }),
          blockingSessionId: 60,
        }],
      }),
      objects)
    expect(projection.markers).toEqual([])
    expect(projection.offPageCount).toBe(1)
  })

  it('refuses a numeric object id when the sample named no database at all', () => {
    const projection = projectIncidents(
      snapshotOf({
        requests: [{
          sessionId: 51,
          databaseName: null,
          lockResource: lock({ objectId: 200, schemaName: null, objectName: null }),
          blockingSessionId: 60,
        }],
      }),
      objects)
    expect(projection.markers).toEqual([])
    expect(projection.offPageCount).toBe(1)
  })

  /*
   * Zero is SQL Server's "nothing is blocking this", reported for every ordinary running request.
   * Reading it as a session number marked the whole sample blocked, and because an unblocked
   * request carries no lock resource there was never a pin to go with the badge -- which is exactly
   * how this surfaced: "blocked" rows in the live feed with nothing on the map beside them.
   */
  it('does not treat blocking_session_id 0 as a blocker', () => {
    const projection = projectIncidents(
      snapshotOf({
        requests: [{
          sessionId: 51,
          lockResource: lock(),
          blockingSessionId: 0,
        }],
      }),
      objects)
    expect(projection.markers).toEqual([])
    expect(projection.offPageCount).toBe(0)
    expect(projection.unresolved).toEqual([])
  })

  it('still pins a real blocker', () => {
    const projection = projectIncidents(
      snapshotOf({ requests: [{ sessionId: 51, lockResource: lock(), blockingSessionId: 60 }] }),
      objects)
    expect(projection.markers).toHaveLength(1)
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
    /*
     * `cycle`, not `deadlock`. A cycle in the *live* wait graph is a weaker observation than a
     * deadlock: the engine resolves a real deadlock and rolls a victim back before any sample of
     * `sys.dm_exec_requests` could see it, so anything visible here by definition was not one.
     * `deadlock` is reserved for a graph `system_health` actually recorded.
     */
    expect(projection.markers[0].severity).toBe('cycle')
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
    expect(projection.markers[0].severity).toBe('cycle')
    // The demoted waiter is not lost; it is still described.
    expect(projection.markers[0].details.join(' ')).toContain('session 51')
  })

  it('keeps every blocked session on the merged pin, so no vehicle is stranded', () => {
    /*
     * The merge picks one marker to survive and folds the other's prose into it. Its *session ids*
     * have to survive as a union rather than as the winner's list, because `sessionIds` is what
     * `DatabaseCityScene` uses to decide which live requests halt at this pin. Take the winner's
     * list alone and session 52 is measurably blocked, is described in the pin's own details, and
     * its vehicle drives past the incident it is stuck at.
     */
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
    // 52 promoted the pin to a cycle, so it is the winner; 51 is the one at risk of being dropped.
    expect(projection.markers[0].severity).toBe('cycle')
    expect([...projection.markers[0].sessionIds].sort((a, b) => a - b)).toEqual([51, 52])
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

describe('stopsTraffic · only a live block can halt a vehicle', () => {
  /*
   * All four severities, deliberately exhaustive. Three describe something happening on the
   * instance right now; `deadlock` describes something the engine already finished.
   *
   * The failure this pins is silent. A recorded graph names its participants by session id, and
   * SQL Server recycles session ids, so by the time the graph is readable a live session carrying
   * one of those numbers is almost certainly an unrelated request that inherited it. Stop a
   * vehicle there and the page asserts a currently-running query is caught in a deadlock that is
   * over and was never its own — which looks entirely plausible on screen.
   */
  const cases: ReadonlyArray<readonly [IncidentSeverity, boolean, string]> = [
    ['blocked', true, 'a live block: the blocker and the waiter are both still on the instance'],
    ['waiting', true, 'a live wait: sampled from a task that has not been granted its lock'],
    ['cycle', true, 'a live wait cycle: weaker evidence than a graph, but the sessions are current'],
    ['deadlock', false, 'a recorded graph: already resolved, and its session ids may have been reused'],
  ]

  it.each(cases)('%s → %s (%s)', (severity, expected) => {
    expect(stopsTraffic({ severity })).toBe(expected)
  })

  it('covers every severity the type allows', () => {
    // If a fifth severity is added, this fails rather than letting it default to "stops traffic"
    // by never being considered at all.
    expect(cases.map(([severity]) => severity).sort())
      .toEqual(Object.keys(SEVERITY_LABELS).sort())
  })
})

describe('projectIncidents · provenance', () => {  it('names its source and observation time on every marker', () => {
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
    expect(Object.keys(SEVERITY_LABELS).sort()).toEqual(['blocked', 'cycle', 'deadlock', 'waiting'])
  })

  /**
   * The two names have to stay distinguishable in the words as well as in the union.
   *
   * `cycle` is what the live wait graph can show; `deadlock` is what `system_health` recorded and the
   * engine already killed. Labelling a live cycle "deadlock" claims the engine failed to resolve
   * something it resolves in milliseconds, which is the strongest wrong claim this map could make.
   */
  it('never labels a live wait cycle as a deadlock', () => {
    expect(SEVERITY_LABELS.cycle).not.toMatch(/deadlock/i)
    expect(SEVERITY_LABELS.deadlock).toMatch(/deadlock/i)
    expect(SEVERITY_LABELS.deadlock).not.toBe(SEVERITY_LABELS.cycle)
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
  const view = readFileSync(new URL('./DatabaseCityView.tsx', import.meta.url), 'utf8')

  it('lists every marker in the summary as a real button', () => {
    expect(popup).toContain('{markers.map(marker => (')
    expect(popup).toMatch(/<button\s+type="button"\s+className={`incident-jump/)
    expect(popup).toContain('onClick={() => onOpen(marker.id)}')
    // Not a div with a click handler: it has to be focusable and announce its state.
    expect(popup).toContain("aria-expanded={openId === marker.id}")
  })

  /**
   * The list now lives in a sidebar drawer, outside the map, so the camera move crosses a component
   * boundary: the view asks, the viewport does it. The nonce is what makes clicking the same entry
   * twice move the camera twice -- without it the second click sets an identical object id, React
   * bails out of the effect, and a reader who has since panned away gets a popup anchored nowhere.
   */
  it('centres the building before opening, so the popup cannot anchor off screen', () => {
    expect(view).toContain('const openIncidentFromList = useCallback((markerId: string) => {')
    expect(view).toContain('setIncidentFocus({ objectId: marker.objectId, nonce: incidentFocusNonce.current })')
    expect(view).toContain('onOpen={openIncidentFromList}')
    expect(view).toContain('incidentFocus={incidentFocus}')
    expect(viewport).toContain('if (incidentFocus) sceneRef.current?.focusObject(incidentFocus.objectId)')
    // Re-asking for the same object has to be a new request, or the second click does nothing.
    expect(view).toContain('incidentFocusNonce.current += 1')
  })

  it('keeps the qualification text even when markers are listed', () => {
    expect(popup).toContain('<small>{reason}</small>')
    expect(popup).toContain("<span className=\"is-unknown\">Blocking not observed</span>")
  })
})
describe('projectIncidents · recorded deadlocks', () => {
  it('treats an absent reader as not observed, never as "no deadlocks"', () => {
    const projection = projectIncidents(snapshotOf({}), objects)
    expect(projection.deadlocks.observed).toBe(false)
    expect(projection.deadlocks.reason).toMatch(/nothing is claimed about deadlocks/i)
    expect(deadlockSummaryLabel(projection)).toBe('Not observed')
    expect(deadlockSummaryTone(projection)).toBe('is-unknown')
    // An unreported reader is a hole in the evidence, and a hole is worth surfacing.
    expect(incidentDemandsAttention(projection)).toBe(true)
  })

  /**
   * `Unsupported` is Azure SQL Database, which has no `system_health` session at all. Rendering it
   * the same as "read the window and found nothing" would claim a clean bill of health on an
   * instance that was never examined.
   */
  it('keeps "unsupported" distinct from "none retained"', () => {
    const unsupported = projectIncidents(
      snapshotOf({ deadlocks: { status: 'Unsupported', reason: 'No system_health session exists here.' } }),
      objects)
    expect(unsupported.deadlocks.observed).toBe(false)
    expect(unsupported.deadlocks.reason).toContain('No system_health session exists here.')
    expect(deadlockSummaryLabel(unsupported)).toBe('Not observed')

    const empty = projectIncidents(
      snapshotOf({ requests: [{ sessionId: 51, lockResource: null }], deadlocks: {} }),
      objects)
    expect(empty.deadlocks.observed).toBe(true)
    expect(deadlockSummaryLabel(empty)).toBe('None in window')
    expect(deadlockSummaryTone(empty)).toBe('')
    expect(incidentDemandsAttention(empty)).toBe(false)
  })

  it('reads a stale sample, because stale evidence is still evidence', () => {
    const projection = projectIncidents(
      snapshotOf({ deadlocks: { status: 'Stale', graphs: [graph()], totalRetainedCount: 1 } }),
      objects)
    expect(projection.deadlocks.observed).toBe(true)
    expect(projection.markers.some(marker => marker.severity === 'deadlock')).toBe(true)
  })

  it('pins a recorded graph to the object its resource names', () => {
    const projection = projectIncidents(
      snapshotOf({ deadlocks: { graphs: [graph()], totalRetainedCount: 1 } }),
      objects)
    const marker = projection.markers.find(entry => entry.severity === 'deadlock')
    expect(marker?.objectId).toBe('primary/database/CityDb/object/100')
    expect(marker?.headline).toContain('deadlock was recorded here')
    expect(marker?.source).toContain('system_health')
  })

  /**
   * A deadlock is history by the time anything can read it, and dating it from the snapshot would
   * present an hour-old event as something happening now.
   */
  it('dates the pin from when the deadlock happened and says so', () => {
    const projection = projectIncidents(
      snapshotOf({ deadlocks: { graphs: [graph()], totalRetainedCount: 1 } }),
      objects)
    const marker = projection.markers.find(entry => entry.severity === 'deadlock')
    const detail = marker?.details.join(' ') ?? ''
    expect(detail).toContain('recorded at 2024-05-01T11:40:00Z')
    expect(detail).toMatch(/this is history/i)
    expect(detail).toContain('victim session 52')
  })

  /** Two loaded resources make the pin a claim about a relationship, so the road can be found. */
  it('does not pin a graph from another database by object id alone', () => {
    const projection = projectIncidents(
      snapshotOf({
        deadlocks: {
          graphs: [graph({
            processes: [
              { id: 'p1', sessionId: 51, isVictim: false, databaseName: 'SomewhereElse' },
              { id: 'p2', sessionId: 52, isVictim: true, databaseName: 'SomewhereElse' },
            ],
            resources: [resource({ objectName: null, associatedObjectId: 100 })],
          } as unknown as Partial<DeadlockGraph>)],
          totalRetainedCount: 1,
        },
      }),
      objects)
    expect(projection.markers.filter(entry => entry.severity === 'deadlock')).toEqual([])
    expect(projection.deadlocks.retainedCount).toBe(1)
  })

  it('names the other loaded objects in the graph as counterparts', () => {
    const projection = projectIncidents(
      snapshotOf({
        deadlocks: {
          graphs: [graph({
            resources: [
              resource(),
              resource({
                objectName: null,
                databaseId: 7,
                associatedObjectId: 200,
                owners: [part('p2', 'X')],
                waiters: [part('p1', 'S')],
              }),
            ],
          })],
          totalRetainedCount: 1,
        },
      }),
      objects)
    const marker = projection.markers.find(entry => entry.severity === 'deadlock')
    expect(marker?.objectId).toBe('primary/database/CityDb/object/100')
    expect(marker?.counterpartObjectIds).toEqual(['primary/database/CityDb/object/200'])
  })

  /**
   * The anchor is the resource the *victim* was waiting for, because that is the request the engine
   * actually killed. Anchoring on the first resource in document order would move the pin for a
   * reason that has nothing to do with the deadlock.
   */
  it('anchors on the victim\'s own resource rather than on document order', () => {
    const projection = projectIncidents(
      snapshotOf({
        deadlocks: {
          graphs: [graph({
            resources: [
              resource({
                objectName: null,
                associatedObjectId: 200,
                owners: [part('p2', 'X')],
                waiters: [part('p1', 'S')],
              }),
              resource(),
            ],
          })],
          totalRetainedCount: 1,
        },
      }),
      objects)
    const marker = projection.markers.find(entry => entry.severity === 'deadlock')
    // p2 is the victim and waits on the `dbo.Customer` resource, which is second in the list.
    expect(marker?.objectId).toBe('primary/database/CityDb/object/100')
  })

  it('says when the anchor is not the victim\'s resource, rather than implying it was', () => {
    const projection = projectIncidents(
      snapshotOf({
        deadlocks: {
          graphs: [graph({ resources: [resource({ waiters: [part('p1', 'S')] })] })],
          totalRetainedCount: 1,
        },
      }),
      objects)
    const marker = projection.markers.find(entry => entry.severity === 'deadlock')
    expect(marker?.details.join(' ')).toMatch(/victim's own resource is not on this page/i)
  })

  it('says statement text is absent rather than empty when it was not requested', () => {
    const projection = projectIncidents(
      snapshotOf({ deadlocks: { graphs: [graph({ includesSqlText: false })], totalRetainedCount: 1 } }),
      objects)
    expect(projection.markers.find(entry => entry.severity === 'deadlock')?.details.join(' '))
      .toMatch(/absent rather than empty/i)
  })

  /**
   * A deadlock between two tables in another database is real and is counted; drawing it anywhere on
   * this page would be a lie about where it happened.
   */
  it('counts a graph it cannot place instead of pinning it to the wrong lot', () => {
    const projection = projectIncidents(
      snapshotOf({
        deadlocks: {
          graphs: [graph({ resources: [resource({ objectName: 'other.dbo.Elsewhere', associatedObjectId: 999 })] })],
          totalRetainedCount: 4,
        },
      }),
      objects)
    expect(projection.markers.some(entry => entry.severity === 'deadlock')).toBe(false)
    expect(projection.deadlocks.retainedCount).toBe(4)
    expect(projection.deadlocks.graphCount).toBe(1)
    // Read one of four, and pinned none of the one: the summary discloses the window it read, and
    // `pinnedCount` is what says the map is not showing even that one.
    expect(projection.deadlocks.pinnedCount).toBe(0)
    expect(deadlockSummaryLabel(projection)).toBe('1 of 4 retained')
  })

  it('resolves a resource kind that names no object to nothing, not to a guess', () => {
    const projection = projectIncidents(
      snapshotOf({
        deadlocks: {
          graphs: [graph({
            resources: [resource({ resourceKind: 'exchangeEvent', objectName: null, associatedObjectId: null })],
          })],
          totalRetainedCount: 1,
        },
      }),
      objects)
    expect(projection.markers.some(entry => entry.severity === 'deadlock')).toBe(false)
  })

  it('treats a retained deadlock as something the reader must be shown', () => {
    const projection = projectIncidents(
      snapshotOf({ deadlocks: { graphs: [graph()], totalRetainedCount: 1 } }),
      objects)
    expect(incidentDemandsAttention(projection)).toBe(true)
    expect(deadlockSummaryTone(projection)).toBe('is-alert')
  })
})

describe('incident summary wording · a folded chip may be the whole probe', () => {
  const base = {
    markers: [],
    offPageCount: 0,
    unresolved: [],
    probeReported: true,
    // Deadlocks observed and none found, so this fixture keeps saying exactly what it used to about
    // blocking. A projection with an unreported deadlock reader is a different case, tested below.
    deadlocks: { observed: true, graphCount: 0, retainedCount: 0, pinnedCount: 0, reason: 'd' },
    reason: 'r',
  } as const

  it('says "Not observed" when the probe never reported, never "No blocks"', () => {
    const p = { ...base, probeReported: false }
    expect(incidentSummaryLabel(p)).toBe('Not observed')
    expect(incidentSummaryTone(p)).toBe('is-unknown')
    expect(incidentDemandsAttention(p)).toBe(true)
  })

  it('states the pin count when waiters were placed', () => {
    const p = { ...base, markers: [{ id: 'a' }, { id: 'b' }] as never }
    expect(incidentSummaryLabel(p)).toBe('2 blocked')
    expect(incidentSummaryTone(p)).toBe('is-alert')
    expect(incidentDemandsAttention(p)).toBe(true)
  })

  it('never says "No blocks" over an off-page waiter the probe did see', () => {
    const p = { ...base, offPageCount: 3 }
    expect(incidentSummaryLabel(p)).toBe('3 off-map')
    expect(incidentSummaryTone(p)).toBe('is-unknown')
    expect(incidentDemandsAttention(p)).toBe(true)
  })

  it('counts an unresolvable lock resource as unpinned, not as absent', () => {
    const p = { ...base, unresolved: [{ rawResource: 'PAGE: 7:1:40', reason: 'page lock' }] }
    expect(incidentSummaryLabel(p)).toBe('1 off-map')
    expect(incidentDemandsAttention(p)).toBe(true)
  })

  it('adds off-page and unresolvable together', () => {
    const p = {
      ...base,
      offPageCount: 2,
      unresolved: [{ rawResource: 'XACT: 7:99', reason: 'transaction' }],
    }
    expect(incidentUnpinnedCount(p)).toBe(3)
    expect(incidentSummaryLabel(p)).toBe('3 off-map')
  })

  it('only says "No blocks" when the probe reported and nothing at all was found', () => {
    expect(incidentSummaryLabel(base)).toBe('No blocks')
    expect(incidentSummaryTone(base)).toBe('')
    expect(incidentDemandsAttention(base)).toBe(false)
  })

  it('words a real off-page projection from projectIncidents, not just a hand-built one', () => {
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
    expect(incidentSummaryLabel(projection)).toBe('1 off-map')
    expect(incidentDemandsAttention(projection)).toBe(true)
  })
})
