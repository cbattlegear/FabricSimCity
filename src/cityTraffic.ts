import type { LinkConfidence } from './fabricContracts'
import type { OperationClass, OperationFamily, CapacityCityRoute } from './capacityCityContracts'
import type { CapacitySourceCapabilities } from './collect/source'

/**
 * Turns operation-family evidence into roads carrying a GPS-style congestion colour.
 *
 * In SQLSimCity a road was a co-reference between two objects and its colour was the mean wait
 * milliseconds a captured execution carried. Fabric has no query-store waits; it has operation
 * families, each attributed to an item, each carrying measured throttling seconds. So the road is
 * now graded by the mean **throttling seconds a single operation carried** over the pair — a road
 * whose operations are being held at a throttle gate is congested, exactly as a road whose
 * executions waited was.
 *
 * Colour is the only channel this map spends on how busy a road is. Width is a constant
 * ({@link ROAD_WIDTH}); the operation counts stay on {@link RoadTraffic}, in the hover rationale and
 * in the evidence tables, so nothing measured is dropped when it stops being a *visual* channel.
 *
 * A road with no operation family naming both endpoints is **not** claimed to be quiet: it is graded
 * `unknown` and drawn as a grey dashed wireframe, because "the source reported nothing about this
 * pair" and "this pair is idle" are different statements and only the first is supported. Folding
 * grey into green is the easiest way to make this map lie, so the grey is desaturated and nowhere
 * near the green.
 *
 * Confidence is carried by the line *pattern*, so colour stays free for congestion.
 */

/**
 * The GPS ladder: free-flowing, then three grades of delay, plus "not measured".
 *
 * Four bands rather than three because on a three-band ladder every road that is throttled at all
 * lands in amber, and most of a busy capacity's work is throttled a little. `unknown` is not a fifth
 * band on that scale — it is off the scale entirely.
 */
export type CongestionGrade = 'free' | 'moderate' | 'heavy' | 'severe' | 'unknown'

/** GPS palette. `unknown` is deliberately a desaturated grey so it never reads as "clear". */
export const CONGESTION_COLORS: Readonly<Record<CongestionGrade, number>> = {
  free: 0x39c46b,
  moderate: 0xe8b13a,
  heavy: 0xe87a2b,
  severe: 0xe4483c,
  unknown: 0x5a6270,
}

export const CONGESTION_LABELS: Readonly<Record<CongestionGrade, string>> = {
  free: 'Free-flowing',
  moderate: 'Moderate delay',
  heavy: 'Heavy delay',
  severe: 'Severe delay',
  unknown: 'No throttling evidence',
}

/** The bands in ladder order, for legends and for tests that must cover all of them. */
export const CONGESTION_GRADES: readonly CongestionGrade[] = [
  'free',
  'moderate',
  'heavy',
  'severe',
  'unknown',
]

/**
 * Grade thresholds, in seconds of measured throttling per operation.
 *
 * **Invented cut points on a measured ratio.** The throttling seconds and the operation counts are
 * both from Capacity Metrics; where the line between amber and orange falls is a choice made here,
 * and it is stated rather than implied. A Fabric operation held at the interactive-delay gate is
 * padded by up to 20 seconds, so the severe cut point is set there: a road whose operations each
 * lose 20s to throttling is standing in the delay stage.
 */
export const MODERATE_DELAY_SECONDS_PER_OP = 0.5
export const HEAVY_DELAY_SECONDS_PER_OP = 5
export const SEVERE_DELAY_SECONDS_PER_OP = 20

/** Live rejection overrides the aggregate grade: an operation rejected right now is the worst band. */
export const LIVE_BLOCKING_GRADE: CongestionGrade = 'severe'

/**
 * One width for every road, in world units.
 *
 * Roads are not sized by operation volume, so the network reads as one road network at a glance
 * instead of as a chart. The value sits inside the old 2.2–11 range this codebase drew.
 */
export const ROAD_WIDTH = 5.2

import type { RoadPattern } from './cityRoads'
export type { RoadPattern }

