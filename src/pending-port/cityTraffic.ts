import type { LinkConfidence } from '../fabricContracts'
import type { OperationFamily, CapacityCityRoute } from '../capacityCityContracts'

/**
 * Turns co-reference edges into roads carrying a GPS-style congestion colour.
 *
 * Colour is the only channel this map spends on how busy a road is, and it is spent on one measured
 * ratio: the mean wait milliseconds a single captured execution carried over that road. Width used
 * to carry executions on a log2 scale and no longer does — every road is drawn at
 * {@link ROAD_WIDTH}. That is a deliberate trade: a GPS map codes congestion by colour alone, and
 * two channels competing for the same ribbon meant neither got read.
 *
 * **The measurement did not go anywhere.** `executions` stays on {@link RoadTraffic}, in the hover
 * rationale and in the evidence tables; it stopped being a *visual* channel, which is not the same
 * as being dropped. So did `waitShare`, which answers a different question about the same waiting
 * and is still written out per road.
 *
 * A road with no co-referencing family evidence is **not** claimed to be quiet: it is graded
 * `unknown` and drawn as a grey dashed wireframe, because "Query Store captured nothing about this
 * pair" and "this pair is idle" are different statements and only the first is supported. Folding
 * grey into green is the easiest way to make this map lie, so the grey is desaturated and nowhere
 * near the green.
 *
 * Confidence is carried by the line *pattern*, as it has been since colour was spoken for.
 */

/**
 * The GPS ladder: free-flowing, then three grades of delay, plus "not measured".
 *
 * Four bands rather than three because on a three-band ladder every road that waits at all lands in
 * amber, and most of a real workload waits a little. `unknown` is not a fifth band on that scale —
 * it is off the scale entirely.
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
  unknown: 'No captured wait evidence',
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
 * Grade thresholds, in milliseconds of captured waiting per captured execution.
 *
 * **Invented cut points on a measured ratio.** The milliseconds and the execution counts are both
 * Query Store's; where the line between amber and orange falls is a choice made here, and it is
 * stated rather than implied.
 *
 * The upper two are the cut points this codebase has graded street load by since it was first
 * drawn — 5 ms and 50 ms per execution — kept unchanged so nothing that was red turns green. The
 * fourth band splits what used to be a single `low`: under half a millisecond of waiting per
 * execution a road is free-flowing, and between that and 5 ms it is moving but not freely.
 */
export const MODERATE_DELAY_MS_PER_EXECUTION = 0.5
export const HEAVY_DELAY_MS_PER_EXECUTION = 5
export const SEVERE_DELAY_MS_PER_EXECUTION = 50

/** Live blocking overrides the Query Store grade: a session blocked right now is the worst band. */
export const LIVE_BLOCKING_GRADE: CongestionGrade = 'severe'

/**
 * One width for every road, in world units.
 *
 * Roads used to be sized by captured executions and are not any more, so the network reads as one
 * road network at a glance instead of as a chart. The value sits inside the old 2.2–11 range: no
 * road got thinner than the thinnest that used to be drawn, and none got thicker than the thickest.
 */
export const ROAD_WIDTH = 5.2

import type { RoadPattern } from '../cityRoads'
export type { RoadPattern }

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
  /** Total executions of families naming both endpoints, or null when none were captured. */
  readonly executions: number | null
  /** Captured wait time as a share of captured duration, or null when unmeasured. */
  readonly waitShare: number | null
  /** Mean captured wait milliseconds per captured execution — what the colour is graded from. */
  readonly delayPerExecution: number | null
  /**
   * Executions inside the recent traffic window, or null when nothing was captured in it. Distinct
   * from {@link executions}, which is the retained total across the whole horizon.
   */
  readonly recentExecutions: number | null
  /** Width of the recent traffic window in minutes, or null when the page published none. */
  readonly recentWindowMinutes: number | null
  /** Ids of the query families that produced this road's numbers, for drill-down. */
  readonly familyIds: readonly string[]
  /** Plain-language justification shown in the HUD, never omitted. */
  readonly rationale: string
}

export interface LiveBlockingEdge {
  /** Object id or `schema.object` of the object a blocked session is waiting on. */
  readonly objectKey: string
  readonly blockedSessionCount: number
}

/**
 * Sum of executions across every family naming both endpoints. Returns null when no family names the
 * pair, which is an absence of evidence rather than a measurement of zero.
 */
