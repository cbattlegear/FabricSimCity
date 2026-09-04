import type { CapacityCityItem, OperationClass, OperationFamily } from './capacityCityContracts'
import type { ThrottleState } from './fabricContracts'
import {
  attributedThrottling,
  type ItemThrottleAttribution,
} from './cityThrottleAttribution'
import {
  POWER_GRID_FACILITIES,
  POWER_GRID_FACILITY_ORDER,
  type PowerGridFacilityKind,
  type PowerGridFacilityState,
  type PowerGridMeasurementKind,
  type PowerGridThrottleStage,
} from './powerGrid'
import {
  CONGESTION_COLORS,
  CONGESTION_GRADES,
  CONGESTION_LABELS,
  congestionFromDelay,
  trafficEvidenceState,
  trafficModeForClass,
  type CongestionGrade,
  type TrafficEvidenceState,
  type TrafficMode,
} from './cityTraffic'
import type { CapacitySourceCapabilities } from './collect/source'

/**
 * Wires the power-grid facilities into the city's lanes, so measured throttling *goes somewhere*
 * visually instead of sitting as a number in a panel.
 *
 * SQLSimCity spread Query Store wait categories over six civic facilities and drew a lane from each
 * building to the resource its workload queued for. Fabric has no wait categories; it has operation
 * families, each carrying measured throttling seconds, and a capacity-wide throttle state whose gates
 * are the power grid's brownout/blackout ladder. So the lane now runs from the building whose work
 * was throttled to the **gate** that held it — delay gate, interactive rejection gate, or background
 * rejection gate — carrying the seconds {@link ./cityThrottleAttribution} attributed there.
 *
 * The routing itself is {@link ./cityThrottleAttribution}'s job: it only places measured seconds when
 * the operation class, rejected count and throttle gauge identify one honest gate. This module turns
 * each `(item, stage)` attribution into a drawable lane and grades its colour.
 *
 * Three rules survive the port intact:
 *
 * 1. **Coloured by the same rule as the roads.** A lane's colour is `congestionFromDelay` of the mean
 *    throttling seconds one operation carried on it — the exact ladder {@link ./cityTraffic} and
 *    {@link ./cityWorkloadTraffic} grade with — so a lane and the street beside it never disagree.
 * 2. **The delay gate is load, never blackout.** A lane reaching the delay gate is `delayed`; only the
 *    two rejection gates are `refused`. Interactive delay pads a request by up to 20s — a busy city,
 *    not a broken one — and rendering it as a blackout would cry wolf.
 * 3. **An unmeasured facility stays unbuilt.** A family with no measured throttling seconds produces
 *    no attribution and therefore no lane, and a lane whose contributing families reported no
 *    operation count grades `unknown` (grey), never `free` (green). A quiet green lane is a claim the
 *    telemetry did not make.
 */

/** Whether traffic reaching a gate is delayed (load) or refused (blackout). */
export type GateOutcome = 'delayed' | 'refused'

/** One width for every lane, in world units, so magnitude lives in colour and text, not thickness. */
export const LANE_WIDTH = 4.4

/**
 * The gate a stage's traffic ends at either delays work or refuses it.
 *
 * `InteractiveDelay` is the delay gate and is **always** `delayed`: it adds latency, it does not turn
 * work away. The two rejection stages refuse work and are `refused`. This is the single source of
 * truth for the load/blackout distinction, so both the lane and the legend read it from here.
 */
export function gateOutcomeForStage(stage: PowerGridThrottleStage): GateOutcome {
  return stage === 'InteractiveDelay' ? 'delayed' : 'refused'
}

/** Which operation class queues at a stage's gate, for the car/freight split. */
function operationClassForStage(stage: PowerGridThrottleStage): OperationClass {
  return stage === 'BackgroundRejection' ? 'Background' : 'Interactive'
}

