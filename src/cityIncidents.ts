import type {
  CapacityCityItem,
  OperationFamily,
  OperationSample,
} from './capacityCityContracts'
import type { Evidence, ThrottleStage, ThrottleState } from './fabricContracts'
import { attributedThrottling } from './cityThrottleAttribution'
import {
  facilityForThrottleStage,
  POWER_GRID_FACILITIES,
  type PowerGridFacilityKind,
  type PowerGridThrottleStage,
} from './powerGrid'
import { liveRejectionEdges, type LiveRejectionSummary } from './cityBlocking'
import type { CapacitySourceCapabilities } from './collect/source'

/**
 * Turns a Fabric capacity's throttling into map pins.
 *
 * SQLSimCity pinned a *blocking chain* here: a blocked session marked on the table whose lock it was
 * queued behind, with a popup naming the blocker. Fabric throttling is not a lock — it is the
 * capacity's response to sustained overload, escalating **interactive delay → interactive rejection
 * → background rejection**. So a **throttling incident** pins to the item whose operations drove the
 * overload, and the popup names the stage it reached, the operations responsible, and the
 * carry-forward debt behind it.
 *
 * This module composes the pieces that already landed rather than re-deriving them:
 *
 * - `cityThrottleAttribution.attributedThrottling` places measured `throttlingSeconds` onto one
 *   honest item × stage, refusing to attribute anything the operation class, rejected count or
 *   throttle gauge cannot justify. That is where a marker's item, stage and responsible families
 *   come from.
 * - `powerGrid` names the civic facility each stage belongs to, so a marker can say which gate it is
 *   about.
 * - `cityBlocking.liveRejectionEdges` resolves live rejected operations onto loaded items — the
 *   "right now" corroboration, and the wire that grades roads.
 *
 * The rule that governs everything here is the rule the whole visualization rests on: **an absence
 * of reported throttling is not an absence of throttling.** A source that cannot see operations or
 * cannot read the throttle gauges yields `unsupported`, which the UI must render as "not observed",
 * never as "all clear". The vocabulary (`unsupported` / `none` / `measured`) is the same one
 * `cityTraffic` uses for its road layer, deliberately.
 */

/**
 * How severe a throttling incident is.
 *
 * The ladder is load-bearing and must never collapse. An **interactive delay** adds ~20s to a
 * request: a busy city, not a broken one, and `capacityAtlas.isRejecting` deliberately excludes it
 * for exactly this reason. A **rejection** is work the capacity actually turned away. Ranking a
 * delay level with a rejection would cry wolf, so `delay` is strictly below both rejection stages.
 */
export type IncidentSeverity = 'delay' | 'interactiveRejection' | 'backgroundRejection'

/**
 * Severity order, low to high, following the throttle escalation ladder. Background rejection is the
 * deepest stage: the 24-hour gauge is over the line, which by the contract implies the other two are
 * too, so even background work is being refused.
 */
export const SEVERITY_RANK: Readonly<Record<IncidentSeverity, number>> = Object.freeze({
  delay: 0,
  interactiveRejection: 1,
  backgroundRejection: 2,
})

export function incidentSeverityRank(severity: IncidentSeverity): number {
  return SEVERITY_RANK[severity]
}

/** True for the stages that turn work away. A delay is not a rejection; it queues and proceeds. */
export function isRejectionSeverity(severity: IncidentSeverity): boolean {
  return severity !== 'delay'
}

export const SEVERITY_LABELS: Readonly<Record<IncidentSeverity, string>> = Object.freeze({
  delay: 'Interactive delay',
  interactiveRejection: 'Interactive rejection',
  backgroundRejection: 'Background rejection',
})

