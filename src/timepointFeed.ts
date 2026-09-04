import type { CapacityTimepoint } from './capacityCityContracts'
import type { CapacitySourceCapabilities } from './collect/source'
import { TIMEPOINT_SECONDS } from './fabricContracts'

/**
 * The 30-second timepoint clock.
 *
 * This is the honest Fabric replacement for the SQL build's live query feed. That feed folded
 * individual query executions out of `sys.dm_exec_requests` and the plan cache into a running list —
 * a genuine "what is executing right now" view, because a DMV can be sampled the instant a request
 * starts. Fabric has no such thing. The Capacity Metrics model reports in **30-second smoothing
 * timepoints**, and those timepoints land with a declared latency (`latencySeconds`): the nearest
 * true statement the platform can make is *"the most recent timepoint that has actually landed"*,
 * which is some tens of seconds to minutes in the past.
 *
 * So this is a clock, not a live feed, and it will not pretend otherwise:
 *
 * - **The newest landed timepoint is never labelled "live" or "now".** It is a past instant, and the
 *   feed carries its age (`ageSeconds`) as a first-class measurement so the UI can say "as of 45s
 *   ago" rather than drawing a guess about the present. A capacity whose newest timepoint is four
 *   minutes old and a capacity that was genuinely idle for four minutes are completely different
 *   states, and the age is what tells them apart.
 * - **"No timepoint yet" is not "nothing happened", and "this source has no timepoints" is neither.**
 *   The contract in `source.ts` has a source without the `timepoints` capability return an empty
 *   array rather than throwing, so an empty read is ambiguous. {@link TimepointEvidenceState}
 *   resolves it the same way `cityTraffic`'s `trafficEvidenceState` resolves an empty family list:
 *   `unsupported` (the clock cannot run — we cannot know), `none` (it can run and nothing has landed
 *   yet — a measured absence), `measured` (a timepoint landed).
 *
 * Staleness only ever grows here, never silently resets: a poll that returns nothing leaves the
 * newest timepoint where it was and lets its age climb against `now`, because a quiet channel is not
 * evidence that the capacity stopped — it is evidence that no newer timepoint has landed.
 */

/**
 * Whether this source can run a timepoint clock, and if so whether one has ticked.
 *
 * Mirrors `cityTraffic.trafficEvidenceState`. The three states are different *claims* and the city
 * must never render them the same way.
 *
 * - `unsupported` — `capabilities.timepoints` is false. There is no clock; how recent the telemetry
 *   is cannot be known. Say so rather than drawing an idle city.
 * - `none` — the source can report timepoints and none has landed yet. A measured absence.
 * - `measured` — at least one timepoint has landed.
 */
export type TimepointEvidenceState = 'measured' | 'none' | 'unsupported'

export function timepointEvidenceState(
  capabilities: Pick<CapacitySourceCapabilities, 'timepoints'>,
  newest: CapacityTimepoint | null,
): TimepointEvidenceState {
  if (!capabilities.timepoints) return 'unsupported'
  return newest === null ? 'none' : 'measured'
}

/**
 * The clock's state, folded across successive reads of {@link CapacityTimepoint}s.
 *
 * Immutable and rebuilt by {@link advanceTimepointFeed}. Everything a reader needs to know how far
 * behind live the city is drawn is here, and none of it is ever expressed as "now".
 */
export interface TimepointFeed {
  readonly state: TimepointEvidenceState
  /** The most recent landed timepoint, or null when none has. Never the platform's idea of "now". */
  readonly newest: CapacityTimepoint | null
  /** `newest.timepoint`, hoisted for convenience. Null when nothing has landed. */
  readonly newestAt: string | null
  /**
   * How old the newest landed timepoint is, in whole seconds against the `now` passed to the fold.
   *
   * This is the measurement the whole clock exists to carry. It is null only when nothing has landed
   * ({@link state} `none`/`unsupported`); a landed-but-stale timepoint reports a positive age rather
   * than being drawn as current. Floored at 0 so clock skew can never render a timepoint from the
   * future.
   */
  readonly ageSeconds: number | null
  /** The age expressed in whole 30-second timepoints, floor. Null when nothing has landed. */
  readonly behindByTimepoints: number | null
  /** How far behind live the source declares it runs. The floor `ageSeconds` can never beat. */
  readonly latencySeconds: number
  /** Distinct timepoints the clock has advanced through since this view opened. */
  readonly advanced: number
  /** Timepoints that advanced on the most recent fold. Zero when a poll brought nothing new. */
  readonly advancedThisPoll: number
  /** How many reads have been folded in. Zero means nothing has been polled yet. */
  readonly polls: number
  /** Why the clock reads the way it does, in plain language. Never omitted, never "live". */
  readonly reason: string
}

