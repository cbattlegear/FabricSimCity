import { describe, expect, it } from 'vitest'
import {
  advanceQueryFeed,
  liveQuerySummaryLabel,
  queryEventId,
  EMPTY_QUERY_FEED,
  LIVE_QUERY_ARRIVAL_BURST_CAP,
  LIVE_QUERY_FEED_CAP,
} from './liveQueryFeed'
import type { LiveQueryFeedScope } from './liveQueryFeed'
import type { OperationFamily } from '../capacityCityContracts'
import type {
  CompletedQuery,
  CompletedQuerySample,
  LiveIncidentSnapshot,
  LiveRequest,
} from '../liveContracts'

/**
 * The feed is the only surface on this page that claims to be a log of *events*, and every way it
 * can be wrong is a way it can be wrong quietly. Two executions folded into one row look exactly
 * like a calm instance. An arrival time taken from `start_time` rather than from the sample makes an
 * hour-old query look like it just began. A departed row that reads as "finished" invents an outcome
 * the DMVs never reported.
 *
 * This is a new module with no previous version to revert to, so each guard below was
 * mutation-checked instead — the implementation was changed to the obvious wrong version and the
 * guard watched to fail. The mutations are named in the comments so the check is repeatable.
 */

const T0 = 1_700_000_000_000

function request(over: Partial<LiveRequest> = {}): LiveRequest {
  return {
    requestId: 'req:51:0',
    sessionId: 51,
    loginName: null,
    hostName: null,
    programName: null,
    sessionStatus: 'running',
    requestStatus: 'running',
    command: 'SELECT',
    waitType: null,
    waitTimeMs: null,
    waitResource: null,
    blocking: { blockingSessionId: null, sentinel: 'None' },
    requestStartTime: '2024-01-01T00:00:00Z',
    totalElapsedMs: 100,
    cpuTimeMs: 10,
    reads: null,
    writes: null,
    logicalReads8KiBPages: null,
    openTransactionCount: null,
    databaseId: null,
    databaseName: 'Shop',
    currentStatementText: 'SELECT 1',
    batchText: 'EXEC dbo.Everything',
    availability: 'Available',
    availabilityReason: null,
    planState: 'Available',
    planReason: null,
    familyId: 'AABBCCDDEEFF0011',
    ...over,
  } as LiveRequest
}

function snapshot(requests: LiveRequest[]): LiveIncidentSnapshot {
  return { requests } as LiveIncidentSnapshot
}

function family(over: Partial<OperationFamily> = {}): OperationFamily {
  return {
    familyId: 'fam-1',
    familyId: 'AABBCCDDEEFF0011',
    displayName: 'SELECT …',
    executionCount: 10,
    totalCpuMs: 1,
    totalDurationMs: 1,
    totalLogicalReads: '1',
    itemIds: ['obj-1'],
    ...over,
  } as OperationFamily
}

const families = [family()]

/*
 * Every fake request above is on 'Shop', so this scope admits them all and the existing
 * assertions go on describing what they always described.
 *
 * It is deliberately a real database name rather than `null`. The live sampler is instance-wide,
 * so a null scope is the unfiltered instance-wide feed -- exactly the bug this parameter exists to
 * fix -- and defaulting the whole test file to it would mean none of these tests ever exercised
 * the filter at all.
 */
const SCOPE: LiveQueryFeedScope = { databaseName: 'Shop' }

/** Fold a run of samples, one second apart, starting at T0. */
function fold(samples: (LiveIncidentSnapshot | null)[], step = 1_000) {
  let feed = EMPTY_QUERY_FEED
  samples.forEach((sample, index) => {
    feed = advanceQueryFeed(feed, sample, families, T0 + index * step, SCOPE)
  })
  return feed
}

describe('an arrival is an observation, and the row says whose clock it is on', () => {
  /*
   * The single most important assertion in this file.
   *
   * Mutation checked: `firstSeenAt: Date.parse(request.requestStartTime)` — the obvious "use the
   * real start time" shortcut — passes every ordering test here and fails only this one. It is also
   * what would make an hour-old statement launch its car from a point it never drove to.
   */
  it('times an arrival by when this browser sampled it, not by when the query started', () => {
    const old = request({ requestStartTime: '2020-06-01T00:00:00Z' })
    const feed = advanceQueryFeed(EMPTY_QUERY_FEED, snapshot([old]), families, T0, SCOPE)
    expect(feed.events[0].firstSeenAt).toBe(T0)
    // The engine's own value survives beside it, because the row shows both.
    expect(feed.events[0].startedAt).toBe('2020-06-01T00:00:00Z')
    expect(Date.parse(feed.events[0].startedAt!)).toBeLessThan(feed.events[0].firstSeenAt)
  })

  it('says in plain words that arrival is an observation and departure is not success', () => {
    const feed = fold([snapshot([request()])])
    expect(feed.reason).toMatch(/first learned of the execution, not when the query ran/i)
    expect(feed.reason).toMatch(/not that it succeeded/i)
  })
})