export interface IncidentMarker {
  readonly id: string
  /** The item whose operations drove the overload — where the pin sits. */
  readonly itemId: string
  /**
   * Other loaded items the responsible operations also touched. Used to put the pin on the road
   * *between* the driven item and what it exchanges work with, rather than on one roof; see
   * `cityIncidentPlacement`. Usually empty, because most operations name a single item.
   */
  readonly counterpartObjectIds: readonly string[]
  readonly severity: IncidentSeverity
  readonly stage: PowerGridThrottleStage
  /** The civic facility (throttle gate) this incident belongs to. */
  readonly facility: PowerGridFacilityKind
  /** The operation families that drove this incident, for drill-down. */
  readonly familyIds: readonly string[]
  /** Measured throttling seconds attributed to this item × stage; 0 for a live-only rejection. */
  readonly throttlingSeconds: number
  /** Operations the source reported rejected at this item right now; 0 when none were sampled. */
  readonly liveRejections: number
  /** One line naming what is happening. Never a judgement, always the observation. */
  readonly headline: string
  /** The measured facts behind the headline, each already formatted for display. */
  readonly details: readonly string[]
  readonly source: string
  readonly observedAt: string
}

/**
 * Whether the incident layer is measured, quiet, or unknowable.
 *
 * The same three-way state `cityTraffic` uses. `none` is the only one that may be read as "all
 * clear"; `unsupported` must be rendered as "not observed", because a source that cannot see
 * operations or gauges has said nothing about whether the capacity is throttling.
 */
export type IncidentEvidenceState = 'measured' | 'none' | 'unsupported'

export interface IncidentProjection {
  readonly markers: readonly IncidentMarker[]
  readonly evidence: IncidentEvidenceState
  /** Capacity-wide throttle stage, for context in the summary. */
  readonly stage: ThrottleStage
  /** The carry-forward debt behind the throttling, shown in every popup. */
  readonly carryForward: {
    readonly cumulativeCarryOverPercent: number | null
    readonly expectedBurndownMinutes: number | null
  }
  /**
   * Measured throttling seconds that are real but could not be pinned to a drawn item — the item was
   * off this page, or the operation class / rejected count / gauge did not identify one honest gate.
   * Counted so the absence of a pin is never read as the absence of a problem.
   */
  readonly unattributedSeconds: number
  /** Families that carried no throttling measurement at all. */
  readonly unmeasuredFamilyCount: number
  /** Live rejections resolving to an item outside this bounded page. Counted, never pinned. */
  readonly offPageRejectionCount: number
  /** Live rejections on a loaded item whose class the source could not name, so no gate is claimed. */
  readonly unclassedRejectionCount: number
  /** The full live rejection summary, including the `edges` wire `gradeRoads` consumes. */
  readonly liveRejections: LiveRejectionSummary
  /** Why the projection is what it is, in words. */
  readonly reason: string
}

export interface IncidentProjectionInput {
  readonly families: readonly OperationFamily[]
  readonly items: readonly CapacityCityItem[]
  readonly samples: readonly OperationSample[] | null
  readonly throttle: ThrottleState
  readonly capabilities: Pick<CapacitySourceCapabilities, 'operationFamilies' | 'operationSamples'>
  /** When this page was observed. Used as the marker timestamp when evidence carries none. */
  readonly observedAt: string
}

interface MutableMarker {
  itemId: string
  stage: PowerGridThrottleStage
  facility: PowerGridFacilityKind
  familyIds: Set<string>
  throttlingSeconds: number
  liveRejections: number
}

/**
 * Whether an incident marker halts a vehicle that reaches it.
 *
 * Only a **rejection** stops traffic: the operation was turned away, so the trip does not complete.
 * An interactive delay does not stop it — the request queues at the delay gate and then proceeds, so
 * its car keeps moving, only slower. This is the severity ladder applied to the traffic layer, and
 * collapsing it would park cars at a gate that is merely busy.
 *
 * Exported rather than inlined at the scene's call site so the rule can be tested across every
 * severity directly; inline it and the only thing describing it is a comment, which no suite reads.
 */
export function stopsTraffic(marker: Pick<IncidentMarker, 'severity'>): boolean {
  return isRejectionSeverity(marker.severity)
}

export function severityForStage(stage: PowerGridThrottleStage): IncidentSeverity {
  switch (stage) {
    case 'InteractiveDelay':
      return 'delay'
    case 'InteractiveRejection':
      return 'interactiveRejection'
    case 'BackgroundRejection':
      return 'backgroundRejection'
  }
}

