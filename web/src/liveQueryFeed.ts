import { normalizeHash } from './cityVehicles'
import type { DatabaseCityQueryFamily } from './databaseCityContracts'
import type { CompletedQuery, DataStatus, LiveIncidentSnapshot, LiveRequest } from './liveContracts'
import { isBlockedReference } from './liveIncidents'

/**
 * The running list of individual query executions, folded out of successive live samples.
 *
 * Everything else this map says about the workload is an aggregate — a query *family*, which is
 * Query Store's rollup of every execution that shared a `query_hash` over the retained window. This
 * is the other thing: individual executions, in the order this browser learned of them. The two are
 * never blended, and the feed is deliberately not a leaderboard: it is ordered by when a query
 * turned up and by nothing else, so a cheap query appears exactly as prominently as an expensive one.
 *
 * **Two sources, one list.** An execution reaches this feed either by being caught mid-flight in
 * `sys.dm_exec_requests`, or by advancing a counter in the plan cache and being read afterwards.
 * They are separate on the wire because they are separate DMVs with different shapes, and they are
 * deliberately *not* separate here: the list has no sections, no split counts and no per-source
 * badge. "Still running" versus "finished a moment ago" is not a distinction a reader of this page
 * is trying to make, and presenting it as one would imply the second class is less real.
 *
 * The second source is not a refinement, it is most of the workload. Measured against a churning
 * AdventureWorks instance, twelve samples 250ms apart across three seconds caught **8** request rows
 * in total, while the plan cache recorded **364** executions over the same three seconds. A feed
 * built on request sampling alone therefore sees roughly 2% of what happens, and short OLTP queries
 * — the overwhelming majority — are invisible to it not by accident but by construction.
 *
 * Properties that are load-bearing, and every one of them is a way this could quietly lie:
 *
 * - **An arrival is when *this browser* first learned of the execution, not when the query ran.**
 *   `sys.dm_exec_requests.start_time` is carried through as {@link LiveQueryEvent.startedAt} and is
 *   frequently much older: a statement that has been running for an hour arrives in the feed the
 *   instant you open the page. A plan-cache row is older still — it describes executions that had
 *   already finished before the sample was taken. The list is a log of observations, and the row
 *   says so by showing both times.
 * - **A departure is "no longer sampled", never "finished successfully".** A commit, a rollback, a
 *   `KILL` and a lost connection all leave the sample identically, and nothing in the DMVs
 *   distinguishes them after the fact. {@link LiveQueryEvent.endedAt} means the request was gone
 *   from the next sample and claims nothing else. It is null for plan-cache rows throughout: those
 *   executions were complete before they arrived, so there is no departure to observe.
 * - **One plan-cache row can stand for several executions.** The engine reports a cumulative
 *   counter, so the collector differences it; {@link LiveQueryEvent.executions} is the result. A
 *   busy plan therefore contributes one readable row saying it ran four times, not four rows that
 *   look like four unrelated queries.
 * - **The sampler is periodic, and the plan cache is lossy.** The collector runs on a 2–5 s cadence.
 *   Request sampling misses anything that begins and ends between two samples; the plan cache
 *   catches most of that, but not a statement compiled with `OPTION (RECOMPILE)`, not ad-hoc text
 *   that was stubbed rather than cached, not a natively compiled procedure, and not a plan evicted
 *   between two reads. An empty feed still means nothing was *observed*, which remains a weaker
 *   claim than an idle instance, and {@link LiveQueryFeed.reason} carries the distinction rather
 *   than leaving a reader to guess it.
 * - **Identity differs by source.** A sampled request is the session, the request and the start time
 *   together: SQL Server reuses both session ids and per-session request ids as connections come and
 *   go, so either alone would silently fold two unrelated executions into one row — and would then
 *   keep the *first* one's arrival time, which is the failure that makes a feed look calm while the
 *   instance is churning. A plan-cache row is the plan key and the sample it came from, so the same
 *   plan running again in a later interval is a new arrival rather than a mutation of the old one.
 * - **The feed is scoped to one database: the city you are looking at.** The live sampler is
 *   instance-wide — neither DMV has any idea which city is on screen — so an unscoped fold lists
 *   every execution on the server. That is not a cosmetic surplus. Every other claim on this page is
 *   about *this* database, the roads a car can drive on were drawn from *this* database's query
 *   families, and a row from a neighbouring database is an execution whose objects are not on the
 *   map and never will be. It also made switching cities look like the feed had failed to reset:
 *   the list did clear, and then refilled from the same instance-wide sample. See {@link
 *   LiveQueryFeedScope}.
 */

