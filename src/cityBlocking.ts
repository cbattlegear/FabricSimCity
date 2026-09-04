import type { CapacityCityItem, OperationClass, OperationSample } from './capacityCityContracts'
import type { LiveBlockingEdge } from './cityTraffic'
import type { CapacitySourceCapabilities } from './collect/source'

/**
 * Turns live operation samples into per-item rejection evidence.
 *
 * SQLSimCity drew a *blocked session* here: a waiter pinned to the table whose lock it was queued
 * behind. Fabric has no lock and no pairwise block. Its analogue is a **rejected operation** — work
 * the capacity turned away because a throttle gate was over the line — and the item it names is the
 * one whose operations drove the overload. This module re-points the old blocking wire onto those
 * rejections while keeping the one rule that made it safe: a subsystem that could not be sampled
 * produces **no edge**, never a "clear" one.
 *
 * Three states are kept distinct and none of them is read as "nothing was rejected":
 *
 * - `unsupported` — the source cannot report operation samples at all (`operationSamples: false` on
 *   the seam; the Eventhouse feed reports exactly this). It returns an empty array rather than
 *   throwing, so an empty sample list here is ambiguous and must not be drawn as a quiet capacity.
 * - `none` — the source can report samples and reported no rejection. A genuinely measured-quiet
 *   capacity.
 * - `measured` — at least one operation was rejected.
 *
 * The severity ladder is respected at the source: only `status === 'Rejected'` counts. A request
 * that was merely *delayed* — an interactive operation that queued at the delay gate and then
 * succeeded — carries `status === 'Success'` with non-zero `throttlingSeconds`, and is deliberately
 * **not** an edge here. A delay is a busy city, a rejection is a broken one, and the two must not
 * grade a road the same way.
 */

export type LiveRejectionEvidenceState = 'measured' | 'none' | 'unsupported'

/**
 * Per-item rejection counts, split by the class that decides which gate the work was refused at.
 * Interactive rejections are refused at the 60-minute gate; background rejections at the 24-hour
 * gate. `unknownClass` is a rejection whose class the source could not name, and it is kept apart
 * rather than folded into either gate, because pinning it to a gate would be a guess.
 */
export interface LiveRejectionItem {
  readonly itemId: string
  readonly interactiveRejections: number
  readonly backgroundRejections: number
  readonly unknownClassRejections: number
  readonly totalRejections: number
}

export interface LiveRejectionSummary {
  /**
   * The road-grading wire consumed by {@link ./cityTraffic}'s `gradeRoads`. One entry per loaded
   * item a rejection resolved to, `blockedSessionCount` carrying the rejection count. The field name
   * is inherited from `LiveBlockingEdge` and is intentionally left as the traffic layer defines it.
   */
  readonly edges: LiveBlockingEdge[]
  /** The same evidence, split by class, for the incident projection to build markers from. */
  readonly items: LiveRejectionItem[]
  /** Rejections resolving to an item outside the loaded bounded page. Counted, never pinned. */
  readonly offPageCount: number
  readonly state: LiveRejectionEvidenceState
}

const UNSUPPORTED: LiveRejectionSummary = Object.freeze({
  edges: [],
  items: [],
  offPageCount: 0,
  state: 'unsupported',
})

interface MutableRejectionItem {
  itemId: string
  interactiveRejections: number
  backgroundRejections: number
  unknownClassRejections: number
  totalRejections: number
}

function classify(operationClass: OperationClass): 'interactive' | 'background' | 'unknown' {
  switch (operationClass) {
    case 'Interactive':
      return 'interactive'
    case 'Background':
      return 'background'
    default:
      return 'unknown'
  }
}

/**
 * Resolves live rejected operations onto the loaded items they name.
 *
 * A sample is only ever anchored to an item this page is actually drawing. A rejection whose item
 * is outside the loaded page is real and is counted in `offPageCount`, but it has nowhere to be
 * drawn, so it is never pinned to the wrong lot.
 */
export function liveRejectionEdges(
  samples: readonly OperationSample[] | null,
  items: readonly CapacityCityItem[],
  capabilities: Pick<CapacitySourceCapabilities, 'operationSamples'>,
): LiveRejectionSummary {
  if (!capabilities.operationSamples) return UNSUPPORTED

  const loaded = new Set(items.map(item => item.itemId))
  const byItem = new Map<string, MutableRejectionItem>()
  let offPageCount = 0

  for (const sample of samples ?? []) {
    if (sample.status !== 'Rejected') continue
    if (!loaded.has(sample.itemId)) {
      offPageCount += 1
      continue
    }
    const entry = byItem.get(sample.itemId) ?? {
      itemId: sample.itemId,
      interactiveRejections: 0,
      backgroundRejections: 0,
      unknownClassRejections: 0,
      totalRejections: 0,
    }
    switch (classify(sample.operationClass)) {
      case 'interactive':
        entry.interactiveRejections += 1
        break
      case 'background':
        entry.backgroundRejections += 1
        break
      case 'unknown':
        entry.unknownClassRejections += 1
        break
    }
    entry.totalRejections += 1
    byItem.set(sample.itemId, entry)
  }

  const items_ = [...byItem.values()].sort(byCountThenId)
  const edges: LiveBlockingEdge[] = items_.map(entry => ({
    objectKey: entry.itemId,
    blockedSessionCount: entry.totalRejections,
  }))

  const state: LiveRejectionEvidenceState =
    edges.length > 0 || offPageCount > 0 ? 'measured' : 'none'

  return { edges, items: items_, offPageCount, state }
}

function byCountThenId(left: MutableRejectionItem, right: MutableRejectionItem): number {
  return right.totalRejections - left.totalRejections || left.itemId.localeCompare(right.itemId)
}