export function projectIncidents(input: IncidentProjectionInput): IncidentProjection {
  const { families, items, samples, throttle, capabilities, observedAt } = input

  const drawn = new Set(items.map(item => item.itemId))
  const itemNames = new Map(items.map(item => [item.itemId, item.name]))
  const familyById = new Map(families.map(family => [family.familyId, family]))
  const totals = attributedThrottling(families, throttle, drawn)
  const live = liveRejectionEdges(samples, items, capabilities)

  const markerObservedAt = throttle.evidence.observedAt ?? observedAt
  const markers = new Map<string, MutableMarker>()

  // Retained window: the operations that drove the overload, one honest item × stage each.
  for (const attribution of totals.byItemStage.values()) {
    const marker = ensureMarker(markers, attribution.itemId, attribution.stage, attribution.facility)
    marker.throttlingSeconds += attribution.seconds
    for (const familyId of attribution.familyIds) marker.familyIds.add(familyId)
  }

  // Live rejections: operations the capacity is turning away right now. These corroborate a retained
  // marker where one exists, and stand up a marker on their own where the retained window has not
  // caught up — a rejection is a measured fact and must not be invisible for want of an attribution.
  let unclassedRejectionCount = 0
  for (const liveItem of live.items) {
    const classed: Array<[PowerGridThrottleStage, number]> = []
    if (liveItem.interactiveRejections > 0) classed.push(['InteractiveRejection', liveItem.interactiveRejections])
    if (liveItem.backgroundRejections > 0) classed.push(['BackgroundRejection', liveItem.backgroundRejections])
    unclassedRejectionCount += liveItem.unknownClassRejections
    for (const [stage, count] of classed) {
      const marker = ensureMarker(markers, liveItem.itemId, stage, facilityForThrottleStage(stage))
      marker.liveRejections += count
      // A live-only marker still names the operations that reach this item, so it can find its road.
      if (marker.familyIds.size === 0) {
        for (const familyId of familiesNaming(liveItem.itemId, families)) marker.familyIds.add(familyId)
      }
    }
  }

  const finished = [...markers.values()]
    .map(marker => finishMarker(marker, familyById, drawn, itemNames, throttle, markerObservedAt))
    .sort(byWorstThenItem)

  const evidence = incidentEvidenceState(capabilities, throttle, finished.length, live.state)

  return {
    markers: finished,
    evidence,
    stage: throttle.stage,
    carryForward: {
      cumulativeCarryOverPercent: finiteOrNull(throttle.cumulativeCarryOverPercent),
      expectedBurndownMinutes: finiteOrNull(throttle.expectedBurndownMinutes),
    },
    unattributedSeconds: totals.unattributedSeconds,
    unmeasuredFamilyCount: totals.unmeasuredFamilyCount,
    offPageRejectionCount: live.offPageCount,
    unclassedRejectionCount,
    liveRejections: live,
    reason: describeProjection(evidence, finished.length, totals.unattributedSeconds, live),
  }
}

function ensureMarker(
  markers: Map<string, MutableMarker>,
  itemId: string,
  stage: PowerGridThrottleStage,
  facility: PowerGridFacilityKind,
): MutableMarker {
  const key = `${itemId}:${stage}`
  const existing = markers.get(key)
  if (existing) return existing
  const created: MutableMarker = {
    itemId,
    stage,
    facility,
    familyIds: new Set<string>(),
    throttlingSeconds: 0,
    liveRejections: 0,
  }
  markers.set(key, created)
  return created
}

