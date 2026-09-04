import type { CapacityTimepoint } from './capacityCityContracts'
import type { CapacitySource, TimepointRequest } from './collect/source'
import { TIMEPOINT_SECONDS } from './fabricContracts'
import { refreshIntervalMs } from './cityRefresh'
import {
  advanceTimepointFeed,
  emptyTimepointFeed,
  type TimepointFeed,
} from './timepointFeed'

/*
 * The transport for the timepoint clock.
 *
 * The SQL build pushed live incidents over a SignalR hub (`liveFeed.ts`) with a REST fallback, all of
 * it talking to a .NET collector that no longer exists. A Fabric App on Rayfin has no such hub: there
 * is no cron, no background worker and no push channel (see AGENTS.md, "Rayfin constraints"), so the
 * only way to advance the clock is a client-side `setInterval` that reads timepoints through the one
 * `CapacitySource` seam while the tab is open. This module is that poller.
 *
 * It is a loop, and AGENTS.md is emphatic that loops here are dangerous, so it obeys the two rules
 * that matter for one:
 *
 * - **It stops when there is nothing to poll.** A source without the `timepoints` capability has no
 *   clock to run; the poller emits one `unsupported` feed and schedules nothing at all, rather than
 *   spinning an interval forever that can only ever read an empty array. This is the timepoint
 *   analogue of an empty roster ending a render loop.
 * - **It stops on teardown.** The disposer clears the interval, aborts any in-flight read and drops a
 *   result that lands after disposal, so it can never call back into an unmounted view.
 *
 * It also honours the cadence: it never polls faster than {@link refreshIntervalMs} allows, which is
 * the 30-second timepoint beat floored by the source's declared `latencySeconds`. Polling a
 * 30-second timepoint every second would be 29 wasted round trips and a permanently busy machine.
 */

/** Timepoints of window read back beyond the latency frontier, so a missed poll is still caught up. */
const DEFAULT_LOOKBACK_TIMEPOINTS = 4

export interface TimepointClockOptions {
  readonly source: CapacitySource
  readonly capacityId: string
  /** Called with a fresh {@link TimepointFeed} on every poll, and once immediately on start. */
  readonly onFeed: (feed: TimepointFeed) => void
  /** Clock injection point for tests; defaults to `Date.now`. */
  readonly now?: () => number
  /** Cadence override; defaults to {@link refreshIntervalMs} for the source's capabilities. */
  readonly intervalMs?: number
  /** How many timepoints of window to read before the latency frontier. */
  readonly lookbackTimepoints?: number
}

/**
 * Starts the timepoint clock and returns a disposer.
 *
 * The disposer is idempotent and, once called, guarantees no further `onFeed` call.
 */
export function startTimepointClock(options: TimepointClockOptions): () => void {
  const { source, capacityId, onFeed } = options
  const now = options.now ?? Date.now
  const lookbackTimepoints = options.lookbackTimepoints ?? DEFAULT_LOOKBACK_TIMEPOINTS
  const capabilities = source.capabilities

  let disposed = false
  let feed: TimepointFeed = emptyTimepointFeed(capabilities)
  let handle: ReturnType<typeof setInterval> | null = null
  let controller: AbortController | null = null
  let polling = false

  // Nothing to poll: emit the unsupported feed once and schedule no loop. The clock cannot run, and
  // an interval that can only ever read an empty array is exactly the always-scheduled callback that
  // does no work AGENTS.md warns about.
  if (!capabilities.timepoints) {
    onFeed(feed)
    return () => {
      disposed = true
    }
  }

  const windowFor = (at: number): TimepointRequest => {
    const backSeconds = capabilities.latencySeconds + lookbackTimepoints * TIMEPOINT_SECONDS
    return {
      capacityId,
      start: new Date(at - backSeconds * 1000).toISOString(),
      end: new Date(at).toISOString(),
      signal: controller?.signal,
    }
  }

  const pollOnce = async () => {
    if (disposed || polling) return
    polling = true
    controller = new AbortController()
    const at = now()
    let timepoints: readonly CapacityTimepoint[] = []
    try {
      timepoints = await source.readTimepoints(windowFor(at))
    } catch (error) {
      if (disposed) return
      // A failed read is not a landed timepoint. Re-fold with nothing so the newest timepoint's age
      // still climbs against the clock rather than freezing, and say why in the console.
      console.error('Timepoint read failed; the clock holds its last landed timepoint', error)
    } finally {
      polling = false
    }
    if (disposed) return
    feed = advanceTimepointFeed(feed, timepoints, capabilities, at)
    onFeed(feed)
  }

  const intervalMs = options.intervalMs ?? refreshIntervalMs(capabilities)
  void pollOnce()
  handle = setInterval(() => void pollOnce(), intervalMs)

  return () => {
    if (disposed) return
    disposed = true
    if (handle !== null) {
      clearInterval(handle)
      handle = null
    }
    controller?.abort()
  }
}