/**
 * Which vehicle an operation class travels as.
 *
 * The split is not cosmetic — an interactive operation is delayed at 10 minutes and rejected at 60,
 * a background one survives to 24 hours, so they queue at different gates and genuinely travel
 * different routes. Interactive work is a car; background work is freight. `unknown` is a class the
 * source could not name and must not be quietly counted as either.
 */
export type TrafficMode = 'car' | 'freight' | 'unknown'

export function trafficModeForClass(operationClass: OperationClass): TrafficMode {
  switch (operationClass) {
    case 'Interactive':
      return 'car'
    case 'Background':
      return 'freight'
    default:
      return 'unknown'
  }
}

export interface RoadTraffic {
  readonly routeId: string
  readonly fromItemId: string
  readonly toId: string
  readonly kind: CapacityCityRoute['kind']
  readonly confidence: LinkConfidence
  readonly pattern: RoadPattern
  /** Always {@link ROAD_WIDTH}. Kept on the record so the scene reads width from one place. */
  readonly width: number
  readonly grade: CongestionGrade
  readonly color: number
  /** Total operations of families naming both endpoints, or null when none were reported. */
  readonly operations: number | null
  /** Interactive operations on this road — drawn as cars — or null when nothing was reported. */
  readonly carOperations: number | null
  /** Background operations on this road — drawn as freight — or null when nothing was reported. */
  readonly freightOperations: number | null
  /** Throttling seconds as a share of measured duration, or null when unmeasured. */
  readonly throttleShare: number | null
  /** Mean throttling seconds per operation — what the colour is graded from. */
  readonly delayPerOperation: number | null
  /**
   * Operations inside the recent traffic window, or null when nothing was reported in it. Distinct
   * from {@link operations}, which is the retained total across the whole horizon.
   */
  readonly recentOperations: number | null
  /** Width of the recent traffic window in minutes, or null when the page published none. */
  readonly recentWindowMinutes: number | null
  /** Ids of the operation families that produced this road's numbers, for drill-down. */
  readonly familyIds: readonly string[]
  /** Plain-language justification shown in the HUD, never omitted. */
  readonly rationale: string
}

export interface LiveBlockingEdge {
  /** Item id of the item a live rejected operation resolves to. */
  readonly objectKey: string
  readonly blockedSessionCount: number
}

/**
 * Sum of operations across every family naming both endpoints. Returns null when no family names the
 * pair, which is an absence of evidence rather than a measurement of zero.
 */
export function roadVolume(
  route: Pick<CapacityCityRoute, 'fromItemId' | 'toItemId'>,
  families: readonly OperationFamily[],
): { operations: number | null; familyIds: string[] } {
  const familyIds: string[] = []
  let operations = 0
  for (const family of families) {
    if (!family.itemIds.includes(route.fromItemId)) continue
    if (!family.itemIds.includes(route.toItemId)) continue
    familyIds.push(family.familyId)
    operations += toNumber(family.operationCount) ?? 0
  }
  return familyIds.length === 0 ? { operations: null, familyIds } : { operations, familyIds }
}

/**
 * Fraction of measured wall-clock time spent throttled, or null when either side is unmeasured.
 *
 * No longer what the colour is graded from — see {@link roadDelay} — but still reported per road,
 * because "half of this road's time went on throttling" answers something the ratio does not.
 */
export function throttleShare(families: readonly OperationFamily[]): number | null {
  let throttled = 0
  let duration = 0
  let sawThrottle = false
  let sawDuration = false
  for (const family of families) {
    if (family.throttlingSeconds !== null && Number.isFinite(family.throttlingSeconds)) {
      throttled += family.throttlingSeconds
      sawThrottle = true
    }
    if (Number.isFinite(family.durationSeconds) && family.durationSeconds > 0) {
      duration += family.durationSeconds
      sawDuration = true
    }
  }
  if (!sawThrottle || !sawDuration || duration <= 0) return null
  return throttled / duration
}

/**
 * Mean throttling seconds per operation across the families naming both endpoints.
 *
 * This is the same ratio the aggregate street load is graded by, so a road ribbon and the street it
 * runs along are coloured by one rule. Null when no family reported throttling or none reported
 * operations: an unmeasured ratio is not a zero one.
 */