export function roadVolume(
  route: Pick<CapacityCityRoute, 'fromItemId' | 'toId'>,
  families: readonly OperationFamily[],
): { executions: number | null; familyIds: string[] } {
  const familyIds: string[] = []
  let executions = 0
  for (const family of families) {
    if (!family.itemIds.includes(route.fromItemId)) continue
    if (!family.itemIds.includes(route.toId)) continue
    familyIds.push(family.familyId)
    executions += toNumber(family.executionCount) ?? 0
  }
  return familyIds.length === 0 ? { executions: null, familyIds } : { executions, familyIds }
}

/**
 * Fraction of captured wall-clock time spent waiting, or null when either side is unmeasured.
 * `throttlingSeconds` and `totalDurationMicroseconds` are lossless base-10 strings, so they are
 * parsed defensively.
 *
 * No longer what the colour is graded from — see {@link roadDelay} — but still reported per road,
 * because "half of this road's time went on waiting" answers something the ratio does not.
 */
export function waitShare(families: readonly OperationFamily[]): number | null {
  let waitMs = 0
  let durationMs = 0
  let sawDuration = false
  for (const family of families) {
    const wait = toNumber(family.throttlingSeconds)
    const duration = toNumber(family.totalDurationMicroseconds)
    if (wait !== null) waitMs += wait
    if (duration !== null) {
      durationMs += duration / 1000
      sawDuration = true
    }
  }
  if (!sawDuration || durationMs <= 0) return null
  return waitMs / durationMs
}

/**
 * Mean captured wait milliseconds per captured execution across the families naming both endpoints.
 *
 * This is the same ratio the aggregate street load is graded by, so a road ribbon and the street it
 * runs along are coloured by one rule rather than by two that happen to share a palette. Null when
 * no family reported waiting or none reported executions: an unmeasured ratio is not a zero one.
 */
export function roadDelay(families: readonly OperationFamily[]): number | null {
  let waitMs = 0
  let executions = 0
  let sawWait = false
  for (const family of families) {
    const wait = toNumber(family.throttlingSeconds)
    const count = toNumber(family.executionCount)
    if (wait !== null) {
      waitMs += wait
      sawWait = true
    }
    if (count !== null) executions += count
  }
  if (!sawWait || executions <= 0) return null
  return waitMs / executions
}