describe('the list is newest first, and stays put between samples', () => {
  /*
   * Mutation checked: sorting by `firstSeenAt` instead of by ordinal shuffles rows that share a
   * millisecond on every re-render, which is the jitter that makes a scrolling list unreadable.
   */
  it('puts a later arrival above an earlier one', () => {
    const feed = fold([
      snapshot([request({ requestId: 'req:51:0' })]),
      snapshot([request({ requestId: 'req:51:0' }), request({ sessionId: 52, requestId: 'req:52:0' })]),
    ])
    expect(feed.events.map(event => event.sessionId)).toEqual([52, 51])
  })

  it('keeps two executions that arrived in the same sample in the order the sample listed them', () => {
    const feed = fold([snapshot([
      request({ sessionId: 51, requestId: 'req:51:0' }),
      request({ sessionId: 52, requestId: 'req:52:0' }),
      request({ sessionId: 53, requestId: 'req:53:0' }),
    ])])
    // All three share `firstSeenAt`; the ordinal is what separates them.
    expect(new Set(feed.events.map(event => event.firstSeenAt)).size).toBe(1)
    expect(feed.events.map(event => event.sessionId)).toEqual([53, 52, 51])
    expect(feed.events.map(event => event.ordinal)).toEqual([3, 2, 1])
  })

  it('never reuses an ordinal, so a row can be identified by it for as long as it is shown', () => {
    const feed = fold([
      snapshot([request()]),
      snapshot([]),
      snapshot([request({ sessionId: 52, requestId: 'req:52:0' })]),
    ])
    expect(new Set(feed.events.map(event => event.ordinal)).size).toBe(feed.events.length)
    expect(feed.nextOrdinal).toBeGreaterThan(Math.max(...feed.events.map(event => event.ordinal)))
  })

  it('does not re-announce a request that is still running', () => {
    const feed = fold([snapshot([request()]), snapshot([request()]), snapshot([request()])])
    expect(feed.events).toHaveLength(1)
    expect(feed.observed).toBe(1)
    expect(feed.events[0].firstSeenAt).toBe(T0)
    expect(feed.events[0].lastSeenAt).toBe(T0 + 2_000)
  })
})

describe('identity is the session, the request and the start time together', () => {
  it('builds the key out of all three', () => {
    expect(queryEventId(request())).toBe('51|req:51:0|2024-01-01T00:00:00Z')
  })

  /*
   * Mutation checked: keying on `requestId` alone folds these two into one row that keeps the first
   * arrival time and never scrolls — a session running a statement a second forever would show as a
   * single quiet query. This is the failure that makes a churning instance look calm.
   */
  it('separates two executions a session ran in turn under the same request id', () => {
    const first = request({ requestStartTime: '2024-01-01T00:00:00Z' })
    const second = request({ requestStartTime: '2024-01-01T00:00:05Z' })
    const feed = fold([snapshot([first]), snapshot([second])])
    expect(feed.events).toHaveLength(2)
    expect(feed.observed).toBe(2)
    expect(feed.events[0].firstSeenAt).toBe(T0 + 1_000)
    expect(feed.events[1].firstSeenAt).toBe(T0)
  })

  it('separates two sessions that happen to share a request id and a start time', () => {
    const feed = fold([snapshot([
      request({ sessionId: 51, requestId: 'req:51:0' }),
      request({ sessionId: 77, requestId: 'req:77:0' }),
    ])])
    expect(feed.events).toHaveLength(2)
  })

  it('collapses a duplicate row inside one sample rather than double-counting it', () => {
    // The same execution listed twice by one collection would otherwise arrive twice.
    const feed = fold([snapshot([request(), request()])])
    expect(feed.events).toHaveLength(1)
    expect(feed.observed).toBe(1)
  })
})

