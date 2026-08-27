import { describe, expect, it } from 'vitest'
import { liveBlockingEdges } from './cityBlocking'
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
    reservedBytes: 1048576,
    usedBytes: 524288,
    sizeStatus: 'Available',
    sizeReason: 'sys.dm_db_partition_stats',
    layout: { neighborhoodOrdinal: 0, objectOrdinal: 0 },
    directActivity: {
      totalOperations: 1,
      resetEpochToken: null,
      evidence: { source: 'dmv', status: 'Available', reason: 'ok' },
    },
    attributedExposure: {
      executionCount: null,
      totalCpuMicroseconds: null,
      totalDurationMicroseconds: null,
      totalLogicalReads8KiBPages: null,
      confidence: 'Confirmed',
      rationale: 'test',
      evidence: { source: 'qs', status: 'Available', reason: 'ok' },
    },
    indexes: [],
  } as unknown as DatabaseCityObject
}

function lock(overrides: Partial<LockResource>): LockResource {
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

function snapshotOf(
  requests: {
    lockResource?: LockResource | null
    blockingSessionId: number | null
    /** Null models a sample that named no database, which switches the numeric object join off. */
    databaseName?: string | null
  }[],
): LiveIncidentSnapshot {
  return {
    requests: requests.map((entry, index) => ({
      requestId: `r${index}`,
      sessionId: 50 + index,
      databaseId: '7',
      databaseName: entry.databaseName === undefined ? 'CityDb' : entry.databaseName,
      waitResource: entry.lockResource?.rawResource ?? null,
      lockResource: entry.lockResource,
      blocking: { blockingSessionId: entry.blockingSessionId, sentinel: 'None' },
    })),
    waitingTasks: [],
  } as unknown as LiveIncidentSnapshot
}

/*
 * Object ids in the shape the API actually serves. An earlier fixture used `7/object/200`, which
 * was the key `lockKeys` happened to build rather than anything a running instance returns —
 * measured, `/api/v1/database-city/primary/database/SimCitySmall` serves
 * `primary/database/SimCitySmall/object/901578250`.
 */
const objects = [
  objectOf('primary/database/CityDb/object/100', 'dbo', 'Customer'),
  objectOf('primary/database/CityDb/object/200', 'sales', 'Orders'),
]

describe('liveBlockingEdges', () => {
  it('claims nothing when the snapshot is missing', () => {
    const summary = liveBlockingEdges(null, objects)
    expect(summary.edges).toEqual([])
    expect(summary.probeReported).toBe(false)
  })

  it('claims nothing when no request carries a lockResource field at all', () => {
    const snapshot = snapshotOf([{ blockingSessionId: 60 }])
    const summary = liveBlockingEdges(snapshot, objects)
    expect(summary.probeReported).toBe(false)
    expect(summary.edges).toEqual([])
  })

  it('resolves a blocked waiter to a loaded object by schema.object name', () => {
    const snapshot = snapshotOf([{ lockResource: lock({}), blockingSessionId: 60 }])
    const summary = liveBlockingEdges(snapshot, objects)
    expect(summary.probeReported).toBe(true)
    expect(summary.edges).toEqual([{ objectKey: 'primary/database/CityDb/object/100', blockedSessionCount: 1 }])
  })

  it('pins a table-level lock that names an object id and no names at all', () => {
    // `OBJECT:`/`TAB:` waits are parsed straight out of the wait-resource text with no catalog
    // lookup, so they carry no schema/object names and the numeric join is the only one available.
    const snapshot = snapshotOf([
      {
        lockResource: lock({ objectId: 200, schemaName: null, objectName: null }),
        blockingSessionId: 60,
      },
    ])
    const summary = liveBlockingEdges(snapshot, objects)
    expect(summary.edges).toEqual([
      { objectKey: 'primary/database/CityDb/object/200', blockedSessionCount: 1 },
    ])
  })

  it('refuses a numeric object id from a different database rather than pinning it here', () => {
    // An object_id is unique only within its own database, so the same number routinely names a
    // different table elsewhere on the instance. Off-map is the honest answer.
    const snapshot = snapshotOf([
      {
        lockResource: lock({ objectId: 200, schemaName: null, objectName: null }),
        blockingSessionId: 60,
        databaseName: 'SomewhereElse',
      },
    ])
    const summary = liveBlockingEdges(snapshot, objects)
    expect(summary.edges).toEqual([])
    expect(summary.offPageCount).toBe(1)
  })

  it('refuses a numeric object id when the sample named no database at all', () => {
    const snapshot = snapshotOf([
      {
        lockResource: lock({ objectId: 200, schemaName: null, objectName: null }),
        blockingSessionId: 60,
        databaseName: null,
      },
    ])
    const summary = liveBlockingEdges(snapshot, objects)
    expect(summary.edges).toEqual([])
    expect(summary.offPageCount).toBe(1)
  })

  it('does not read blocking_session_id 0 as a blocked waiter', () => {
    // Zero is SQL Server's "nothing is blocking this" and is reported for every ordinary running
    // request, so treating it as a blocker badged the whole sample and the chip could never agree
    // with the map.
    const snapshot = snapshotOf([{ lockResource: lock({}), blockingSessionId: 0 }])
    const summary = liveBlockingEdges(snapshot, objects)
    expect(summary.edges).toEqual([])
    expect(summary.offPageCount).toBe(0)
  })

  it('ignores a lock held by a session that nothing is waiting behind', () => {
    const snapshot = snapshotOf([{ lockResource: lock({}), blockingSessionId: null }])
    const summary = liveBlockingEdges(snapshot, objects)
    expect(summary.edges).toEqual([])
    expect(summary.probeReported).toBe(true)
  })

  it('counts a negative sentinel blocker as blocked', () => {
    const snapshot: LiveIncidentSnapshot = {
      requests: [
        {
          requestId: 'r0',
          sessionId: 51,
          waitResource: 'KEY: 7:1',
          lockResource: lock({}),
          blocking: { blockingSessionId: null, sentinel: 'OrphanedDistributedTransaction' },
        },
      ],
      waitingTasks: [],
    } as unknown as LiveIncidentSnapshot
    expect(liveBlockingEdges(snapshot, objects).edges).toEqual([
      { objectKey: 'primary/database/CityDb/object/100', blockedSessionCount: 1 },
    ])
  })

  it('reports an unresolvable page wait with its reason instead of guessing an object', () => {
    const snapshot = snapshotOf([
      {
        lockResource: lock({
          kind: 'Page',
          status: 'RequiresLookup',
          objectId: null,
          schemaName: null,
          objectName: null,
          reason: 'PAGE names a page, not an object; resolving it needs sys.dm_db_page_info.',
        }),
        blockingSessionId: 60,
      },
    ])
    const summary = liveBlockingEdges(snapshot, objects)
    expect(summary.edges).toEqual([])
    expect(summary.unresolved).toHaveLength(1)
    expect(summary.unresolved[0].reason).toContain('sys.dm_db_page_info')
  })

  it('counts a resolved object outside the loaded page separately from an unresolved one', () => {
    const snapshot = snapshotOf([
      { lockResource: lock({ objectName: 'NotLoaded', objectId: 999 }), blockingSessionId: 60 },
    ])
    const summary = liveBlockingEdges(snapshot, objects)
    expect(summary.offPageCount).toBe(1)
    expect(summary.unresolved).toEqual([])
    expect(summary.edges).toEqual([])
  })

  it('sums multiple blocked waiters on the same object and sorts by count', () => {
    const snapshot = snapshotOf([
      { lockResource: lock({}), blockingSessionId: 60 },
      { lockResource: lock({}), blockingSessionId: 61 },
      {
        lockResource: lock({ objectId: 200, schemaName: 'sales', objectName: 'Orders' }),
        blockingSessionId: 62,
      },
    ])
    expect(liveBlockingEdges(snapshot, objects).edges).toEqual([
      { objectKey: 'primary/database/CityDb/object/100', blockedSessionCount: 2 },
      { objectKey: 'primary/database/CityDb/object/200', blockedSessionCount: 1 },
    ])
  })

  it('matches object names case-insensitively', () => {
    const snapshot = snapshotOf([
      { lockResource: lock({ schemaName: 'DBO', objectName: 'CUSTOMER' }), blockingSessionId: 60 },
    ])
    expect(liveBlockingEdges(snapshot, objects).edges).toEqual([
      { objectKey: 'primary/database/CityDb/object/100', blockedSessionCount: 1 },
    ])
  })

  it('reads waiting tasks as well as requests', () => {
    const snapshot: LiveIncidentSnapshot = {
      requests: [],
      waitingTasks: [
        {
          taskId: 't0',
          sessionId: 70,
          resourceDescription: 'KEY: 7:72057594043170816',
          lockResource: lock({}),
          blocking: { blockingSessionId: 71, sentinel: 'None' },
        },
      ],
    } as unknown as LiveIncidentSnapshot
    const summary = liveBlockingEdges(snapshot, objects)
    expect(summary.probeReported).toBe(true)
    expect(summary.edges).toEqual([{ objectKey: 'primary/database/CityDb/object/100', blockedSessionCount: 1 }])
  })
})