export function roadDelay(families: readonly OperationFamily[]): number | null {
  let throttled = 0
  let operations = 0
  let sawThrottle = false
  for (const family of families) {
    if (family.throttlingSeconds !== null && Number.isFinite(family.throttlingSeconds)) {
      throttled += family.throttlingSeconds
      sawThrottle = true
    }
    operations += toNumber(family.operationCount) ?? 0
  }
  if (!sawThrottle || operations <= 0) return null
  return throttled / operations
}

/**
 * Mean throttling seconds per operation inside the recent traffic window.
 *
 * Returns `null` for the delay whenever the window was published but nothing overlapped it, which
 * grades `unknown`. That is deliberately not `free`: a road nobody measured and a road nobody drove
 * are different claims, and only the second one is green.
 *
 * `published` is false when no matched family carries a window at all — an archive or a fixture page
 * built before it existed. Callers fall back to the retained totals there rather than greying out a
 * city that has perfectly good evidence of a different kind.
 */
export function recentRoadDelay(families: readonly OperationFamily[]): {
  delay: number | null
  published: boolean
  covered: boolean
  operations: number | null
  windowMinutes: number | null
} {
  let published = false
  let covered = false
  let throttled = 0
  let operations = 0
  let windowMinutes: number | null = null
  for (const family of families) {
    const recent = family.recentActivity
    if (!recent) continue
    published = true
    if (windowMinutes === null) windowMinutes = recent.windowMinutes
    if (!recent.covered) continue
    covered = true
    throttled += Number.isFinite(recent.throttlingSeconds) ? recent.throttlingSeconds : 0
    operations += toNumber(recent.operationCount) ?? 0
  }
  if (!published) return { delay: null, published: false, covered: false, operations: null, windowMinutes: null }
  if (!covered) return { delay: null, published: true, covered: false, operations: null, windowMinutes }
  // Covered with no operations is a measured quiet street, not an unmeasured one, so it grades free
  // rather than unknown. The metrics window only records a bucket when something ran, so this is rare.
  return { delay: operations > 0 ? throttled / operations : 0, published: true, covered: true, operations, windowMinutes }
}

/** The ladder itself. Shared by the co-reference roads and by the aggregate street load. */
export function congestionFromDelay(delay: number | null): CongestionGrade {
  if (delay === null || !Number.isFinite(delay)) return 'unknown'
  if (delay >= SEVERE_DELAY_SECONDS_PER_OP) return 'severe'
  if (delay >= HEAVY_DELAY_SECONDS_PER_OP) return 'heavy'
  if (delay >= MODERATE_DELAY_SECONDS_PER_OP) return 'moderate'
  return 'free'
}

export function confidencePattern(confidence: LinkConfidence): RoadPattern {
  switch (confidence) {
    case 'Confirmed':
      return 'solid'
    case 'Probable':
      return 'dashed'
    default:
      return 'sparse'
  }
}

/** Interactive/background operation split for the families naming both endpoints. */
function classSplit(
  families: readonly OperationFamily[],
  familyIds: readonly string[],
): { car: number; freight: number } {
  const ids = new Set(familyIds)
  let car = 0
  let freight = 0
  for (const family of families) {
    if (!ids.has(family.familyId)) continue
    const count = toNumber(family.operationCount) ?? 0
    if (family.operationClass === 'Interactive') car += count
    else if (family.operationClass === 'Background') freight += count
  }
  return { car, freight }
}

/**
 * Grades every route. `liveBlocking` is optional: when the backend can resolve a live rejection to an
 * item, any road touching that item is upgraded to the worst band and says so in its rationale.
 */