function finishMarker(
  marker: MutableMarker,
  familyById: ReadonlyMap<string, OperationFamily>,
  drawn: ReadonlySet<string>,
  itemNames: ReadonlyMap<string, string>,
  throttle: ThrottleState,
  observedAt: string,
): IncidentMarker {
  const severity = severityForStage(marker.stage)
  const familyIds = [...marker.familyIds].sort()
  const responsible = familyIds
    .map(id => familyById.get(id))
    .filter((family): family is OperationFamily => family !== undefined)
  const counterparts = counterpartsFor(marker.itemId, responsible, drawn)
  const name = itemNames.get(marker.itemId) ?? marker.itemId
  const definition = POWER_GRID_FACILITIES[marker.facility]

  const details: string[] = []
  details.push(
    marker.throttlingSeconds > 0
      ? `${formatSeconds(marker.throttlingSeconds)} of throttling attributed at the ${definition.label.toLocaleLowerCase()}.`
      : `Refused at the ${definition.label.toLocaleLowerCase()}; no throttling seconds were attributed to the retained window yet.`,
  )
  const operationNames = distinctOperationNames(responsible)
  details.push(
    operationNames.length > 0
      ? `Operations responsible: ${operationNames.join(', ')}.`
      : 'The source named no operation family for this item, so the responsible operations are not disclosed.',
  )
  const rejected = sumRejected(responsible)
  if (rejected !== null && rejected > 0) {
    details.push(`${rejected.toLocaleString()} operation(s) rejected in the retained window.`)
  }
  if (marker.liveRejections > 0) {
    details.push(`${marker.liveRejections.toLocaleString()} operation(s) rejected in the latest live sample.`)
  }
  details.push(carryForwardDetail(throttle))
  details.push(definition.civicRole)

  return {
    id: `throttle:${marker.itemId}:${marker.stage}`,
    itemId: marker.itemId,
    counterpartObjectIds: counterparts,
    severity,
    stage: marker.stage,
    facility: marker.facility,
    familyIds,
    throttlingSeconds: marker.throttlingSeconds,
    liveRejections: marker.liveRejections,
    headline: `${name} is throttled here — ${SEVERITY_LABELS[severity].toLocaleLowerCase()}`,
    details,
    source: `Capacity Metrics operation families and throttle gauges, attributed to the ${definition.label.toLocaleLowerCase()}`,
    observedAt,
  }
}

function counterpartsFor(
  itemId: string,
  responsible: readonly OperationFamily[],
  drawn: ReadonlySet<string>,
): string[] {
  const counterparts = new Set<string>()
  for (const family of responsible) {
    for (const other of family.itemIds) {
      if (other !== itemId && drawn.has(other)) counterparts.add(other)
    }
  }
  return [...counterparts].sort()
}

function familiesNaming(itemId: string, families: readonly OperationFamily[]): string[] {
  return families.filter(family => family.itemIds.includes(itemId)).map(family => family.familyId)
}

function distinctOperationNames(families: readonly OperationFamily[]): string[] {
  return [...new Set(families.map(family => family.operationName))].sort()
}

function sumRejected(families: readonly OperationFamily[]): number | null {
  let total = 0
  let any = false
  for (const family of families) {
    const value = family.counts.rejected
    if (value === null || value.trim() === '' || !/^\d+$/.test(value)) continue
    any = true
    total += Number(value)
  }
  return any ? total : null
}

function carryForwardDetail(throttle: ThrottleState): string {
  const percent = finiteOrNull(throttle.cumulativeCarryOverPercent)
  if (percent === null) {
    return 'Carry-forward debt was not reported, which is not the same as no debt.'
  }
  return `Carry-forward debt ${percent.toFixed(1)}% of the SKU budget; expected burndown ${burndownText(throttle.expectedBurndownMinutes)}.`
}

/**
 * Whether the incident layer can be claimed clear.
 *
 * A marker means it is plainly `measured`. With no markers, "all clear" may only be claimed when the
 * throttle gauges were readable (so a stage could have been seen) **and** at least one operation
 * source could report the work driving it. If the gauges are unmeasured, or the source can neither
 * report families nor samples, the layer is `unsupported` — not observed — because nothing has been
 * said about whether the capacity is throttling.
 */
export function incidentEvidenceState(
  capabilities: Pick<CapacitySourceCapabilities, 'operationFamilies' | 'operationSamples'>,
  throttle: ThrottleState,
  markerCount: number,
  liveState: LiveRejectionSummary['state'],
): IncidentEvidenceState {
  if (markerCount > 0) return 'measured'
  const gaugesKnown = reportsMeasurement(throttle.evidence)
  const operationsKnown = capabilities.operationFamilies || capabilities.operationSamples
  if (!gaugesKnown || !operationsKnown) return 'unsupported'
  // A live sample that resolved off-page proves the capacity is rejecting even with nothing pinned.
  if (liveState === 'measured') return 'measured'
  return 'none'
}