/**
 * Mean wait milliseconds per execution inside the recent traffic window.
 *
 * Returns `null` for the delay whenever the window was published but nothing overlapped it, which
 * grades `unknown`. That is deliberately not `free`: a road nobody captured and a road nobody drove
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
  executions: number | null
  windowMinutes: number | null
} {
  let published = false
  let covered = false
  let waitMs = 0
  let executions = 0
  let windowMinutes: number | null = null
  for (const family of families) {
    const recent = family.recentActivity
    if (!recent) continue
    published = true
    if (windowMinutes === null) windowMinutes = recent.windowMinutes
    if (!recent.covered) continue
    covered = true
    waitMs += toNumber(recent.throttlingSeconds) ?? 0
    executions += toNumber(recent.executionCount) ?? 0
  }
  if (!published) return { delay: null, published: false, covered: false, executions: null, windowMinutes: null }
  if (!covered) return { delay: null, published: true, covered: false, executions: null, windowMinutes }
  // Covered with no executions is a measured quiet street, not an unmeasured one, so it grades free
  // rather than unknown. Query Store only writes a bucket when something ran, so this is rare.
  return { delay: executions > 0 ? waitMs / executions : 0, published: true, covered: true, executions, windowMinutes }
}

/** The ladder itself. Shared by the co-reference roads and by the aggregate street load. */
export function congestionFromDelay(delay: number | null): CongestionGrade {
  if (delay === null || !Number.isFinite(delay)) return 'unknown'
  if (delay >= SEVERE_DELAY_MS_PER_EXECUTION) return 'severe'
  if (delay >= HEAVY_DELAY_MS_PER_EXECUTION) return 'heavy'
  if (delay >= MODERATE_DELAY_MS_PER_EXECUTION) return 'moderate'
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

/**
 * Grades every route. `liveBlocking` is optional: when the backend can resolve a live lock wait to an
 * object, any road touching that object is upgraded to the worst band and says so in its rationale.
 */
export function gradeRoads(
  routes: readonly CapacityCityRoute[],
  families: readonly OperationFamily[],
  liveBlocking: readonly LiveBlockingEdge[] = [],
): RoadTraffic[] {
  const blockedKeys = new Set(liveBlocking.filter(edge => edge.blockedSessionCount > 0).map(edge => edge.objectKey))
  return routes.map(route => {
    const { executions, familyIds } = roadVolume(route, families)
    const matched = families.filter(family => familyIds.includes(family.familyId))
    const share = waitShare(matched)
    const retainedDelay = roadDelay(matched)
    const recent = recentRoadDelay(matched)
    // The window wins wherever it exists, including when it is empty: a street that carried nothing
    // in the last quarter of an hour is not congested now, whatever the day's totals say. Only a
    // page that never published a window falls back to those totals.
    const delay = recent.published ? recent.delay : retainedDelay
    const capturedGrade = congestionFromDelay(delay)
    const blocked = blockedKeys.has(route.fromItemId) || blockedKeys.has(route.toId)
    const grade = blocked ? LIVE_BLOCKING_GRADE : capturedGrade
    return {
      routeId: route.routeId,
      fromItemId: route.fromItemId,
      toId: route.toId,
      kind: route.kind,
      confidence: route.confidence,
      pattern: confidencePattern(route.confidence),
      width: ROAD_WIDTH,
      grade,
      color: CONGESTION_COLORS[grade],
      executions,
      waitShare: share,
      delayPerExecution: delay,
      recentExecutions: recent.executions,
      recentWindowMinutes: recent.windowMinutes,
      familyIds,
      rationale: describe(executions, familyIds.length, share, delay, grade, blocked, recent),
    }
  })
}

function describe(
  executions: number | null,
  familyCount: number,
  share: number | null,
  delay: number | null,
  grade: CongestionGrade,
  blocked: boolean,
  recent: ReturnType<typeof recentRoadDelay>,
): string {
  const volume =
    executions === null
      ? 'No captured query family names both endpoints, so no traffic volume is claimed.'
      : `${executions.toLocaleString()} captured execution(s) across ${familyCount} query family/families.`
  if (blocked) {
    return `${volume} Graded ${CONGESTION_LABELS[grade].toLowerCase()} because a live lock wait resolves to an endpoint of this road.`
  }
  if (recent.published && !recent.covered) {
    return `${volume} Nothing was captured in the last ${recent.windowMinutes} minutes, so no current congestion grade is claimed — that is missing capture, not a clear road.`
  }
  if (delay === null) {
    return `${volume} Captured waiting per execution is unavailable, so no congestion grade is claimed.`
  }
  const shareText = share === null ? '' : `, ${(share * 100).toFixed(1)}% of captured duration`
  if (recent.published) {
    return `${(recent.executions ?? 0).toLocaleString()} execution(s) in the last ${recent.windowMinutes} minutes, ${delay.toFixed(2)} ms of waiting each — ${CONGESTION_LABELS[grade].toLowerCase()}. ${volume}`
  }
  return `${volume} ${delay.toFixed(2)} ms of captured waiting per execution${shareText} — ${CONGESTION_LABELS[grade].toLowerCase()}.`
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
 * The colours changed meaning: they used to be the whole retained history and are now the last few
 * minutes of it. A map that quietly swapped one for the other would be reporting a different claim
 * under an unchanged legend, so the legend has to say which one it is -- including the awkward case
 * where the window is published and empty, which is grey rather than green and looks like a fault
 * unless it is explained.
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
        + 'over everything Query Store still retains rather than a reading of current traffic.',
      windowMinutes: null,
      covered: false,
    }
  }

  if (!covered) {
    return {
      headline: `Query Store captured nothing in the last ${windowMinutes} minutes.`,
      detail: `Every road is drawn grey: unmeasured, not clear. ${cadence}`,
      windowMinutes,
      covered: false,
    }
  }

  return {
    headline: `Road colour is wait per execution over the last ${windowMinutes} minutes.`,
    detail: 'Query Store buckets its runtime statistics into intervals, so a bucket overlapping the '
      + 'window is counted whole rather than pro-rated -- it never said how the work was spread '
      + `inside it. Roads no interval covered are grey, not green. ${cadence}`,
    windowMinutes,
    covered: true,
  }
}