/** One building's measured throttling to one power-grid gate. */
export interface FacilityLane {
  readonly laneId: string
  readonly itemId: string
  readonly stage: PowerGridThrottleStage
  readonly facility: PowerGridFacilityKind
  readonly facilityLabel: string
  /** Measured throttling seconds routed from this item to this gate. Always > 0. */
  readonly throttlingSeconds: number
  /** Operations of the families feeding this lane, or null when none reported a count. */
  readonly operations: number | null
  /** Mean throttling seconds one operation carried — what the colour is graded from, or null. */
  readonly delayPerOperation: number | null
  readonly grade: CongestionGrade
  readonly color: number
  /** Interactive lanes travel as cars, background as freight. */
  readonly mode: TrafficMode
  /** Delayed (load) at the delay gate; refused (blackout) at a rejection gate. Never confused. */
  readonly outcome: GateOutcome
  readonly width: number
  readonly familyIds: readonly string[]
  readonly rationale: string
}

export interface FacilityTraffic {
  /** Lanes from a building to a gate, busiest first. Absent items/gates are unbuilt, not zero-load. */
  readonly lanes: readonly FacilityLane[]
  /** Whether the source can report families at all, so an unmeasured layer is withheld not drawn. */
  readonly evidence: TrafficEvidenceState
  readonly measuredFamilyCount: number
  readonly unmeasuredFamilyCount: number
  readonly familyCount: number
  /** Total measured throttling seconds across every family, attributed or not. */
  readonly measuredSeconds: number
  /** Measured seconds that identified no honest gate, so no lane carries them. */
  readonly unattributedSeconds: number
  readonly note: string
}

/**
 * Projects measured throttling onto lanes from each building to the gate that held its work.
 *
 * `items` bounds the lanes to the buildings actually on this page: a family whose item is off-page
 * keeps its seconds in {@link FacilityTraffic.unattributedSeconds} rather than drawing a lane from a
 * building the page never placed. `capabilities` follows {@link ./cityTraffic}: a source that cannot
 * report operation families withholds the whole lane layer instead of drawing an empty measured city.
 */
export function projectFacilityTraffic(
  families: readonly OperationFamily[],
  items: readonly Pick<CapacityCityItem, 'itemId'>[],
  throttle: ThrottleState,
  capabilities?: Pick<CapacitySourceCapabilities, 'operationFamilies'>,
): FacilityTraffic {
  const drawn = new Set(items.map(item => item.itemId))
  const totals = attributedThrottling(families, throttle, drawn)
  const familyById = new Map(families.map(family => [family.familyId, family]))

  const lanes = [...totals.byItemStage.values()]
    .map(attribution => buildLane(attribution, familyById))
    .sort(
      (left, right) =>
        right.throttlingSeconds - left.throttlingSeconds || left.laneId.localeCompare(right.laneId),
    )

  const evidence = trafficEvidenceState(
    capabilities ?? { operationFamilies: true },
    families,
  )

  return {
    lanes,
    evidence,
    measuredFamilyCount: totals.measuredFamilyCount,
    unmeasuredFamilyCount: totals.unmeasuredFamilyCount,
    familyCount: totals.familyCount,
    measuredSeconds: totals.measuredSeconds,
    unattributedSeconds: totals.unattributedSeconds,
    note: totals.note,
  }
}

function buildLane(
  attribution: ItemThrottleAttribution,
  familyById: ReadonlyMap<string, OperationFamily>,
): FacilityLane {
  const { itemId, stage, facility, seconds, familyIds } = attribution
  const definition = POWER_GRID_FACILITIES[facility]
  const operations = sumOperations(familyIds, familyById)
  // Seconds are always measured here; the ratio is not, so a lane with no operation count grades
  // unknown (grey), never free (green). Coercing the missing count to 0 would give it a quiet
  // measured-looking colour, which is the "unmeasured drawn as measured" failure this map forbids.
  const measured = operations !== null && operations > 0
  const delayPerOperation = measured ? seconds / operations : null
  const grade = measured ? congestionFromDelay(delayPerOperation) : 'unknown'
  const outcome = gateOutcomeForStage(stage)
  const mode = trafficModeForClass(operationClassForStage(stage))

  return {
    laneId: `${itemId}->${facility}`,
    itemId,
    stage,
    facility,
    facilityLabel: definition.label,
    throttlingSeconds: seconds,
    operations,
    delayPerOperation,
    grade,
    color: CONGESTION_COLORS[grade],
    mode,
    outcome,
    width: LANE_WIDTH,
    familyIds,
    rationale: describeLane(definition.label, seconds, operations, delayPerOperation, grade, outcome),
  }
}