/* ------------------------------------------------------------------ *
 * Folded, one-line summaries — a narrow viewport may show only these
 * ------------------------------------------------------------------ */

/**
 * The one-line status the map shows about incidents.
 *
 * This exists so the map can never imply "all clear" when it does not know. `unsupported` says so
 * rather than collapsing into "No throttling", which is the claim this codebase refuses to make on
 * an absence of evidence.
 */
export function incidentSummaryLabel(projection: IncidentProjection): string {
  if (projection.evidence === 'unsupported') return 'Not observed'
  const count = projection.markers.length
  if (count > 0) return `${count} throttling incident${count === 1 ? '' : 's'}`
  if (projection.unattributedSeconds > 0 || projection.offPageRejectionCount > 0 || projection.unclassedRejectionCount > 0) {
    return 'Overload off-map'
  }
  return 'No throttling'
}

export function incidentSummaryTone(projection: IncidentProjection): 'is-alert' | 'is-unknown' | '' {
  if (projection.evidence === 'unsupported') return 'is-unknown'
  if (projection.markers.some(marker => isRejectionSeverity(marker.severity))) return 'is-alert'
  if (projection.markers.length > 0) return ''
  return projection.unattributedSeconds > 0
    || projection.offPageRejectionCount > 0
    || projection.unclassedRejectionCount > 0
    ? 'is-unknown'
    : ''
}

/** True when the projection has something a reader should not have to tap to find. */
export function incidentDemandsAttention(projection: IncidentProjection): boolean {
  return projection.evidence === 'unsupported'
    || projection.markers.length > 0
    || projection.unattributedSeconds > 0
    || projection.offPageRejectionCount > 0
    || projection.unclassedRejectionCount > 0
}

/** How many pinned incidents actually turned work away. A delay is not counted. */
export function rejectionIncidentCount(projection: IncidentProjection): number {
  return projection.markers.filter(marker => isRejectionSeverity(marker.severity)).length
}

/** How many pinned incidents are merely a delay — busy, not broken. */
export function delayIncidentCount(projection: IncidentProjection): number {
  return projection.markers.filter(marker => !isRejectionSeverity(marker.severity)).length
}

function describeProjection(
  evidence: IncidentEvidenceState,
  markerCount: number,
  unattributedSeconds: number,
  live: LiveRejectionSummary,
): string {
  if (evidence === 'unsupported') {
    return 'The throttle gauges or operation evidence were not reported, so no claim is made about '
      + 'whether this capacity is throttling. This is "not observed", not "all clear".'
  }
  if (markerCount === 0) {
    const offMap = unattributedSeconds > 0 || live.offPageCount > 0
    return offMap
      ? 'No throttling pinned to a drawn item, but measured overload could not be placed on this '
        + 'bounded page, so it is counted rather than drawn as clear.'
      : 'The gauges and operations were readable and nothing was throttled: a genuinely quiet capacity.'
  }
  return `${markerCount} throttling incident(s) pinned to the items whose operations drove the `
    + 'overload. Interactive delay is drawn apart from rejection, which is the only stage that turns '
    + 'work away.'
}

function reportsMeasurement(evidence: Evidence): boolean {
  return evidence.status === 'Available' || evidence.status === 'Stale'
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : value
}

function formatSeconds(seconds: number): string {
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)} ms`
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`
  return `${(seconds / 60).toFixed(1)} min`
}

function burndownText(minutes: number | null): string {
  const value = finiteOrNull(minutes)
  if (value === null) return 'unavailable'
  if (value < 1) return '<1 min'
  if (value < 60) return `${Math.round(value)} min`
  return `${(value / 60).toFixed(1)} h`
}

function byWorstThenItem(left: IncidentMarker, right: IncidentMarker): number {
  return (
    incidentSeverityRank(right.severity) - incidentSeverityRank(left.severity)
    || left.itemId.localeCompare(right.itemId)
    || left.stage.localeCompare(right.stage)
  )
}
