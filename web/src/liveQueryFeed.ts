import { normalizeHash } from './cityVehicles'
import type { DatabaseCityQueryFamily } from './databaseCityContracts'
import type { LiveIncidentSnapshot, LiveRequest } from './liveContracts'

/**
 * The running list of individual query executions, folded out of successive live samples.
 *
 * Everything else this map says about the workload is an aggregate — a query *family*, which is
 * Query Store's rollup of every execution that shared a `query_hash` over the retained window. This
 * is the other thing: one row of `sys.dm_exec_requests`, one execution, the moment this browser
 * first saw it. The two are never blended, and the feed is deliberately not a leaderboard: it is
 * ordered by when a query turned up and by nothing else, so a cheap query appears exactly as
 * prominently as an expensive one.
 *
 * Four properties are load-bearing, and every one of them is a way this could quietly lie:
 *
 * - **An arrival is when *this browser* first sampled the execution, not when the query started.**
 *   `sys.dm_exec_requests.start_time` is carried through as {@link LiveQueryEvent.startedAt} and is
 *   frequently much older: a statement that has been running for an hour arrives in the feed the
 *   instant you open the page. The list is a log of observations, and the row says so by showing
 *   both times.
 * - **A departure is "no longer sampled", never "finished successfully".** A commit, a rollback, a
 *   `KILL` and a lost connection all leave the sample identically, and nothing in the DMVs
 *   distinguishes them after the fact. {@link LiveQueryEvent.endedAt} means the request was gone
 *   from the next sample and claims nothing else.
 * - **The sampler is periodic, so the feed has holes it cannot see.** The collector runs on a 2–5 s
 *   cadence; an execution that begins and finishes between two samples is never observed at all and
 *   therefore never appears. An empty feed means nothing was *sampled*, which is not the same claim
 *   as an idle instance, and {@link LiveQueryFeed.reason} carries that distinction rather than
 *   leaving a reader to guess it.
 * - **Identity is the session, the request and the start time together.** SQL Server reuses both
 *   session ids and per-session request ids as connections come and go, so either alone would
 *   silently fold two unrelated executions into one row — and would then keep the *first* one's
 *   arrival time, which is the failure that makes a feed look calm while the instance is churning.
 */

/** How many observations the feed keeps. Older arrivals fall off the bottom; nothing else evicts. */
export const LIVE_QUERY_FEED_CAP = 60

/**
 * One observed execution.
 *
 * Mutated in place across samples only in the fields that genuinely change while a request runs —
 * its statement within a batch, its wait, its elapsed and CPU time, whether it is blocked. Identity,
 * arrival and ordering are written once and never revised, because those are what the reader is
 * using to tell one row from another.
 */
export interface LiveQueryEvent {
  readonly id: string
  /**
   * Arrival order across the whole session, ascending and never reused.
   *
   * The list is sorted on this rather than on a timestamp because several executions routinely
   * arrive in the same sample and would then share a millisecond. A monotonic counter keeps them in
   * the order the sample listed them instead of shuffling equal timestamps on every re-render.
   */
  readonly ordinal: number
  readonly sessionId: number
  /** The collector's synthetic request key (`req:<session>:<request_id>`), carried verbatim. */
  readonly requestId: string
  /** `sys.dm_exec_requests.start_time`. Older than {@link firstSeenAt} whenever the query predates this page. */
  readonly startedAt: string | null
  /** Epoch ms at which this browser first sampled the execution. Never a claim about the engine's clock. */
  readonly firstSeenAt: number
  /** Epoch ms of the most recent sample that still carried it. */
  readonly lastSeenAt: number
  /** Epoch ms of the first sample that no longer carried it, or null while it is still being sampled. */
  readonly endedAt: number | null
  readonly databaseName: string | null
  readonly command: string | null
  /** The statement being executed, or the whole batch when no statement was isolated. */
  readonly text: string | null
  /** Why {@link text} is null. Never omitted, so an absent statement is never read as an empty query. */
  readonly textReason: string
  /** `query_hash` normalized for comparison, or null when the engine reported none. */
  readonly queryHash: string | null
  /** The family this execution belongs to, or null when its hash matched no family on this page. */
  readonly familyId: string | null
  /**
   * False when the sampled row carried no `query_hash` **field** at all.
   *
   * That is what an API build older than the field looks like, and it produces a feed in which
   * nothing can ever be matched to a family — indistinguishable from a page whose families simply
   * do not cover the workload unless it is reported separately.
   */
  readonly hashReported: boolean
  readonly blocked: boolean
  readonly waitType: string | null
  readonly elapsedMs: number | null
  readonly cpuMs: number | null
}