export function gradeRoads(
  routes: readonly CapacityCityRoute[],
  families: readonly OperationFamily[],
  liveBlocking: readonly LiveBlockingEdge[] = [],
): RoadTraffic[] {
  const blockedKeys = new Set(liveBlocking.filter(edge => edge.blockedSessionCount > 0).map(edge => edge.objectKey))
  return routes.map(route => {
    const { operations, familyIds } = roadVolume(route, families)
    const matched = families.filter(family => familyIds.includes(family.familyId))
    const share = throttleShare(matched)
    const retainedDelay = roadDelay(matched)
    const recent = recentRoadDelay(matched)
    // The window wins wherever it exists, including when it is empty: a street that carried nothing
    // in the last quarter of an hour is not congested now, whatever the day's totals say. Only a
    // page that never published a window falls back to those totals.
    const delay = recent.published ? recent.delay : retainedDelay
    const capturedGrade = congestionFromDelay(delay)
    const blocked = blockedKeys.has(route.fromItemId) || blockedKeys.has(route.toItemId)
    const grade = blocked ? LIVE_BLOCKING_GRADE : capturedGrade
    const split = classSplit(matched, familyIds)
    return {
      routeId: route.routeId,
      fromItemId: route.fromItemId,
      toId: route.toItemId,
      kind: route.kind,
      confidence: route.confidence,
      pattern: confidencePattern(route.confidence),
      width: ROAD_WIDTH,
      grade,
      color: CONGESTION_COLORS[grade],
      operations,
      carOperations: operations === null ? null : split.car,
      freightOperations: operations === null ? null : split.freight,
      throttleShare: share,
      delayPerOperation: delay,
      recentOperations: recent.operations,
      recentWindowMinutes: recent.windowMinutes,
      familyIds,
      rationale: describe(operations, familyIds.length, share, delay, grade, blocked, recent, split),
    }
  })
}

function describe(
  operations: number | null,
  familyCount: number,
  share: number | null,
  delay: number | null,
  grade: CongestionGrade,
  blocked: boolean,
  recent: ReturnType<typeof recentRoadDelay>,
  split: { car: number; freight: number },
): string {
  const volume =
    operations === null
      ? 'No operation family names both endpoints, so no traffic volume is claimed.'
      : `${operations.toLocaleString()} operation(s) across ${familyCount} family/families — `
        + `${split.car.toLocaleString()} interactive (cars), ${split.freight.toLocaleString()} background (freight).`
  if (blocked) {
    return `${volume} Graded ${CONGESTION_LABELS[grade].toLowerCase()} because a live rejection resolves to an endpoint of this road.`
  }
  if (recent.published && !recent.covered) {
    return `${volume} Nothing was reported in the last ${recent.windowMinutes} minutes, so no current congestion grade is claimed — that is missing capture, not a clear road.`
  }
  if (delay === null) {
    return `${volume} Throttling per operation is unavailable, so no congestion grade is claimed.`
  }
  const shareText = share === null ? '' : `, ${(share * 100).toFixed(1)}% of measured duration`
  if (recent.published) {
    return `${(recent.operations ?? 0).toLocaleString()} operation(s) in the last ${recent.windowMinutes} minutes, ${delay.toFixed(2)} s of throttling each — ${CONGESTION_LABELS[grade].toLowerCase()}. ${volume}`
  }
  return `${volume} ${delay.toFixed(2)} s of throttling per operation${shareText} — ${CONGESTION_LABELS[grade].toLowerCase()}.`
}

function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export interface TrafficWindowDisclosure {
  headline: string
  detail: string
  windowMinutes: number | null
  covered: boolean
}

/**
 * What the road colours on this page were actually graded from, in words.
 *
 * The colours are the last few minutes of throttling, not the whole retained history. A map that
 * quietly swapped one for the other would be reporting a different claim under an unchanged legend,
 * so the legend has to say which one it is — including the awkward case where the window is
 * published and empty, which is grey rather than green and looks like a fault unless it is explained.
 */