describe('a departure means the row was gone from the next sample and nothing more', () => {
  it('marks a row ended at the sample that no longer carried it', () => {
    const feed = fold([snapshot([request()]), snapshot([])])
    expect(feed.events).toHaveLength(1)
    expect(feed.events[0].endedAt).toBe(T0 + 1_000)
    expect(feed.running).toBe(0)
  })

  /*
   * Mutation checked: dropping ended rows from `merged` empties the list the instant a query
   * finishes, so the reader never sees what just ran — which is most of what a live feed is for.
   */
  it('keeps a departed row in the list, so the reader can still read what ran', () => {
    const feed = fold([snapshot([request()]), snapshot([]), snapshot([]), snapshot([])])
    expect(feed.events).toHaveLength(1)
    expect(feed.events[0].endedAt).toBe(T0 + 1_000)
  })

  /*
   * MARS and long-running requests can be missing from one sample and present in the next.
   *
   * Mutation checked: leaving `endedAt` set when a row reappears leaves the list claiming a query
   * ended while it is visibly still running in the same sample.
   */
  it('un-ends a row that reappears, rather than treating it as a new execution', () => {
    const feed = fold([snapshot([request()]), snapshot([]), snapshot([request()])])
    expect(feed.events).toHaveLength(1)
    expect(feed.observed).toBe(1)
    expect(feed.events[0].endedAt).toBeNull()
    expect(feed.events[0].firstSeenAt).toBe(T0)
  })

  it('counts only rows in the latest sample as running', () => {
    const feed = fold([
      snapshot([request({ sessionId: 51, requestId: 'req:51:0' })]),
      snapshot([request({ sessionId: 52, requestId: 'req:52:0' })]),
    ])
    expect(feed.events).toHaveLength(2)
    expect(feed.running).toBe(1)
    expect(feed.events.find(event => event.sessionId === 52)!.endedAt).toBeNull()
  })
})

describe('a quiet channel is not evidence that anything stopped', () => {
  /*
   * Mutation checked: treating a null snapshot as an empty one ends every row on the page the moment
   * a reconnect drops one poll, which then retires every car and empties the city — a rendering of
   * the browser's network, presented as a rendering of the server.
   */
  it('leaves the feed untouched when no snapshot arrived', () => {
    const withRows = fold([snapshot([request()])])
    const after = advanceQueryFeed(withRows, null, families, T0 + 60_000, SCOPE)
    expect(after).toBe(withRows)
    expect(after.events[0].endedAt).toBeNull()
    expect(after.samples).toBe(1)
  })

  it('starts from an empty feed that says nothing has been sampled yet', () => {
    expect(EMPTY_QUERY_FEED.events).toHaveLength(0)
    expect(EMPTY_QUERY_FEED.samples).toBe(0)
    expect(EMPTY_QUERY_FEED.reason).toMatch(/no live sample has been received/i)
    expect(liveQuerySummaryLabel(EMPTY_QUERY_FEED)).toBe('Awaiting first sample')
  })

  /*
   * Mutation checked: reporting an empty sample with the same sentence as an unopened channel loses
   * the only distinction that matters between "we have not looked" and "we looked and saw nothing".
   */
  it('distinguishes a sample that saw nothing from never having sampled', () => {
    const sampled = fold([snapshot([])])
    expect(sampled.samples).toBe(1)
    expect(sampled.reason).not.toBe(EMPTY_QUERY_FEED.reason)
    expect(sampled.reason).toMatch(/never observed at all/i)
    expect(liveQuerySummaryLabel(sampled)).toBe('None sampled')
  })
})

describe('an idle session is not an execution', () => {
  /*
   * Issue #79 again, one layer up. Mutation checked: dropping the `requestStatus === null` guard
   * fills the feed with every connected application, whether or not it is doing anything.
   */
  it('skips a session holding no request', () => {
    const feed = fold([snapshot([request({ requestStatus: null })])])
    expect(feed.events).toHaveLength(0)
    expect(feed.observed).toBe(0)
  })

  it('lists a session that holds one', () => {
    const feed = fold([snapshot([request({ requestStatus: 'suspended' })])])
    expect(feed.events).toHaveLength(1)
  })
})

describe('what the row says it ran', () => {
  it('prefers the executing statement over the whole batch', () => {
    const feed = fold([snapshot([request()])])
    expect(feed.events[0].text).toBe('SELECT 1')
  })

  it('falls back to the batch only when no statement was isolated', () => {
    const feed = fold([snapshot([request({ currentStatementText: null })])])
    expect(feed.events[0].text).toBe('EXEC dbo.Everything')
  })

  /*
   * Mutation checked: leaving `text` as '' when neither is available renders an empty row, which
   * reads as a query that ran nothing rather than as text the sample could not retrieve.
   */
  it('says why the text is missing rather than showing an empty query', () => {
    const feed = fold([snapshot([request({ currentStatementText: null, batchText: null })])])
    expect(feed.events[0].text).toBeNull()
    expect(feed.events[0].textReason).toMatch(/no statement or batch text/i)
  })

  it('treats whitespace-only text as absent', () => {
    const feed = fold([snapshot([request({ currentStatementText: '   ', batchText: '\n\t' })])])
    expect(feed.events[0].text).toBeNull()
  })

  it('picks up text that a later sample managed to retrieve', () => {
    const feed = fold([
      snapshot([request({ currentStatementText: null, batchText: null })]),
      snapshot([request()]),
    ])
    expect(feed.events[0].text).toBe('SELECT 1')
    expect(feed.events[0].textReason).toBe('')
  })
})