/** How many observations the feed keeps. Older arrivals fall off the bottom; nothing else evicts. */
export const LIVE_QUERY_FEED_CAP = 60

/**
 * How many plan-cache arrivals one sample may contribute.
 *
 * The plan cache does not have the request list's natural scarcity. Measured against a churning
 * AdventureWorks instance, one three-second window advanced 103 distinct plans; admitting all of
 * them would replace the entire {@link LIVE_QUERY_FEED_CAP}-row list twice over in a single sample,
 * so nothing would ever stay on screen long enough to read and every car would be spawned and
 * discarded in the same breath.
 *
 * The cut is by recency — the plans that ran most recently — and deliberately *not* by execution
 * count or cost. Taking the busiest or most expensive plans would turn this list into the
 * leaderboard the module comment says it is not, and would permanently hide the cheap one-off query
 * that is often the interesting one.
 */
export const LIVE_QUERY_ARRIVAL_BURST_CAP = 12

/**
 * Where the feed learned about an execution.
 *
 * This is recorded because the two sources support different claims, not so the list can be split
 * in two. A reader is not meant to care whether a query was caught mid-flight or read from the plan
 * cache afterwards — both are "this ran" — and the list is deliberately not sectioned or badged by
 * it. What the field is for is keeping the *derived* numbers honest: a plan-cache row was never
 * running in this browser's view, so counting it as running would misreport an idle instance as a
 * busy one.
 */
export type LiveQuerySource = 'sampled-request' | 'plan-cache'

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
  readonly source: LiveQuerySource
  /**
   * How many executions this row stands for.
   *
   * Always 1 for a sampled request, which is one execution by construction. A plan-cache row can be
   * more: the collector differences a cumulative counter, so "this plan ran 4 times since the last
   * sample" arrives as one row carrying 4 rather than as four rows the reader cannot tell apart.
   * Collapsing them is what keeps a 364-execution interval readable.
   */
  readonly executions: number
  /**
   * True when the count above is the evidenced floor rather than a measurement — the first time this
   * browser saw the plan, when there was no earlier counter to difference against.
   */
  readonly executionsEstimated: boolean
  /**
   * Arrival order across the whole session, ascending and never reused.
   *
   * The list is sorted on this rather than on a timestamp because several executions routinely
   * arrive in the same sample and would then share a millisecond. A monotonic counter keeps them in
   * the order the sample listed them instead of shuffling equal timestamps on every re-render.
   */
  readonly ordinal: number
  /** The engine session, or null for a plan-cache row: the executions are historical and no session is attributable. */
  readonly sessionId: number | null
  /** The collector's synthetic request key (`req:<session>:<request_id>`), or null for a plan-cache row. */
  readonly requestId: string | null
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
  /** Events still present in the most recent sample. Sampled requests only — a plan-cache row was never running. */
  readonly running: number
  /**
   * Executions learned from the plan cache since this view opened, summed across rows.
   *
   * Larger than the number of plan-cache rows whenever a plan ran more than once between two
   * samples, and that gap is the point: it is the difference between "12 queries turned up" and "12
   * queries accounting for 364 executions". Reported separately from {@link observed} because
   * {@link events} is a list of arrivals, and an arrival is not an execution.
   */
  readonly executions: number
  /**
   * Status of the plan-cache source in the latest sample, or null when the snapshot carried no such
   * field at all — an API build older than the source. Null and "unavailable" are different claims
   * and {@link reason} reports them differently: one is a capability the server does not have, the
   * other a read that failed.
   */
  readonly completedStatus: DataStatus | null
  /** Of those, the ones a live block has stopped. */
  readonly blocked: number
  /** The next ordinal to hand out. Carried so a fold never has to scan the list to find it. */
  readonly nextOrdinal: number
  /** How many samples have been folded in. Zero means nothing has been observed yet. */
  readonly samples: number
  /**
   * Executions in the latest sample that were running against some *other* database on the instance.
   *
   * Reported rather than silently discarded, and reported as "this sample" rather than accumulated,
   * because it is the one number that separates "the instance is quiet" from "the instance is busy
   * and none of it is here". A city with an empty feed beside a busy neighbour is a real and
   * interesting state; a feed that just showed nothing would misreport it as an idle server.
   */
  readonly elsewhere: number
  /** Why the feed looks the way it does, in plain language. Never omitted. */
  readonly reason: string
}