export function describeTrafficWindow(
  families: readonly OperationFamily[],
  refreshedAt: string | null,
  refreshIntervalMs: number,
): TrafficWindowDisclosure {
  let published = false
  let covered = false
  let windowMinutes: number | null = null
  for (const family of families) {
    const recent = family.recentActivity
    if (!recent) continue
    published = true
    if (windowMinutes === null) windowMinutes = recent.windowMinutes
    if (recent.covered) covered = true
  }

  const seconds = Math.max(1, Math.round(refreshIntervalMs / 1000))
  const cadence = refreshedAt === null
    ? `The city re-reads itself every ${seconds} seconds.`
    : `The city re-reads itself every ${seconds} seconds; last read at ${new Date(refreshedAt).toLocaleTimeString()}.`

  if (!published) {
    return {
      headline: 'Road colour is the whole retained history.',
      detail: 'This page published no recent-activity window, so the colours are cumulative totals '
        + 'over everything the source still retains rather than a reading of current traffic.',
      windowMinutes: null,
      covered: false,
    }
  }

  if (!covered) {
    return {
      headline: `The source reported nothing in the last ${windowMinutes} minutes.`,
      detail: `Every road is drawn grey: unmeasured, not clear. ${cadence}`,
      windowMinutes,
      covered: false,
    }
  }

  return {
    headline: `Road colour is throttling per operation over the last ${windowMinutes} minutes.`,
    detail: 'Capacity Metrics buckets its activity into intervals, so a bucket overlapping the '
      + 'window is counted whole rather than pro-rated — it never said how the work was spread '
      + `inside it. Roads no interval covered are grey, not green. ${cadence}`,
    windowMinutes,
    covered: true,
  }
}

/* ------------------------------------------------------------------ *
 * Whether roads can be drawn at all
 * ------------------------------------------------------------------ */

/**
 * Whether this source can report roads, and if so whether it did.
 *
 * `operationFamilies` and `operationSamples` are declared as separate capabilities on the source
 * seam, and the Eventhouse feed reports both false — it knows nothing below the capacity. A source
 * that cannot answer returns an **empty array** rather than throwing (`source.ts`), so an empty
 * family list is ambiguous: it is either a measured-quiet capacity or one whose source cannot see
 * roads at all. Those are different claims and the map must not draw them the same way.
 *
 * - `unsupported` — the source cannot report families. Roads are unknowable; draw none and say so.
 * - `none` — the source can report families and returned none. A genuinely measured-quiet capacity.
 * - `measured` — families were reported.
 */
export type TrafficEvidenceState = 'measured' | 'none' | 'unsupported'

export function trafficEvidenceState(
  capabilities: Pick<CapacitySourceCapabilities, 'operationFamilies'>,
  families: readonly OperationFamily[],
): TrafficEvidenceState {
  if (!capabilities.operationFamilies) return 'unsupported'
  return families.length === 0 ? 'none' : 'measured'
}

export interface TrafficEvidenceDisclosure {
  state: TrafficEvidenceState
  /** True when roads should be drawn from families; false when the road layer is withheld. */
  drawRoads: boolean
  headline: string
  detail: string
}

/**
 * The words that go with {@link trafficEvidenceState}, so an unmeasured road layer is announced
 * rather than looking like an empty city.
 */
export function describeTrafficEvidence(
  capabilities: Pick<CapacitySourceCapabilities, 'operationFamilies'>,
  families: readonly OperationFamily[],
): TrafficEvidenceDisclosure {
  const state = trafficEvidenceState(capabilities, families)
  switch (state) {
    case 'unsupported':
      return {
        state,
        drawRoads: false,
        headline: 'This source cannot report operation families.',
        detail: 'The road layer is withheld rather than drawn empty: an absent capability is not a '
          + 'quiet capacity, and a city with no roads here would otherwise claim the capacity ran '
          + 'no traffic when the truth is the source cannot see it.',
      }
    case 'none':
      return {
        state,
        drawRoads: false,
        headline: 'The source reported no operation families for this page.',
        detail: 'Roads are drawn from operation families, and none were reported, so there are no '
          + 'roads to draw. This is a measured absence — the source can report families and did not.',
      }
    case 'measured':
      return {
        state,
        drawRoads: true,
        headline: 'Roads are graded from measured operation families.',
        detail: 'Each road carries the throttling per operation of the families naming both of its '
          + 'endpoints; a pair no family names is drawn grey, not green.',
      }
  }
}