describe('the family is resolved once, in the feed, so the list and the map agree', () => {
  it('matches on query_hash across case and an 0x prefix', () => {
    const feed = fold([snapshot([request({ familyId: '0xaabbccddeeff0011' })])])
    expect(feed.events[0].familyId).toBe(feed.events[0].familyId!.toUpperCase())
    expect(feed.events[0].familyId).toBe('fam-1')
  })

  /*
   * Mutation checked: falling back to `families[0]` on a miss labels every unmatched execution with
   * an unrelated family and then drives its car down that family's road — a caption and a picture
   * that agree with each other and with nothing else.
   */
  it('leaves an unmatched hash unrouted instead of inventing a family', () => {
    const feed = fold([snapshot([request({ familyId: 'FFFF000000000001' })])])
    expect(feed.events[0].familyId).toBeNull()
    expect(feed.reason).toMatch(/matched no query family/i)
  })

  it('rejects the all-zero sentinel rather than matching everything to it', () => {
    const feed = advanceQueryFeed(
      EMPTY_QUERY_FEED,
      snapshot([request({ familyId: '0000000000000000' })]),
      [family({ familyId: '0000000000000000' })],
      T0,
      SCOPE,
    )
    expect(feed.events[0].familyId).toBeNull()
    expect(feed.events[0].familyId).toBeNull()
  })

  /*
   * The catalogue pages in behind the feed, so a family that was absent when the query arrived can
   * become resolvable a sample later.
   *
   * Mutation checked: resolving only on arrival leaves an execution permanently unrouted because of
   * when it happened to turn up relative to a page load, which is not a fact about the workload.
   */
  it('resolves a family that only became available after the row arrived', () => {
    let feed = advanceQueryFeed(EMPTY_QUERY_FEED, snapshot([request()]), [], T0, SCOPE)
    expect(feed.events[0].familyId).toBeNull()
    feed = advanceQueryFeed(feed, snapshot([request()]), families, T0 + 1_000, SCOPE)
    expect(feed.events[0].familyId).toBe('fam-1')
  })

  it('does not un-resolve a family when a later page no longer lists it', () => {
    let feed = advanceQueryFeed(EMPTY_QUERY_FEED, snapshot([request()]), families, T0, SCOPE)
    feed = advanceQueryFeed(feed, snapshot([request()]), [], T0 + 1_000, SCOPE)
    expect(feed.events[0].familyId).toBe('fam-1')
  })

  /*
   * Mutation checked: deriving `hashReported` from `familyId !== null` cannot tell an API build
   * older than the field from an engine that simply did not hash the statement, and the feed then
   * blames the workload for a missing column.
   */
  it('distinguishes an API build older than query_hash from an unhashed statement', () => {
    const older = request()
    delete (older as { familyId?: unknown }).familyId
    const missing = fold([snapshot([older])])
    expect(missing.events[0].hashReported).toBe(false)
    expect(missing.reason).toMatch(/predates the field/i)

    const unhashed = fold([snapshot([request({ familyId: null })])])
    expect(unhashed.events[0].hashReported).toBe(true)
    expect(unhashed.reason).not.toMatch(/predates the field/i)
  })
})

