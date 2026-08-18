import type { EdgeConfidence } from './contracts'
import type { DatabaseCityQueryFamily, DatabaseCityRoute } from './databaseCityContracts'

/**
 * Turns co-reference edges into roads with a measured width and a GPS-style congestion colour.
 *
 * Two independent dimensions are encoded, and they are deliberately carried by two independent
 * visual channels so neither hides the other:
 *
 * - **width**  = how much captured traffic uses the road (executions of the query families that name
 *   both endpoints), on a documented log2 scale.
 * - **colour** = how much of that traffic's wall-clock time was spent waiting, graded like a traffic
 *   map. Confidence moved to the line *pattern* precisely because colour is now spoken for.
 *
 * A road with no co-referencing family evidence is **not** claimed to be quiet: it is graded
 * `unknown` and drawn as a grey dashed wireframe, because "Query Store captured nothing about this
 * pair" and "this pair is idle" are different statements and only the first one is supported.
 */

export type CongestionGrade = 'low' | 'medium' | 'high' | 'unknown'

/** GPS palette. `unknown` is deliberately a desaturated grey so it never reads as "clear". */
export const CONGESTION_COLORS: Readonly<Record<CongestionGrade, number>> = {
  low: 0x39c46b,
  medium: 0xe8b13a,
  high: 0xe4483c,
  unknown: 0x5a6270,
}

export const CONGESTION_LABELS: Readonly<Record<CongestionGrade, string>> = {
  low: 'Low wait share',
  medium: 'Medium wait share',
  high: 'High wait share',
  unknown: 'No captured wait evidence',
}

/**
 * Wait share thresholds, as a fraction of total captured duration spent waiting. Query Store records
 * wait time in milliseconds and duration in microseconds, so the ratio is computed after converting
 * both to milliseconds.
 */
export const MEDIUM_WAIT_SHARE = 0.2
export const HIGH_WAIT_SHARE = 0.5

/** Live blocking overrides the Query Store grade: a session blocked right now is high congestion. */
export const LIVE_BLOCKING_GRADE: CongestionGrade = 'high'

export const MIN_ROAD_WIDTH = 2.2
export const ROAD_WIDTH_PER_DOUBLING = 0.85
export const MAX_ROAD_WIDTH = 11

/** Line pattern carries edge confidence now that colour carries congestion. */
export type RoadPattern = 'solid' | 'dashed' | 'sparse'

export interface RoadTraffic {
  readonly routeId: string
  readonly fromObjectId: string
  readonly toId: string
  readonly kind: DatabaseCityRoute['kind']
  readonly confidence: EdgeConfidence
  readonly pattern: RoadPattern
  readonly width: number
  readonly grade: CongestionGrade
  readonly color: number
  /** Total executions of families naming both endpoints, or null when none were captured. */
  readonly executions: number | null
  /** Captured wait time as a share of captured duration, or null when unmeasured. */
  readonly waitShare: number | null
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
  route: Pick<DatabaseCityRoute, 'fromObjectId' | 'toId'>,
  families: readonly DatabaseCityQueryFamily[],
): { executions: number | null; familyIds: string[] } {
  const familyIds: string[] = []
  let executions = 0
  for (const family of families) {
    if (!family.objectIds.includes(route.fromObjectId)) continue
    if (!family.objectIds.includes(route.toId)) continue
    familyIds.push(family.familyId)
    executions += toNumber(family.executionCount) ?? 0
  }
  return familyIds.length === 0 ? { executions: null, familyIds } : { executions, familyIds }
}

/**
 * Road width in world units. Every doubling of captured executions adds
 * {@link ROAD_WIDTH_PER_DOUBLING}, so the scale is readable across the many orders of magnitude
 * Query Store execution counts span. Unmeasured roads render at the minimum width and are
 * distinguished by their grey `unknown` colour, never by being invisible.
 */
export function roadWidth(executions: number | null): number {
  if (executions === null || executions <= 0) return MIN_ROAD_WIDTH
  return Math.min(MAX_ROAD_WIDTH, MIN_ROAD_WIDTH + Math.log2(1 + executions) * ROAD_WIDTH_PER_DOUBLING)
}

/**
 * Fraction of captured wall-clock time spent waiting, or null when either side is unmeasured.
 * `totalWaitMilliseconds` and `totalDurationMicroseconds` are lossless base-10 strings, so they are
 * parsed defensively.
 */
export function waitShare(families: readonly DatabaseCityQueryFamily[]): number | null {
  let waitMs = 0
  let durationMs = 0
  let sawDuration = false
  for (const family of families) {
    const wait = toNumber(family.totalWaitMilliseconds)
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

export function congestionGrade(share: number | null): CongestionGrade {
  if (share === null || !Number.isFinite(share)) return 'unknown'
  if (share >= HIGH_WAIT_SHARE) return 'high'
  if (share >= MEDIUM_WAIT_SHARE) return 'medium'
  return 'low'
}

export function confidencePattern(confidence: EdgeConfidence): RoadPattern {
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
 * object, any road touching that object is upgraded to `high` and says so in its rationale.
 */
export function gradeRoads(
  routes: readonly DatabaseCityRoute[],
  families: readonly DatabaseCityQueryFamily[],
  liveBlocking: readonly LiveBlockingEdge[] = [],
): RoadTraffic[] {
  const blockedKeys = new Set(liveBlocking.filter(edge => edge.blockedSessionCount > 0).map(edge => edge.objectKey))
  return routes.map(route => {
    const { executions, familyIds } = roadVolume(route, families)
    const matched = families.filter(family => familyIds.includes(family.familyId))
    const share = waitShare(matched)
    const capturedGrade = congestionGrade(share)
    const blocked = blockedKeys.has(route.fromObjectId) || blockedKeys.has(route.toId)
    const grade = blocked ? LIVE_BLOCKING_GRADE : capturedGrade
    return {
      routeId: route.routeId,
      fromObjectId: route.fromObjectId,
      toId: route.toId,
      kind: route.kind,
      confidence: route.confidence,
      pattern: confidencePattern(route.confidence),
      width: roadWidth(executions),
      grade,
      color: CONGESTION_COLORS[grade],
      executions,
      waitShare: share,
      familyIds,
      rationale: describe(executions, familyIds.length, share, grade, blocked),
    }
  })
}

function describe(
  executions: number | null,
  familyCount: number,
  share: number | null,
  grade: CongestionGrade,
  blocked: boolean,
): string {
  const volume =
    executions === null
      ? 'No captured query family names both endpoints, so no traffic volume is claimed; drawn at minimum width.'
      : `${executions.toLocaleString()} captured execution(s) across ${familyCount} query family/families.`
  if (blocked) {
    return `${volume} Graded ${grade} because a live lock wait resolves to an endpoint of this road.`
  }
  const wait =
    share === null
      ? 'Captured wait share is unavailable, so no congestion grade is claimed.'
      : `${(share * 100).toFixed(1)}% of captured duration was spent waiting (${CONGESTION_LABELS[grade].toLowerCase()}).`
  return `${volume} ${wait}`
}

function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