function describeLane(
  label: string,
  seconds: number,
  operations: number | null,
  delayPerOperation: number | null,
  grade: CongestionGrade,
  outcome: GateOutcome,
): string {
  const held =
    outcome === 'delayed'
      ? `held at the ${label} as load — delayed, not refused`
      : `refused at the ${label} — a blackout, not merely load`
  if (delayPerOperation === null || operations === null) {
    return (
      `${seconds.toLocaleString()} s of measured throttling ${held}. No operation count was reported, ` +
      'so no throttling-per-operation grade is claimed and the lane is drawn grey rather than green.'
    )
  }
  return (
    `${seconds.toLocaleString()} s of measured throttling ${held}, over ` +
    `${operations.toLocaleString()} operation(s) — ${delayPerOperation.toFixed(2)} s each, ` +
    `${CONGESTION_LABELS[grade].toLowerCase()}. Graded on the same throttling-per-operation ladder as the roads.`
  )
}

/** Sum of operationCount over the families feeding a lane, or null when none reported a usable count. */
function sumOperations(
  familyIds: readonly string[],
  familyById: ReadonlyMap<string, OperationFamily>,
): number | null {
  let total = 0
  let sawValue = false
  for (const familyId of familyIds) {
    const family = familyById.get(familyId)
    if (!family) continue
    const value = toPositiveInteger(family.operationCount)
    if (value === null) continue
    sawValue = true
    total += value
  }
  return sawValue ? total : null
}