describe('a block is reported on the row, and only on evidence', () => {
  it('does not flag a request that merely holds a lock', () => {
    const feed = fold([snapshot([request()])])
    expect(feed.events[0].blocked).toBe(false)
    expect(feed.blocked).toBe(0)
  })

  it('flags a named blocker', () => {
    const feed = fold([snapshot([request({ blocking: { blockingSessionId: 52, sentinel: 'None' } })])])
    expect(feed.events[0].blocked).toBe(true)
    expect(liveQuerySummaryLabel(feed)).toBe('1 running · 1 blocked')
  })

  it('flags a sentinel with no session behind it', () => {
    const feed = fold([snapshot([
      request({ blocking: { blockingSessionId: null, sentinel: 'OrphanedDistributedTransaction' } }),
    ])])
    expect(feed.events[0].blocked).toBe(true)
  })

  it('clears the flag on the sample that shows the block released', () => {
    const feed = fold([
      snapshot([request({ blocking: { blockingSessionId: 52, sentinel: 'None' } })]),
      snapshot([request()]),
    ])
    expect(feed.events[0].blocked).toBe(false)
  })

  it('does not read blocking_session_id 0 as a blocker', () => {
    /*
     * Zero means "nothing is blocking this" -- sys.dm_exec_requests reports it for every ordinary
     * running request, so a predicate that only checks for null badges the whole sample as blocked.
     * The map could never agree: an unblocked request holds no lock resource, so there was no pin
     * to draw beside the row, and the feed and the city contradicted each other on every sample.
     */
    const feed = fold([snapshot([request({ blocking: { blockingSessionId: 0, sentinel: 'None' } })])])
    expect(feed.events[0].blocked).toBe(false)
    expect(feed.blocked).toBe(0)
    expect(liveQuerySummaryLabel(feed)).toBe('1 running')
  })

  it('does not count a departed row as still blocked', () => {
    const feed = fold([
      snapshot([request({ blocking: { blockingSessionId: 52, sentinel: 'None' } })]),
      snapshot([]),
    ])
    expect(feed.blocked).toBe(0)
    expect(liveQuerySummaryLabel(feed)).toBe('1 seen · none running')
  })
})

describe('the feed is capped, and says what scrolled past', () => {
  function manySamples(count: number) {
    let feed = EMPTY_QUERY_FEED
    for (let index = 0; index < count; index += 1) {
      feed = advanceQueryFeed(
        feed,
        snapshot([request({ sessionId: 100 + index, requestId: `req:${100 + index}:0` })]),
        families,
        T0 + index * 1_000,
        SCOPE,
      )
    }
    return feed
  }

  /*
   * Mutation checked: dropping the `.slice` grows the list without bound, which is a leak on a page
   * meant to be left open, and reports `dropped` as 0 so a truncated feed reads as a complete one.
   */
  it('keeps the newest arrivals and counts the ones it dropped', () => {
    const feed = manySamples(LIVE_QUERY_FEED_CAP + 7)
    expect(feed.events).toHaveLength(LIVE_QUERY_FEED_CAP)
    expect(feed.observed).toBe(LIVE_QUERY_FEED_CAP + 7)
    expect(feed.dropped).toBe(7)
    expect(feed.cap).toBe(LIVE_QUERY_FEED_CAP)
    expect(feed.reason).toMatch(new RegExp(`scrolled past the ${LIVE_QUERY_FEED_CAP}-row cap`))
  })

  it('drops the oldest, not the newest', () => {
    const feed = manySamples(LIVE_QUERY_FEED_CAP + 7)
    const ordinals = feed.events.map(event => event.ordinal)
    expect(ordinals[0]).toBe(LIVE_QUERY_FEED_CAP + 7)
    expect(Math.min(...ordinals)).toBe(8)
  })

  it('does not double-count the same overflow on every later sample', () => {
    const feed = manySamples(LIVE_QUERY_FEED_CAP + 3)
    const settled = advanceQueryFeed(feed, snapshot([]), families, T0 + 1_000_000, SCOPE)
    expect(settled.dropped).toBe(3)
  })
})

/*
 * The live sampler is instance-wide. It has to be: it reads the request DMVs once for the whole
 * server, and there is no per-database subscription to make instead.
 *
 * That made the feed show another database's traffic while claiming to describe this city, which is
 * worse than showing nothing -- the rows are real, so nothing about them looks wrong. It also could
 * not be fixed by clearing the list when the user navigates, which was the obvious first attempt:
 * clearing works for exactly one sample, and then the very next instance-wide sample refills the
 * list with the same foreign rows. The filter has to live in the fold, which is what these pin.
 */