const NEVER_POLLED_REASON =
  'No timepoint has been read yet, so nothing is claimed about how recent the capacity\u2019s telemetry is.'

const UNSUPPORTED_REASON =
  'This source cannot report timepoints, so there is no clock: how recent the capacity\u2019s '
  + 'telemetry is cannot be known here. This is an absent capability, not a quiet capacity \u2014 the '
  + 'city withholds the age rather than drawing it as fresh.'

/** The clock before any read. `none` when the source could tick, `unsupported` when it cannot. */
export function emptyTimepointFeed(
  capabilities: Pick<CapacitySourceCapabilities, 'timepoints' | 'latencySeconds'>,
): TimepointFeed {
  const supported = capabilities.timepoints
  return {
    state: supported ? 'none' : 'unsupported',
    newest: null,
    newestAt: null,
    ageSeconds: null,
    behindByTimepoints: null,
    latencySeconds: normaliseLatency(capabilities.latencySeconds),
    advanced: 0,
    advancedThisPoll: 0,
    polls: 0,
    reason: supported ? NEVER_POLLED_REASON : UNSUPPORTED_REASON,
  }
}

/**
 * Folds one read of timepoints into the clock.
 *
 * Pure, and total. `now` is passed in rather than read from a clock so the fold is testable and so a
 * feed's age is measured against a single caller-chosen instant.
 *
 * The rules that keep it honest:
 * - A source that cannot report timepoints stays `unsupported` no matter what array it returned; the
 *   capability, not the array length, decides that.
 * - A timepoint whose instant is in the future relative to `now` is not "landed" and can never
 *   become {@link TimepointFeed.newest}. The forward-window series the throttle gauges average over
 *   is exactly such data, and handing it back as observed telemetry would be the time-dimension form
 *   of drawing a guess.
 * - A read that brings nothing newer than the current watermark leaves {@link TimepointFeed.newest}
 *   in place and lets its age grow against `now`. The channel going quiet is not evidence the
 *   capacity stopped.
 */
export function advanceTimepointFeed(
  previous: TimepointFeed,
  timepoints: readonly CapacityTimepoint[],
  capabilities: Pick<CapacitySourceCapabilities, 'timepoints' | 'latencySeconds'>,
  now: number,
): TimepointFeed {
  const latencySeconds = normaliseLatency(capabilities.latencySeconds)

  if (!capabilities.timepoints) {
    // The capability, not the payload, decides this. A source that says it cannot report timepoints
    // and yet returned some has violated the contract; trusting the array here would let an
    // unsupported source masquerade as a measured-quiet one, which is the exact ambiguity the state
    // exists to remove.
    return { ...emptyTimepointFeed(capabilities), polls: previous.polls + 1 }
  }

  const previousWatermark = previous.newestAt !== null ? Date.parse(previous.newestAt) : null
  let newest = previous.newest
  let newestMs = previousWatermark
  let advancedThisPoll = 0

  for (const timepoint of timepoints) {
    const at = Date.parse(timepoint.timepoint)
    if (!Number.isFinite(at)) continue
    // Not yet landed: a timepoint from the forward-smoothing series is not observed telemetry.
    if (at > now) continue
    // Only timepoints strictly newer than the current watermark advance the clock. A window that
    // overlaps the previous read re-delivers older timepoints, and re-counting them would inflate
    // the advance count without the clock having moved.
    if (previousWatermark !== null && at <= previousWatermark) continue
    advancedThisPoll += 1
    if (newestMs === null || at > newestMs) {
      newestMs = at
      newest = timepoint
    }
  }

  const advanced = previous.advanced + advancedThisPoll
  const polls = previous.polls + 1
  const newestAt = newest?.timepoint ?? null
  const ageSeconds = newestMs === null ? null : Math.max(0, Math.round((now - newestMs) / 1000))
  const behindByTimepoints = ageSeconds === null ? null : Math.floor(ageSeconds / TIMEPOINT_SECONDS)
  const state = timepointEvidenceState(capabilities, newest)

  return {
    state,
    newest,
    newestAt,
    ageSeconds,
    behindByTimepoints,
    latencySeconds,
    advanced,
    advancedThisPoll,
    polls,
    reason: feedReason({ state, newestAt, ageSeconds, latencySeconds, advanced }),
  }
}