export interface LiveQueryFeed {
  /** Newest arrival first. Capped at {@link LiveQueryFeed.cap}. */
  readonly events: readonly LiveQueryEvent[]
  readonly cap: number
  /** Arrivals observed since this view opened, before the cap. */
  readonly observed: number
  /** Arrivals the cap has since dropped off the bottom. */
  readonly dropped: number
  /** Events still present in the most recent sample. */
  readonly running: number
  /** Of those, the ones a live block has stopped. */
  readonly blocked: number
  /** The next ordinal to hand out. Carried so a fold never has to scan the list to find it. */
  readonly nextOrdinal: number
  /** How many samples have been folded in. Zero means nothing has been observed yet. */
  readonly samples: number
  /** Why the feed looks the way it does, in plain language. Never omitted. */
  readonly reason: string
}

export const EMPTY_QUERY_FEED: LiveQueryFeed = {
  events: [],
  cap: LIVE_QUERY_FEED_CAP,
  observed: 0,
  dropped: 0,
  running: 0,
  blocked: 0,
  nextOrdinal: 1,
  samples: 0,
  reason: 'No live sample has been received, so nothing is claimed about what is running now.',
}

const NO_TEXT_REASON =
  'The sample returned no statement or batch text for this request, so what it ran is not known here.'

/**
 * Folds one live sample into the feed.
 *
 * Pure, and total: a null snapshot returns the feed unchanged rather than clearing it, because
 * "the channel went quiet" is not evidence that anything stopped. The connection state is reported
 * beside the feed and is the thing that says the channel is down.
 *
 * `now` is passed in rather than read from a clock so the fold is testable and so every event in
 * one sample shares an arrival instant.
 */
export function advanceQueryFeed(
  previous: LiveQueryFeed,
  snapshot: LiveIncidentSnapshot | null,
  families: readonly DatabaseCityQueryFamily[],
  now: number,
): LiveQueryFeed {
  if (!snapshot) return previous

  const familyByHash = new Map<string, DatabaseCityQueryFamily>()
  for (const family of families) {
    const key = normalizeHash(family.queryHash)
    if (key && !familyByHash.has(key)) familyByHash.set(key, family)
  }

  const carried = new Map(previous.events.map(event => [event.id, event]))
  const present = new Set<string>()
  let ordinal = previous.nextOrdinal
  let observed = previous.observed
  const arrived: LiveQueryEvent[] = []

  for (const request of snapshot.requests) {
    // Idle sessions are sampled on purpose and hold no request. They are not executions.
    if (request.requestStatus === null || request.requestStatus === undefined) continue

    const id = queryEventId(request)
    if (present.has(id)) continue
    present.add(id)

    const hashReported = request.queryHash !== undefined
    const queryHash = normalizeHash(request.queryHash ?? null)
    const family = queryHash ? familyByHash.get(queryHash) ?? null : null
    const existing = carried.get(id)

    if (existing) {
      carried.set(id, {
        ...existing,
        lastSeenAt: now,
        // A request that reappears after a sample without it is the same execution still running,
        // not a new one: identity already fixed that. Clearing the end is what keeps the row honest.
        endedAt: null,
        text: statementText(request) ?? existing.text,
        textReason: statementText(request) === null ? existing.textReason : '',
        // Re-resolved every sample because pages of the catalogue are still loading behind this,
        // so a family that was not on the page when the query arrived can become resolvable later.
        familyId: family?.familyId ?? existing.familyId,
        blocked: isBlocked(request),
        waitType: request.waitType,
        elapsedMs: request.totalElapsedMs,
        cpuMs: request.cpuTimeMs,
      })
      continue
    }

    const text = statementText(request)
    const event: LiveQueryEvent = {
      id,
      ordinal,
      sessionId: request.sessionId,
      requestId: request.requestId,
      startedAt: request.requestStartTime,
      firstSeenAt: now,
      lastSeenAt: now,
      endedAt: null,
      databaseName: request.databaseName,
      command: request.command,
      text,
      textReason: text === null ? NO_TEXT_REASON : '',
      queryHash,
      familyId: family?.familyId ?? null,
      hashReported,
      blocked: isBlocked(request),
      waitType: request.waitType,
      elapsedMs: request.totalElapsedMs,
      cpuMs: request.cpuTimeMs,
    }
    ordinal += 1
    observed += 1
    arrived.push(event)
  }

  const merged: LiveQueryEvent[] = []
  for (const event of carried.values()) {
    if (present.has(event.id) || event.endedAt !== null) {
      merged.push(event)
      continue
    }
    // Gone from this sample. That is all it means; see the module comment.
    merged.push({ ...event, endedAt: now })
  }
  merged.push(...arrived)
  merged.sort((left, right) => right.ordinal - left.ordinal)

  const events = merged.slice(0, LIVE_QUERY_FEED_CAP)
  const running = events.filter(event => event.endedAt === null).length
  const blocked = events.filter(event => event.endedAt === null && event.blocked).length
  const dropped = previous.dropped + Math.max(0, merged.length - events.length)
  const samples = previous.samples + 1
  return {
    events,
    cap: LIVE_QUERY_FEED_CAP,
    observed,
    dropped,
    running,
    blocked,
    nextOrdinal: ordinal,
    samples,
    reason: feedReason({
      shown: events.length,
      observed,
      dropped,
      running,
      samples,
      hashReported: events.some(event => event.hashReported),
      unmatched: events.filter(event => event.familyId === null).length,
    }),
  }
}