describe('the feed describes one database, not the instance it was sampled from', () => {
  const OTHER = request({ sessionId: 200, requestId: 'req:200:0', databaseName: 'Warehouse' })

  it('keeps only the requests belonging to the scoped database', () => {
    const feed = advanceQueryFeed(
      EMPTY_QUERY_FEED,
      snapshot([request(), OTHER]),
      families,
      T0,
      SCOPE,
    )
    expect(feed.events).toHaveLength(1)
    expect(feed.events[0].databaseName).toBe('Shop')
  })

  /*
   * Mutation checked: dropping the foreign rows silently passes the assertion above and fails this
   * one. A feed that quietly discards half its input while presenting itself as a log of events is
   * the same class of defect as the one being fixed.
   */
  it('discloses how many executions it set aside rather than dropping them silently', () => {
    const feed = advanceQueryFeed(
      EMPTY_QUERY_FEED,
      snapshot([request(), OTHER]),
      families,
      T0,
      SCOPE,
    )
    expect(feed.elsewhere).toBe(1)
    expect(feed.reason).toMatch(/elsewhere|other databases?|another database/i)
  })

  it('matches the database name without regard to case, as SQL Server does', () => {
    const feed = advanceQueryFeed(
      EMPTY_QUERY_FEED,
      snapshot([request({ databaseName: 'sHoP' })]),
      families,
      T0,
      SCOPE,
    )
    expect(feed.events).toHaveLength(1)
    expect(feed.elsewhere).toBe(0)
  })

  /*
   * A request whose database the DMV did not report cannot be claimed for this city. Admitting it
   * would put an unattributable row in a list whose whole purpose is to say "this happened here".
   */
  it('sets aside a request whose database is unnamed instead of assuming it is local', () => {
    const feed = advanceQueryFeed(
      EMPTY_QUERY_FEED,
      snapshot([request({ databaseName: null })]),
      families,
      T0,
      SCOPE,
    )
    expect(feed.events).toHaveLength(0)
    expect(feed.elsewhere).toBe(1)
  })

  /*
   * The reason a null scope is spelled out as its own case rather than left to a default: it is the
   * unfiltered instance-wide feed, i.e. the original bug. Keeping it reachable but explicit means a
   * caller has to ask for it, and cannot re-acquire it by forgetting an argument.
   */
  it('admits every database when the scope names none', () => {
    const feed = advanceQueryFeed(
      EMPTY_QUERY_FEED,
      snapshot([request(), OTHER]),
      families,
      T0,
      { databaseName: null },
    )
    expect(feed.events).toHaveLength(2)
    expect(feed.elsewhere).toBe(0)
  })

  /*
   * The navigation case, end to end: rows collected under one city must not survive into the next
   * one. This is the user-visible bug -- "the live query window doesn't reset when I go to a new
   * database city so it is showing queries from the wrong database".
   */
  it('does not carry rows from the previous city into the next one', () => {
    const shop = advanceQueryFeed(EMPTY_QUERY_FEED, snapshot([request()]), families, T0, SCOPE)
    expect(shop.events).toHaveLength(1)

    const moved = advanceQueryFeed(
      EMPTY_QUERY_FEED,
      snapshot([request()]),
      families,
      T0 + 1_000,
      { databaseName: 'Warehouse' },
    )
    expect(moved.events).toHaveLength(0)
    expect(moved.elsewhere).toBe(1)
  })
})

/**
 * Helpers for the plan-cache half of the feed.
 *
 * These build a snapshot carrying both sources, because the whole point of the fold is that they
 * arrive together and land in one list.
 */
function completed(over: Partial<CompletedQuery> = {}): CompletedQuery {
  return {
    planKey: 'a'.repeat(64),
    executions: 1,
    firstObservation: false,
    lastExecutionAt: '2024-01-01T00:00:03Z',
    lastElapsedTimeUs: 2_000,
    lastWorkerTimeUs: 1_000,
    lastLogicalReads: 8,
    lastRows: 1,
    databaseId: 5,
    databaseName: 'Shop',
    statementText: 'SELECT 2',
    familyId: 'AABBCCDDEEFF0011',
    queryPlanHash: null,
    ...over,
  }
}

function completedSample(
  queries: CompletedQuery[],
  over: Partial<CompletedQuerySample> = {},
): CompletedQuerySample {
  return {
    queries,
    plansAdvanced: queries.length,
    totalExecutions: queries.reduce((sum, query) => sum + query.executions, 0),
    watermarkEngineLocal: '2024-01-01T00:00:03Z',
    intervalMs: 3_000,
    status: 'Available',
    reason: 'read',
    ...over,
  }
}

/** A snapshot carrying both sources. */
function both(requests: LiveRequest[], sample: CompletedQuerySample | null): LiveIncidentSnapshot {
  return { requests, completedQueries: sample ?? undefined } as LiveIncidentSnapshot
}