export interface TimepointEvidenceDisclosure {
  readonly state: TimepointEvidenceState
  /** True when the clock should run against this source; false when it is withheld. */
  readonly runClock: boolean
  readonly headline: string
  readonly detail: string
}

/**
 * The words that go with {@link timepointEvidenceState}, so a withheld clock is announced rather than
 * looking like a fresh-but-idle city. The companion of `cityTraffic.describeTrafficEvidence`.
 */
export function describeTimepointEvidence(
  capabilities: Pick<CapacitySourceCapabilities, 'timepoints'>,
  feed: TimepointFeed,
): TimepointEvidenceDisclosure {
  const state = timepointEvidenceState(capabilities, feed.newest)
  switch (state) {
    case 'unsupported':
      return {
        state,
        runClock: false,
        headline: 'This source cannot report timepoints.',
        detail: 'The clock is withheld rather than run empty: an absent capability is not a quiet '
          + 'capacity, so the city cannot know how recent its telemetry is and says so instead of '
          + 'drawing it as current.',
      }
    case 'none':
      return {
        state,
        runClock: true,
        headline: 'No timepoint has landed yet.',
        detail: 'The source can report timepoints and none has landed in the window so far. This is '
          + 'a measured absence, not an idle capacity \u2014 the clock is running and waiting for the '
          + 'first timepoint to arrive.',
      }
    case 'measured':
      return {
        state,
        runClock: true,
        headline: 'The clock is running from landed timepoints.',
        detail: 'The city is drawn from the most recent timepoint that has actually landed, and its '
          + 'age is shown rather than presented as the present moment.',
      }
  }
}

/**
 * How old the newest landed timepoint is, in whole seconds against `now`, floored at 0.
 *
 * Exported so a consumer can re-age a held feed between polls without re-folding it: staleness climbs
 * with wall-clock time, and a UI that read the age only at fold time would freeze it.
 */
export function timepointAgeSeconds(newestAt: string | null, now: number): number | null {
  if (newestAt === null) return null
  const at = Date.parse(newestAt)
  if (!Number.isFinite(at)) return null
  return Math.max(0, Math.round((now - at) / 1000))
}

/**
 * The folded one-line summary for the drawer's closed state. Never says "live" or "now".
 *
 * Reports the age of the newest timepoint, because that is the honest headline: the city is drawn
 * from a past instant, and how far past is the thing a reader closing this drawer wants to know.
 */
export function timepointClockLabel(feed: TimepointFeed): string {
  switch (feed.state) {
    case 'unsupported':
      return 'Timepoints unavailable'
    case 'none':
      return feed.polls === 0 ? 'Awaiting first timepoint' : 'No timepoint yet'
    case 'measured':
      return `As of ${formatAge(feed.ageSeconds)} ago`
  }
}

function feedReason(parts: {
  state: TimepointEvidenceState
  newestAt: string | null
  ageSeconds: number | null
  latencySeconds: number
  advanced: number
}): string {
  if (parts.state === 'unsupported') return UNSUPPORTED_REASON
  if (parts.state === 'none') {
    return 'The source can report timepoints and none has landed in the window yet, so nothing is '
      + 'claimed about the capacity\u2019s recent activity.'
  }
  const behind = parts.latencySeconds > 0
    ? ` The source runs about ${formatAge(parts.latencySeconds)} behind real time, so a timepoint is never fresher than that.`
    : ''
  const advanced = parts.advanced === 1
    ? '1 timepoint has advanced'
    : `${parts.advanced} timepoints have advanced`
  return `The newest landed timepoint is ${parts.newestAt}, ${formatAge(parts.ageSeconds)} old \u2014 `
    + `the city is drawn from that instant, not from now.${behind} ${advanced} since this view opened.`
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return 'an unknown time'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

function normaliseLatency(latencySeconds: number): number {
  return Number.isFinite(latencySeconds) ? Math.max(0, latencySeconds) : 0
}