/**
 * The identity of one execution.
 *
 * All three parts are needed. `requestId` is `req:<session>:<request_id>` and SQL Server reuses
 * `request_id` within a session as batches come and go, so on its own it folds a session's
 * successive statements into a single row that never scrolls. Adding `start_time` separates them,
 * and it is the engine's own value rather than anything invented here.
 */
export function queryEventId(request: LiveRequest): string {
  return `${request.sessionId}|${request.requestId}|${request.requestStartTime ?? ''}`
}

/** Only a *blocked* request is stopped. Holding a lock nobody waits behind is just work. */
function isBlocked(request: LiveRequest): boolean {
  return request.blocking.blockingSessionId !== null || request.blocking.sentinel !== 'None'
}

/**
 * The statement, falling back to the whole batch.
 *
 * `currentStatementText` is the one statement of a batch that was executing when the sample was
 * taken, which is what a per-execution feed is about. The batch is a strictly weaker answer, so it
 * is used only when the engine isolated no statement — never merged with it.
 */
function statementText(request: LiveRequest): string | null {
  const statement = request.currentStatementText?.trim()
  if (statement) return statement
  const batch = request.batchText?.trim()
  return batch ? batch : null
}

/**
 * What the feed is allowed to say about itself.
 *
 * The case this exists for is an empty list, which has three causes a reader cannot tell apart by
 * looking: nothing has been sampled yet, nothing was running when the sampler last looked, or
 * everything that ran did so between two samples. Only the second is "the instance is quiet", and
 * even that is a statement about the sampled instants and not about the interval between them.
 */
function feedReason(counts: {
  shown: number
  observed: number
  dropped: number
  running: number
  samples: number
  hashReported: boolean
  unmatched: number
}): string {
  const parts: string[] = []
  if (counts.samples === 0) {
    return EMPTY_QUERY_FEED.reason
  }
  if (counts.observed === 0) {
    parts.push(
      'No request has been running in any sample so far. The collector samples every few seconds, so a query that starts and finishes between two samples is never observed at all — an empty feed is a gap in the sampling, not proof of an idle instance.',
    )
  } else {
    parts.push(
      `${counts.shown} of ${counts.observed} observed ${plural(counts.observed, 'execution')} listed, ${counts.running} still in the latest sample.`,
    )
  }
  if (counts.dropped > 0) {
    parts.push(`${counts.dropped} older ${plural(counts.dropped, 'arrival')} scrolled past the ${LIVE_QUERY_FEED_CAP}-row cap.`)
  }
  if (counts.observed > 0 && !counts.hashReported) {
    parts.push(
      'This snapshot carries no query_hash at all — it came from an API build that predates the field — so nothing here can be matched to a query family or driven onto a road.',
    )
  } else if (counts.unmatched > 0) {
    parts.push(
      `${counts.unmatched} matched no query family on this page, so ${plural(counts.unmatched, 'it is', 'they are')} listed without a route.`,
    )
  }
  parts.push(
    'Arrival is when this browser first sampled the execution, not when the query started; a row leaving the list means it was gone from the next sample, not that it succeeded.',
  )
  return parts.join(' ')
}

function plural(count: number, one: string, many?: string): string {
  return count === 1 ? one : (many ?? `${one}s`)
}

/** The folded, one-line summary for the drawer's closed state. Never "idle" unless that was measured. */
export function liveQuerySummaryLabel(feed: LiveQueryFeed): string {
  if (feed.samples === 0) return 'Awaiting first sample'
  if (feed.blocked > 0) return `${feed.running} running · ${feed.blocked} blocked`
  if (feed.running > 0) return `${feed.running} running`
  if (feed.observed > 0) return `${feed.observed} seen · none running`
  return 'None sampled'
}