/**
 * Which database's executions belong in the feed.
 *
 * `databaseName` is matched against `sys.dm_exec_requests`' database, case-insensitively: a database
 * name is an identifier under the server's collation, and the two spellings reaching this comparison
 * come from different places — one from the atlas route, one from the live collector — so treating
 * `SimCityLoad` and `simcityload` as different cities would empty the feed for reasons the reader
 * could never see.
 *
 * A null scope means "do not filter". That is not a convenience default: it is what a caller that
 * genuinely has no database to scope to must pass, and it is deliberately explicit so that adding a
 * second caller cannot re-acquire the instance-wide feed by simply forgetting an argument.
 */
export interface LiveQueryFeedScope {
  readonly databaseName: string | null
}

export const EMPTY_QUERY_FEED: LiveQueryFeed = {
  events: [],
  cap: LIVE_QUERY_FEED_CAP,
  observed: 0,
  dropped: 0,
  running: 0,
  executions: 0,
  completedStatus: null,
  blocked: 0,
  nextOrdinal: 1,
  samples: 0,
  elsewhere: 0,
  reason: 'No live sample has been received, so nothing is claimed about what is running now.',
}

const NO_TEXT_REASON =
  'The sample returned no statement or batch text for this request, so what it ran is not known here.'

const NO_COMPLETED_TEXT_REASON =
  'The plan cache returned no statement text for this execution, so what it ran is not known here. Text collection may be off, or the edge connector may have stripped it before it left the network.'

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
  scope: LiveQueryFeedScope,
): LiveQueryFeed {
  if (!snapshot) return previous

  const familyByHash = new Map<string, DatabaseCityQueryFamily>()
  for (const family of families) {
    const key = normalizeHash(family.queryHash)
    if (key && !familyByHash.has(key)) familyByHash.set(key, family)
  }

  const wanted = scope.databaseName?.trim().toLowerCase() ?? null

  const carried = new Map(previous.events.map(event => [event.id, event]))
  const present = new Set<string>()
  let ordinal = previous.nextOrdinal
  let observed = previous.observed
  let elsewhere = 0
  const arrived: LiveQueryEvent[] = []

  for (const request of snapshot.requests) {
    // Idle sessions are sampled on purpose and hold no request. They are not executions.
    if (request.requestStatus === null || request.requestStatus === undefined) continue

    /*
     * Executions on another database are counted and dropped.
     *
     * A request whose database the sample did not name is dropped too, and counted the same way. It
     * cannot be shown to belong to this city, and the whole point of the scope is that a row in this
     * list is an execution against the database on screen -- admitting the unnamed ones would make
     * that true of most rows rather than all of them, which is the sort of "mostly" this codebase
     * does not ship.
     */
    if (wanted !== null && request.databaseName?.trim().toLowerCase() !== wanted) {
      elsewhere += 1
      continue
    }

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
      source: 'sampled-request',
      executions: 1,
      executionsEstimated: false,
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

  /*
   * The plan cache pass.
   *
   * Runs after the request pass on purpose: the request arrivals of this sample are what the dedup
   * below subtracts against, so they have to exist first.
   */
  const completedSample = snapshot.completedQueries ?? null
  let executions = previous.executions

  // Hashes that already arrived as sampled requests in THIS sample. A query slow enough to be caught
  // mid-flight will also advance the plan cache when it finishes, and admitting both would put two
  // cars on the road for one execution.
  //
  // What this covers and what it does not, precisely: it removes the overlap when the completion is
  // read in the same sample that caught the request. A query caught running in one sample and
  // completing during a later one is still counted twice, because nothing in either DMV links a
  // finished plan-cache execution back to the specific request row that produced it. That residue is
  // small by construction -- only queries long enough to survive a 2-5s sampling cadence can be
  // caught mid-flight at all, and those were 8 rows against 364 executions on the measured instance.
  const arrivedHashes = new Map<string, number>()
  for (const event of arrived) {
    if (!event.queryHash) continue
    arrivedHashes.set(event.queryHash, (arrivedHashes.get(event.queryHash) ?? 0) + 1)
  }

  let burst = 0
  for (const completed of completedSample?.queries ?? []) {
    if (burst >= LIVE_QUERY_ARRIVAL_BURST_CAP) break

    if (wanted !== null && completed.databaseName?.trim().toLowerCase() !== wanted) {
      elsewhere += 1
      continue
    }

    const queryHash = normalizeHash(completed.queryHash ?? null)
    let count = completed.executions
    if (queryHash) {
      const overlap = arrivedHashes.get(queryHash) ?? 0
      if (overlap > 0) {
        const applied = Math.min(overlap, count)
        count -= applied
        arrivedHashes.set(queryHash, overlap - applied)
      }
    }
    // Fully accounted for by a request row already in this sample. Dropping it entirely is right:
    // the execution is represented, and a zero-execution row would claim a query ran no times.
    if (count <= 0) continue

    const id = completedEventId(completed, completedSample?.watermarkEngineLocal ?? null)
    // `carried` as well as `present`: the first is the rows already in the feed, the second only the
    // ones this sample produced. Testing the sample alone lets a re-fold of the same watermark append
    // a second copy of every row, which is what a re-render or a retried poll would do.
    if (present.has(id) || carried.has(id)) {
      present.add(id)
      continue
    }
    present.add(id)

    const family = queryHash ? familyByHash.get(queryHash) ?? null : null
    const text = completed.statementText?.trim() || null
    arrived.push({
      id,
      source: 'plan-cache',
      executions: count,
      executionsEstimated: completed.firstObservation,
      ordinal,
      sessionId: null,
      requestId: null,
      startedAt: completed.lastExecutionAt,
      firstSeenAt: now,
      lastSeenAt: now,
      // Null throughout, and never set by the merge below. These executions were already complete
      // when they arrived, so there is no departure left to observe; marking them "gone" on the next
      // sample would describe this browser's sampling rather than anything the engine did.
      endedAt: null,
      databaseName: completed.databaseName,
      command: null,
      text,
      textReason: text === null ? NO_COMPLETED_TEXT_REASON : '',
      queryHash,
      familyId: family?.familyId ?? null,
      hashReported: completed.queryHash !== undefined,
      blocked: false,
      waitType: null,
      elapsedMs: completed.lastElapsedTimeUs / 1000,
      cpuMs: completed.lastWorkerTimeUs / 1000,
    })
    ordinal += 1
    observed += 1
    executions += count
    burst += 1
  }

  const merged: LiveQueryEvent[] = []
  for (const event of carried.values()) {
    if (present.has(event.id) || event.endedAt !== null) {
      merged.push(event)
      continue
    }
    // A plan-cache row is never retired. Its executions had already finished when it arrived, so
    // "gone from the next sample" describes this browser's sampling and not the engine -- and
    // flagging it would reinstate exactly the completed-versus-live distinction this list exists to
    // remove.
    if (event.source === 'plan-cache') {
      merged.push(event)
      continue
    }
    // Gone from this sample. That is all it means; see the module comment.
    merged.push({ ...event, endedAt: now })
  }
  merged.push(...arrived)
  merged.sort((left, right) => right.ordinal - left.ordinal)

  const events = merged.slice(0, LIVE_QUERY_FEED_CAP)
  const running = events.filter(
    event => event.source === 'sampled-request' && event.endedAt === null,
  ).length
  const blocked = events.filter(event => event.endedAt === null && event.blocked).length
  const dropped = previous.dropped + Math.max(0, merged.length - events.length)
  const samples = previous.samples + 1
  return {
    events,
    cap: LIVE_QUERY_FEED_CAP,
    observed,
    dropped,
    running,
    executions,
    completedStatus: completedSample?.status ?? null,
    blocked,
    nextOrdinal: ordinal,
    samples,
    elsewhere,
    reason: feedReason({
      shown: events.length,
      observed,
      dropped,
      running,
      executions,
      completedStatus: completedSample?.status ?? null,
      completedReason: completedSample?.reason ?? null,
      samples,
      elsewhere,
      scoped: wanted !== null,
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

/**
 * The identity of one plan-cache observation.
 *
 * The plan key alone is the *plan*, not an execution of it, and a hot plan reports under the same
 * key on every sample forever. Keying on it alone would therefore produce one row that silently
 * absorbed every later interval, keeping its original arrival time — a feed that looks frozen while
 * the instance churns, which is precisely the failure the request identity exists to prevent.
 *
 * The sample's own engine-local watermark separates them, so the same plan running again in a later
 * interval is a new arrival. It is the engine's value rather than this browser's clock, which also
 * makes the fold idempotent: folding one sample twice cannot double the list.
 */
export function completedEventId(completed: CompletedQuery, watermark: string | null): string {
  return `plan|${completed.planKey}|${watermark ?? completed.lastExecutionAt ?? ''}`
}

/** Only a *blocked* request is stopped. Holding a lock nobody waits behind is just work. */
function isBlocked(request: LiveRequest): boolean {
  return isBlockedReference(request.blocking)
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
  executions: number
  completedStatus: DataStatus | null
  completedReason: string | null
  samples: number
  elsewhere: number
  scoped: boolean
  hashReported: boolean
  unmatched: number
}): string {
  const parts: string[] = []
  if (counts.samples === 0) {
    return EMPTY_QUERY_FEED.reason
  }
  if (counts.observed === 0) {
    parts.push(
      'No query has turned up in any sample so far. Executions are learned two ways — caught mid-flight in the request list, or read from the plan cache once they finish — and neither has reported one.',
    )
    if (counts.completedStatus === 'Available') {
      parts.push(
        'The plan cache was read and no cached plan advanced its counter. That is a much stronger signal than an empty request list, but still not proof of an idle instance: a statement compiled with OPTION (RECOMPILE) leaves no plan-cache row at all, ad-hoc text can be stubbed rather than cached, natively compiled procedures report elsewhere, and a plan evicted between two reads takes its executions with it.',
      )
    }
  } else if (counts.executions > counts.observed) {
    // The gap is the interesting number: it is what one row standing for several executions means.
    parts.push(
      `${counts.shown} of ${counts.observed} observed ${plural(counts.observed, 'arrival')} listed, accounting for ${counts.executions} ${plural(counts.executions, 'execution')}; ${counts.running} still running in the latest sample.`,
    )
  } else {
    parts.push(
      `${counts.shown} of ${counts.observed} observed ${plural(counts.observed, 'execution')} listed, ${counts.running} still running in the latest sample.`,
    )
  }

  if (counts.completedStatus === null) {
    parts.push(
      'This snapshot carries no plan-cache reading at all — an API build that predates it — so only queries caught mid-execution can appear. The collector samples every few seconds, so a query that starts and finishes between two samples is never observed at all, and on an OLTP instance that is most of them.',
    )
  } else if (counts.completedStatus !== 'Available') {
    parts.push(
      `Finished queries could not be read from the plan cache (${counts.completedStatus}), so only queries caught mid-execution are listed.${counts.completedReason ? ` ${counts.completedReason}` : ''}`,
    )
  }

  if (counts.scoped) {
    parts.push(
      counts.elsewhere > 0
        ? `Only this database's executions are listed; ${counts.elsewhere} ${plural(counts.elsewhere, 'row')} in the latest sample ${plural(counts.elsewhere, 'was', 'were')} running against another database on the instance, or named none, and ${plural(counts.elsewhere, 'is', 'are')} not shown.`
        : 'Only this database\'s executions are listed. The live sampler is instance-wide, so a busy neighbour database would not appear here.',
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
    'Arrival is when this browser first learned of the execution, not when the query ran; a row leaving the list means it was gone from the next sample, not that it succeeded.',
  )
  return parts.join(' ')
}

function plural(count: number, one: string, many?: string): string {
  return count === 1 ? one : (many ?? `${one}s`)
}

/**
 * The folded, one-line summary for the drawer's closed state. Never "idle" unless that was measured.
 *
 * Reports executions rather than arrivals when the two differ, because one plan-cache row can stand
 * for several executions and a count of rows would understate a busy instance. It deliberately does
 * not separate running from finished: a reader closing this drawer wants to know whether anything is
 * happening, not which DMV said so.
 */
export function liveQuerySummaryLabel(feed: LiveQueryFeed): string {
  if (feed.samples === 0) return 'Awaiting first sample'
  if (feed.blocked > 0) return `${feed.running} running · ${feed.blocked} blocked`
  if (feed.running > 0) return `${feed.running} running`
  if (feed.executions > 0) return `${feed.executions} ${plural(feed.executions, 'execution')} seen`
  if (feed.observed > 0) return `${feed.observed} seen · none running`
  return 'None sampled'
}
