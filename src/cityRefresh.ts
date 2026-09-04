import { useRef } from 'react'
import type { CapacityCityItem, CapacityCityWorkspace } from './capacityCityContracts'
import type { CapacitySourceCapabilities } from './collect/source'
import { TIMEPOINT_SECONDS } from './fabricContracts'

/**
 * How often an open city re-reads its capacity, derived from the source rather than hardcoded.
 *
 * The SQL build polled a fixed 30-second `CITY_REFRESH_INTERVAL_MS`, which made sense there because a
 * DMV can be sampled as fast as the collector likes. Fabric cannot: telemetry arrives as 30-second
 * smoothing timepoints and a source runs some declared `latencySeconds` behind live, so the *rate at
 * which new evidence can appear* is the thing the cadence has to follow. Polling a 30-second
 * timepoint every second is 29 wasted round trips and a permanently busy machine, and polling a
 * source that only advances every `latencySeconds` faster than that re-fetches the same newest
 * timepoint over and over.
 *
 * So the interval is the timepoint cadence, floored, and never faster than the source's own latency:
 * `max(TIMEPOINT_SECONDS, latencySeconds)`. The fixture (latency 0) and the 30-second-fresh
 * Eventhouse feed both land on the 30-second timepoint cadence; a semantic-model source that runs ten
 * minutes behind is polled on that slower beat instead of being hammered pointlessly.
 */
export function refreshIntervalMs(
  capabilities: Pick<CapacitySourceCapabilities, 'latencySeconds'>,
): number {
  const latency = Number.isFinite(capabilities.latencySeconds)
    ? Math.max(0, capabilities.latencySeconds)
    : 0
  return Math.max(TIMEPOINT_SECONDS, Math.round(latency)) * 1000
}

/**
 * The item fields the city *layout* is derived from.
 *
 * Everything else on an item -- its operation counts, its throttling minutes, its evidence
 * `observedAt` -- changes on almost every refresh, and none of it moves a building. Separating the
 * two is what lets a refresh repaint the traffic without re-planning the city.
 *
 * This has to name the same fields `cityPlan` actually reads. Adding a read there without adding it
 * here fails silently and in the worst possible direction: the plan is *not* recomputed when it
 * should be, so a building keeps a footprint its item no longer has. Footprint comes from OneLake
 * bytes and height from CU-seconds, so both of those decimal-string measurements are in the
 * signature; a null (missing) measurement is folded in as the empty string so a building that loses
 * its measurement re-plans onto a vacant lot rather than keeping a stale one.
 */
export function cityLayoutSignature(items: readonly CapacityCityItem[]): string {
  return items
    .map(item => [
      item.itemId,
      item.workspaceId,
      item.workspaceName,
      item.kind,
      item.storage.bytes ?? '',
      item.cuConsumed.cuSeconds ?? '',
      item.layout.neighborhoodOrdinal,
      item.layout.itemOrdinal,
    ].join('\u0000'))
    .join('\u0001')
}

/**
 * The workspace fields `planCity` is given as options. `evidence` is deliberately excluded: its
 * `observedAt` moves every single refresh and never changes where a neighbourhood goes.
 */
export function citySchemaSignature(
  workspaces: readonly CapacityCityWorkspace[] | undefined,
): string {
  if (!workspaces) return ''
  return workspaces
    .map(workspace => [
      workspace.workspaceId,
      workspace.name,
      workspace.neighborhoodOrdinal,
      workspace.itemCount ?? '',
    ].join('\u0000'))
    .join('\u0001')
}

/**
 * Returns `previous` whenever the two carry the same content, so a consumer keyed on identity does
 * not re-run.
 *
 * The point is `planCity`, measured in AGENTS.md at 16,150ms over counts 80..140. A poll that hands
 * the memo a fresh array every refresh re-plans the whole city each time -- and because a re-plan
 * re-ranks each workspace's buildings by footprint, the city visibly reshuffles while someone is
 * looking at it. Content-stability is what makes a refreshing city cheap *and* still.
 */
export function stableByContent<T>(previous: T, next: T, signature: (value: T) => string): T {
  return signature(previous) === signature(next) ? previous : next
}

/** `stableByContent` across renders. The signature is recomputed each render and is cheap; the plan is not. */
export function useContentStable<T>(value: T, signature: (value: T) => string): T {
  const held = useRef<{ signature: string; value: T } | null>(null)
  const current = signature(value)
  if (held.current === null || held.current.signature !== current) held.current = { signature: current, value }
  return held.current.value
}