function toPositiveInteger(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/* ------------------------------------------------------------------ *
 * The per-item readout — where one building's throttling was held
 * ------------------------------------------------------------------ */

/** One gate's share of the throttling attributed to a single building. */
export interface FacilityShare {
  readonly facility: PowerGridFacilityKind
  readonly label: string
  /** Measured throttling seconds for this building and gate. */
  readonly seconds: number
  /** Fraction of this building's attributed throttling, in 0..1. */
  readonly share: number
  readonly outcome: GateOutcome
}

/**
 * Where one building's throttling was held, by gate, busiest first.
 *
 * This is the readout the building panel shows when the lanes themselves are off-screen: the map says
 * a building is throttled, and this says which gate held it and how the load split. Null-safe — a
 * building with no attributed throttling returns `[]`, which the caller must render as *no claim*
 * rather than as a quiet zero.
 */
export function facilityShares(itemId: string, traffic: FacilityTraffic): FacilityShare[] {
  const totals = new Map<PowerGridFacilityKind, { label: string; seconds: number; outcome: GateOutcome }>()
  let overall = 0
  for (const lane of traffic.lanes) {
    if (lane.itemId !== itemId) continue
    if (lane.throttlingSeconds <= 0) continue
    const existing = totals.get(lane.facility)
    totals.set(lane.facility, {
      label: lane.facilityLabel,
      seconds: (existing?.seconds ?? 0) + lane.throttlingSeconds,
      outcome: lane.outcome,
    })
    overall += lane.throttlingSeconds
  }
  if (overall <= 0) return []
  return [...totals.entries()]
    .map(([facility, entry]) => ({
      facility,
      label: entry.label,
      seconds: entry.seconds,
      share: entry.seconds / overall,
      outcome: entry.outcome,
    }))
    .sort((left, right) => right.share - left.share || left.facility.localeCompare(right.facility))
}

/**
 * The gate mix as one short phrase, or null when nothing was attributed to this building.
 *
 * Null is not "nothing was throttled": it is "no measured throttling identified a gate for this
 * building", and the caller must not render it as a quiet building.
 */
export function facilityMixLabel(shares: readonly FacilityShare[]): string | null {
  if (shares.length === 0) return null
  return shares
    .slice(0, 3)
    .map(entry => `${entry.label.toLocaleLowerCase()} ${Math.round(entry.share * 100)}%`)
    .join(', ')
}

/* ------------------------------------------------------------------ *
 * Legend entries — exported for the scene/view to render
 * ------------------------------------------------------------------ *
 *
 * The city legend lives in the still-quarantined `CapacityCityView.tsx`, which this module does not
 * own, so the legend content is exported as data here rather than rendered. The scene port renders
 * these when it mounts the legend drawer.
 */

/**
 * State colours for the power-grid facilities, defined in terms of the road congestion palette so a
 * facility and the lane running to it are graded on one scale: healthy is free-flowing green, loaded
 * is moderate amber, brownout is heavy orange and blackout is severe red. `unbuilt` reuses the grey
 * roads draw for "no measurement", so a wireframe facility and a grey lane read the same.
 */
export const POWER_GRID_STATE_COLORS: Readonly<Record<PowerGridFacilityState | 'unbuilt', number>> =
  Object.freeze({
    healthy: CONGESTION_COLORS.free,
    loaded: CONGESTION_COLORS.moderate,
    brownout: CONGESTION_COLORS.heavy,
    blackout: CONGESTION_COLORS.severe,
    unbuilt: CONGESTION_COLORS.unknown,
  })

export interface PowerGridStateLegendEntry {
  readonly state: PowerGridFacilityState | 'unbuilt'
  readonly label: string
  readonly color: number
  readonly meaning: string
}

/** The facility state ladder, worst last, ending with the wireframe that means "not measured". */
export const POWER_GRID_STATE_LEGEND: readonly PowerGridStateLegendEntry[] = Object.freeze([
  { state: 'healthy', label: 'Healthy', color: POWER_GRID_STATE_COLORS.healthy, meaning: 'Under the load line.' },
  { state: 'loaded', label: 'Loaded', color: POWER_GRID_STATE_COLORS.loaded, meaning: 'Busy but inside the SKU budget.' },
  { state: 'brownout', label: 'Brownout', color: POWER_GRID_STATE_COLORS.brownout, meaning: 'Over the line; work is being delayed.' },
  { state: 'blackout', label: 'Blackout', color: POWER_GRID_STATE_COLORS.blackout, meaning: 'A rejection gate is refusing work.' },
  { state: 'unbuilt', label: 'Unbuilt', color: POWER_GRID_STATE_COLORS.unbuilt, meaning: 'No driving measurement — drawn as wireframe, never as an idle zero.' },
])

export interface PowerGridFacilityLegendEntry {
  readonly kind: PowerGridFacilityKind
  readonly label: string
  readonly meaning: string
  readonly measurement: PowerGridMeasurementKind
  /** `delayed` or `refused` for the three gates; null for the plant, reservoir, yard and substation. */
  readonly gateOutcome: GateOutcome | null
}

/** One legend row per power-grid facility, in placement order. */
export const POWER_GRID_FACILITY_LEGEND: readonly PowerGridFacilityLegendEntry[] = Object.freeze(
  POWER_GRID_FACILITY_ORDER.map(kind => {
    const definition = POWER_GRID_FACILITIES[kind]
    return {
      kind,
      label: definition.label,
      meaning: definition.civicRole,
      measurement: definition.measurement,
      gateOutcome: definition.trafficStage === null ? null : gateOutcomeForStage(definition.trafficStage),
    }
  }),
)

export interface FacilityLaneLegendEntry {
  readonly grade: CongestionGrade
  readonly label: string
  readonly color: number
}

/**
 * The lane colour key. Deliberately the road congestion ladder verbatim — a lane's colour is the
 * throttling seconds one operation carried on it, the same measurement the roads grade by, so one key
 * serves both and they cannot drift apart.
 */
export const FACILITY_LANE_LEGEND: readonly FacilityLaneLegendEntry[] = Object.freeze(
  CONGESTION_GRADES.map(grade => ({
    grade,
    label: CONGESTION_LABELS[grade],
    color: CONGESTION_COLORS[grade],
  })),
)

/** Plain-language disclosure of what the lane layer claims, for the legend drawer. */
export const FACILITY_LANE_NOTE =
  'Lanes run from a building to the gate that held its work. Colour is throttling seconds per ' +
  'operation on the same ladder as the roads; interactive work travels as cars, background as ' +
  'freight. A lane at the delay gate is load — delayed, not refused — while a lane at a rejection ' +
  'gate is a blackout. A building with no measured throttling has no lane, and a lane with no ' +
  'operation count is grey rather than green: unmeasured, not clear.'