describe('finished queries and running ones are one list, not two', () => {
  /*
   * The reason this source exists at all. Mutation checked: dropping the plan-cache pass leaves the
   * feed with only the request rows, which is the ~2%-of-the-workload view that motivated the change.
   */
  it('admits an execution that no request sample ever caught', () => {
    const feed = fold([both([], completedSample([completed()]))])
    expect(feed.events).toHaveLength(1)
    expect(feed.events[0].source).toBe('plan-cache')
    expect(feed.executions).toBe(1)
  })

  /*
   * The user asked for one combined view rather than a "live" and a "completed" section. Both
   * sources therefore share one ordinal sequence and one sort, so a finished query and a running one
   * interleave by arrival like any other two rows.
   *
   * Mutation checked: appending plan-cache events after the sort, or giving them a separate ordinal
   * counter, puts every finished query below every running one regardless of when it turned up.
   */
  it('interleaves both sources by arrival rather than grouping them', () => {
    const feed = fold([
      both([request({ requestId: 'req:51:0' })], null),
      both([request({ requestId: 'req:51:0' })], completedSample([completed({ familyId: null })])),
      both([request({ sessionId: 52, requestId: 'req:52:0', familyId: null })], null),
    ])
    expect(feed.events.map(event => event.source)).toEqual([
      'sampled-request',
      'plan-cache',
      'sampled-request',
    ])
  })

  /*
   * A plan-cache row describes executions that had already finished when they were read, so there is
   * no departure left to observe. Retiring it on the next sample would re-create exactly the
   * completed-versus-live distinction this list exists to remove -- and would do it by dimming every
   * such row one sample after it appeared.
   *
   * Mutation checked: removing the `source === 'plan-cache'` guard from the merge loop marks every
   * one of them "gone" on the very next fold.
   */
  it('never marks a finished query as having departed', () => {
    const feed = fold([
      both([], completedSample([completed()])),
      both([], completedSample([], { watermarkEngineLocal: '2024-01-01T00:00:06Z' })),
      both([], completedSample([], { watermarkEngineLocal: '2024-01-01T00:00:09Z' })),
    ])
    expect(feed.events).toHaveLength(1)
    expect(feed.events[0].endedAt).toBeNull()
  })

  /*
   * `running` drives the collapsed drawer summary. A plan-cache row has already finished, so counting
   * it would report an idle instance as busy -- and it has `endedAt === null` precisely because of
   * the guard above, so the naive count is the one that goes wrong.
   *
   * Mutation checked: counting every `endedAt === null` event reports 1 running here.
   */
  it('does not count a finished query as running', () => {
    const feed = fold([both([], completedSample([completed()]))])
    expect(feed.running).toBe(0)
    expect(liveQuerySummaryLabel(feed)).toBe('1 execution seen')
  })
})

describe('a cumulative counter is not an execution count', () => {
  /*
   * One row can stand for several executions, and the summary has to say so or a busy instance reads
   * as a quiet one. Mutation checked: reporting `events.length` instead of summing `executions`
   * says 1 where the engine ran the query four times.
   */
  it('reports executions rather than rows when a plan ran more than once', () => {
    const feed = fold([both([], completedSample([completed({ executions: 4 })]))])
    expect(feed.events[0].executions).toBe(4)
    expect(feed.executions).toBe(4)
    expect(feed.observed).toBe(1)
    expect(feed.reason).toMatch(/accounting for 4 executions/i)
  })

  /*
   * A first observation is a floor, not a measurement, and the row is flagged so the UI can mark it.
   * Mutation checked: dropping `executionsEstimated` renders "4×" identically whether the number was
   * differenced or assumed.
   */
  it('carries the estimated flag through from a first observation', () => {
    const feed = fold([both([], completedSample([completed({ executions: 1, firstObservation: true })]))])
    expect(feed.events[0].executionsEstimated).toBe(true)
  })
})

describe('one execution is one car', () => {
  /*
   * A query slow enough to be caught mid-flight will also advance the plan cache when it finishes.
   * Admitting both puts two rows -- and two cars -- on the map for one execution.
   *
   * Mutation checked: removing the `arrivedHashes` subtraction yields two events for one query.
   */
  it('does not list a query twice when both sources report it in one sample', () => {
    const feed = fold([both([request()], completedSample([completed()]))])
    expect(feed.events).toHaveLength(1)
    expect(feed.events[0].source).toBe('sampled-request')
  })

  /*
   * The subtraction is partial, not all-or-nothing: a plan that ran four times while one of those
   * executions was caught mid-flight still has three the request list never saw. Discarding the
   * whole row would lose them.
   *
   * Mutation checked: skipping the row whenever the hash overlaps at all drops three real executions.
   */
  it('keeps the executions a caught request does not account for', () => {
    const feed = fold([both([request()], completedSample([completed({ executions: 4 })]))])
    expect(feed.events).toHaveLength(2)
    const planRow = feed.events.find(event => event.source === 'plan-cache')
    expect(planRow?.executions).toBe(3)
  })
})

describe('the same plan running again is a new arrival', () => {
  /*
   * Keying a plan-cache row on the plan alone folds every later interval into the row that arrived
   * first -- which then keeps its original arrival time, so a hot plan appears once and the feed
   * looks frozen while the instance churns. This is the plan-cache form of the session-reuse trap
   * the request identity already guards against.
   *
   * Mutation checked: dropping the watermark from `completedEventId` produces one event for three
   * intervals.
   */
  it('lists each interval a hot plan advanced in', () => {
    const feed = fold([
      both([], completedSample([completed()], { watermarkEngineLocal: '2024-01-01T00:00:03Z' })),
      both([], completedSample([completed()], { watermarkEngineLocal: '2024-01-01T00:00:06Z' })),
      both([], completedSample([completed()], { watermarkEngineLocal: '2024-01-01T00:00:09Z' })),
    ])
    expect(feed.events).toHaveLength(3)
    expect(new Set(feed.events.map(event => event.id)).size).toBe(3)
  })

  /*
   * The identity is the engine's own watermark, so folding the same sample twice -- a re-render, a
   * retry, a duplicated poll -- cannot double the list.
   */
  it('is idempotent when the same sample is folded twice', () => {
    const sample = both([], completedSample([completed()]))
    const feed = fold([sample, sample])
    expect(feed.events).toHaveLength(1)
  })
})

describe('the plan cache is instance-wide and bursty', () => {
  /*
   * Scope applies to both sources or the fix for the wrong-city feed only half works.
   * Mutation checked: skipping the scope test on plan-cache rows refills the list from neighbouring
   * databases the moment you switch cities.
   */
  it('drops and counts a finished query from another database', () => {
    const feed = fold([both([], completedSample([completed({ databaseName: 'Warehouse' })]))])
    expect(feed.events).toHaveLength(0)
    expect(feed.elsewhere).toBe(1)
  })

  /*
   * A measured three-second window advanced 103 distinct plans. Without a per-sample cap that single
   * sample replaces the entire 60-row list nearly twice over, so nothing stays on screen long enough
   * to read.
   *
   * Mutation checked: removing the burst cap admits all 103.
   */
  it('caps how many finished queries one sample may contribute', () => {
    const many = Array.from({ length: 103 }, (_, index) =>
      completed({ planKey: `${index}`.padStart(64, '0'), familyId: null }))
    const feed = fold([both([], completedSample(many))])
    expect(feed.events).toHaveLength(LIVE_QUERY_ARRIVAL_BURST_CAP)
  })

  /*
   * The cut is by recency, which is the order the collector returns. Taking the busiest or costliest
   * plans instead would make this the leaderboard the module comment says it is not.
   */
  it('keeps the most recently executed plans rather than the busiest', () => {
    const feed = fold([both([], completedSample([
      completed({ planKey: 'recent'.padStart(64, '0'), executions: 1, familyId: null }),
      ...Array.from({ length: LIVE_QUERY_ARRIVAL_BURST_CAP }, (_, index) =>
        completed({ planKey: `${index}`.padStart(64, '0'), executions: 500, familyId: null })),
    ]))])
    expect(feed.events.map(event => event.id)).toContain(`plan|${'recent'.padStart(64, '0')}|2024-01-01T00:00:03Z`)
  })
})

describe('a missing plan-cache source says so', () => {
  /*
   * An API build older than this field carries no `completedQueries` at all, which looks identical to
   * a quiet instance. The two claims are very different and the reason has to separate them.
   */
  it('distinguishes an absent source from a source that read nothing', () => {
    const absent = fold([both([], null)])
    expect(absent.completedStatus).toBeNull()
    expect(absent.reason).toMatch(/no plan-cache reading at all/i)

    const read = fold([both([], completedSample([]))])
    expect(read.completedStatus).toBe('Available')
    expect(read.reason).toMatch(/no cached plan advanced its counter/i)
    expect(read.reason).not.toMatch(/no plan-cache reading at all/i)
  })

  /*
   * A failed read is neither of the above, and saying nothing would let a permissions problem read as
   * an idle server.
   */
  it('reports a failed read as a failure rather than as silence', () => {
    const feed = fold([both([], completedSample([], {
      status: 'PermissionDenied',
      reason: 'VIEW SERVER STATE is required.',
    }))])
    expect(feed.reason).toMatch(/PermissionDenied/)
    expect(feed.reason).toMatch(/VIEW SERVER STATE is required/)
  })
})