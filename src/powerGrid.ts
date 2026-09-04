import type {
  CapacityAtlasItem,
  Evidence,
  MeasurementStatus,
  ThrottleStage,
  ThrottleState,
} from './fabricContracts'

/*
 * Capacity civic infrastructure.
 *
 * A Fabric capacity is already a power grid: the purchased SKU is the power plant, smoothing is the
 * reservoir, carry-forward is debt in the yard, throttling happens at gates, and surge protection is
 * a substation. This module is deliberately pure domain data. The renderer and, later,
 * cityFacilityTraffic.ts should attach geometry to these stable facility identities rather than
 * re-deriving the roster.
 *
 * Missing telemetry is represented with MeasurementStatus.Unknown and a null state. A caller that
 * sees that pair must draw wireframe/unbuilt infrastructure, never a healthy zero-load facility.
 */

export type PowerGridFacilityKind =
  | 'powerPlant'
  | 'reservoir'
  | 'carryForwardYard'
  | 'delayGate'
  | 'interactiveRejectionGate'
  | 'backgroundRejectionGate'
  | 'surgeSubstation'

export type PowerGridFacilityState = 'healthy' | 'loaded' | 'brownout' | 'blackout'
export type PowerGridThrottleStage = Exclude<ThrottleStage, 'None'>

export type PowerGridMeasurementKind =
  | 'capacityUnits'
  | 'meanUtilizationPercent'
  | 'smoothingPercent'
  | 'interactiveDelayPercent'
  | 'interactiveRejectionPercent'
  | 'backgroundRejectionPercent'
  | 'cumulativeCarryOverPercent'
  | 'surgeProtectionActive'

export interface PowerGridFacilityDefinition {
  readonly kind: PowerGridFacilityKind
  readonly label: string
  readonly civicRole: string
  readonly measurement: PowerGridMeasurementKind
  readonly trafficStage: PowerGridThrottleStage | null
}

export interface PowerGridMeasurement {
  readonly kind: PowerGridMeasurementKind
  readonly status: MeasurementStatus
  readonly evidence: Evidence
  readonly value: number | boolean | null
  readonly detail: string
}

export interface PowerGridFacilitySizing {
  readonly measurement: 'capacityUnits'
  readonly status: MeasurementStatus
  readonly evidence: Evidence
  readonly value: number | null
  readonly detail: string
}

export interface PowerGridFacility {
  readonly kind: PowerGridFacilityKind
  readonly label: string
  readonly civicRole: string
  readonly measurement: PowerGridMeasurement
  readonly sizing: PowerGridFacilitySizing | null
  /** Null means the driving measurement is absent; renderers must draw wireframe/unbuilt. */
  readonly state: PowerGridFacilityState | null
  /** 0..1 load channel for geometry, or null when no quantitative claim is safe. */
  readonly load: number | null
  readonly trafficStage: PowerGridThrottleStage | null
  readonly reason: string
}

export const POWER_GRID_FACILITY_ORDER: readonly PowerGridFacilityKind[] = Object.freeze([
  'powerPlant',
  'reservoir',
  'carryForwardYard',
  'delayGate',
  'interactiveRejectionGate',
  'backgroundRejectionGate',
  'surgeSubstation',
])

export const POWER_GRID_FACILITIES: Readonly<Record<PowerGridFacilityKind, PowerGridFacilityDefinition>> =
  Object.freeze({
    powerPlant: {
      kind: 'powerPlant',
      label: 'Power Plant',
      civicRole: 'Purchased SKU ceiling; sized by provisioned Capacity Units.',
      measurement: 'meanUtilizationPercent',
      trafficStage: null,
    },
    reservoir: {
      kind: 'reservoir',
      label: 'Smoothing Reservoir',
      civicRole: 'The CU smoothing windows that buffer work before throttling gates trip.',
      measurement: 'smoothingPercent',
      trafficStage: null,
    },
    carryForwardYard: {
      kind: 'carryForwardYard',
      label: 'Carry-forward Yard',
      civicRole: 'Accumulated overage debt and the expected burndown time.',
      measurement: 'cumulativeCarryOverPercent',
      trafficStage: null,
    },
    delayGate: {
      kind: 'delayGate',
      label: 'Delay Gate',
      civicRole: 'Interactive requests are delayed here before any work is refused.',
      measurement: 'interactiveDelayPercent',
      trafficStage: 'InteractiveDelay',
    },
    interactiveRejectionGate: {
      kind: 'interactiveRejectionGate',
      label: 'Interactive Rejection Gate',
      civicRole: 'Interactive requests are refused here when the 60-minute gauge is over the line.',
      measurement: 'interactiveRejectionPercent',
      trafficStage: 'InteractiveRejection',
    },
    backgroundRejectionGate: {
      kind: 'backgroundRejectionGate',
      label: 'Background Rejection Gate',
      civicRole: 'Background work is refused here when the 24-hour gauge is over the line.',
      measurement: 'backgroundRejectionPercent',
      trafficStage: 'BackgroundRejection',
    },
    surgeSubstation: {
      kind: 'surgeSubstation',
      label: 'Surge Substation',
      civicRole: 'Surge protection state from Fabric capacity events.',
      measurement: 'surgeProtectionActive',
      trafficStage: null,
    },
  })

const LOAD_THRESHOLD_PERCENT = 80
const OVER_LINE_PERCENT = 100

export function facilityForThrottleStage(stage: PowerGridThrottleStage): PowerGridFacilityKind {
  switch (stage) {
    case 'InteractiveDelay':
      return 'delayGate'
    case 'InteractiveRejection':
      return 'interactiveRejectionGate'
    case 'BackgroundRejection':
      return 'backgroundRejectionGate'
  }
}

export function throttleGaugePercent(
  throttle: ThrottleState,
  stage: PowerGridThrottleStage,
): number | null {
  switch (stage) {
    case 'InteractiveDelay':
      return finiteOrNull(throttle.interactiveDelayPercent)
    case 'InteractiveRejection':
      return finiteOrNull(throttle.interactiveRejectionPercent)
    case 'BackgroundRejection':
      return finiteOrNull(throttle.backgroundRejectionPercent)
  }
}

export function isThrottleStageActive(
  throttle: ThrottleState,
  stage: PowerGridThrottleStage,
): boolean | null {
  const percent = throttleGaugePercent(throttle, stage)
  return percent === null ? null : percent > OVER_LINE_PERCENT
}

export function projectPowerGrid(capacity: CapacityAtlasItem): PowerGridFacility[] {
  return POWER_GRID_FACILITY_ORDER.map((kind) => projectFacility(kind, capacity))
}

function projectFacility(kind: PowerGridFacilityKind, capacity: CapacityAtlasItem): PowerGridFacility {
  switch (kind) {
    case 'powerPlant':
      return powerPlant(capacity)
    case 'reservoir':
      return reservoir(capacity.throttle)
    case 'carryForwardYard':
      return carryForwardYard(capacity.throttle)
    case 'delayGate':
      return gaugeGate('delayGate', capacity.throttle, 'InteractiveDelay', false)
    case 'interactiveRejectionGate':
      return gaugeGate('interactiveRejectionGate', capacity.throttle, 'InteractiveRejection', true)
    case 'backgroundRejectionGate':
      return gaugeGate('backgroundRejectionGate', capacity.throttle, 'BackgroundRejection', true)
    case 'surgeSubstation':
      return surgeSubstation(capacity.throttle)
  }
}

function powerPlant(capacity: CapacityAtlasItem): PowerGridFacility {
  const definition = POWER_GRID_FACILITIES.powerPlant
  const measurement = numberMeasurement(
    'meanUtilizationPercent',
    capacity.meanUtilizationPercent,
    capacity.cuConsumed.evidence,
    capacity.meanUtilizationPercent === null
      ? 'Mean utilization was not reported.'
      : `${capacity.meanUtilizationPercent.toFixed(1)}% mean utilization of the SKU budget.`,
  )
  const sizing = capacitySizing(capacity)
  const known = measurement.status === 'Known'
  return {
    ...definition,
    measurement,
    sizing,
    state: known ? percentState(measurement.value as number) : null,
    load: known ? loadFromPercent(measurement.value as number) : null,
    reason: known
      ? `${definition.label} is driven by measured mean utilization; the SKU sizing is ${sizing.detail}.`
      : `${definition.label} has SKU sizing ${sizing.detail}, but its load measurement is absent, so no healthy zero-load claim is made.`,
  }
}

function reservoir(throttle: ThrottleState): PowerGridFacility {
  const definition = POWER_GRID_FACILITIES.reservoir
  const gauges = (['InteractiveDelay', 'InteractiveRejection', 'BackgroundRejection'] as const)
    .map((stage) => throttleGaugePercent(throttle, stage))
    .filter((value): value is number => value !== null)
  const percent = gauges.length === 0 ? null : Math.max(...gauges)
  const measurement = numberMeasurement(
    'smoothingPercent',
    percent,
    throttle.evidence,
    percent === null
      ? 'No smoothing gauge was reported.'
      : `${percent.toFixed(1)}% is the hottest reported smoothing gauge.`,
  )
  const known = measurement.status === 'Known'
  return {
    ...definition,
    measurement,
    sizing: null,
    state: known ? percentState(measurement.value as number) : null,
    load: known ? loadFromPercent(measurement.value as number) : null,
    reason: known
      ? 'Reservoir state follows the hottest reported smoothing gauge.'
      : 'All smoothing gauges are absent, so the reservoir must render as wireframe rather than empty.',
  }
}

function carryForwardYard(throttle: ThrottleState): PowerGridFacility {
  const definition = POWER_GRID_FACILITIES.carryForwardYard
  const percent = finiteOrNull(throttle.cumulativeCarryOverPercent)
  const measurement = numberMeasurement(
    'cumulativeCarryOverPercent',
    percent,
    throttle.evidence,
    percent === null
      ? 'Carry-forward debt was not reported.'
      : `${percent.toFixed(1)}% carry-forward debt; burndown ${burndownText(throttle.expectedBurndownMinutes)}.`,
  )
  const known = measurement.status === 'Known'
  return {
    ...definition,
    measurement,
    sizing: null,
    state: known ? carryForwardState(measurement.value as number) : null,
    load: known ? loadFromPercent(measurement.value as number) : null,
    reason: known
      ? 'Carry-forward yard state follows the measured debt, with burndown shown as text.'
      : 'Carry-forward data is absent; this is not the same as zero debt.',
  }
}

function gaugeGate(
  kind: 'delayGate' | 'interactiveRejectionGate' | 'backgroundRejectionGate',
  throttle: ThrottleState,
  stage: PowerGridThrottleStage,
  blackoutWhenActive: boolean,
): PowerGridFacility {
  const definition = POWER_GRID_FACILITIES[kind]
  const percent = throttleGaugePercent(throttle, stage)
  const measurement = numberMeasurement(
    definition.measurement,
    percent,
    throttle.evidence,
    percent === null
      ? `${definition.label} gauge was not reported.`
      : `${percent.toFixed(1)}% of the ${definition.label.toLocaleLowerCase()} threshold.`,
  )
  const known = measurement.status === 'Known'
  const active = known && (measurement.value as number) > OVER_LINE_PERCENT
  return {
    ...definition,
    measurement,
    sizing: null,
    state: known ? gateState(measurement.value as number, blackoutWhenActive) : null,
    load: known ? loadFromPercent(measurement.value as number) : null,
    reason: known
      ? active && blackoutWhenActive
        ? `${definition.label} is over the line and is refusing work.`
        : active
          ? `${definition.label} is over the line but this stage delays work rather than refusing it.`
          : `${definition.label} is below its active threshold.`
      : `${definition.label} has no gauge reading, so no gate state is claimed.`,
  }
}

function surgeSubstation(throttle: ThrottleState): PowerGridFacility {
  const definition = POWER_GRID_FACILITIES.surgeSubstation
  const status = reportsMeasurement(throttle.evidence) ? 'Known' : 'Unknown'
  const measurement: PowerGridMeasurement = {
    kind: 'surgeProtectionActive',
    status,
    evidence: throttle.evidence,
    value: status === 'Known' ? throttle.surgeProtectionActive : null,
    detail:
      status === 'Known'
        ? throttle.surgeProtectionActive
          ? 'Surge protection is active.'
          : 'Surge protection is not active.'
        : 'Surge protection state was not reported.',
  }
  return {
    ...definition,
    measurement,
    sizing: null,
    state: status === 'Known' ? (throttle.surgeProtectionActive ? 'brownout' : 'healthy') : null,
    load: status === 'Known' ? (throttle.surgeProtectionActive ? 1 : 0) : null,
    reason:
      status === 'Known'
        ? 'Surge substation follows the reported surge-protection flag.'
        : 'The throttle evidence is unavailable, so false is not treated as measured inactive surge protection.',
  }
}

function capacitySizing(capacity: CapacityAtlasItem): PowerGridFacilitySizing {
  const value = finiteOrNull(capacity.capacityUnits)
  return {
    measurement: 'capacityUnits',
    status: value === null ? 'Unknown' : 'Known',
    evidence: capacity.cuConsumed.evidence,
    value,
    detail: value === null ? 'unknown Capacity Units' : `${value} Capacity Units`,
  }
}

function numberMeasurement(
  kind: PowerGridMeasurementKind,
  value: number | null | undefined,
  evidence: Evidence,
  detail: string,
): PowerGridMeasurement {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { kind, status: 'Unknown', evidence, value: null, detail }
  }
  return { kind, status: 'Known', evidence, value, detail }
}

function percentState(percent: number): PowerGridFacilityState {
  if (percent > OVER_LINE_PERCENT) return 'brownout'
  return percent >= LOAD_THRESHOLD_PERCENT ? 'loaded' : 'healthy'
}

function carryForwardState(percent: number): PowerGridFacilityState {
  if (percent > OVER_LINE_PERCENT) return 'brownout'
  return percent > 0 ? 'loaded' : 'healthy'
}

function gateState(percent: number, blackoutWhenActive: boolean): PowerGridFacilityState {
  if (percent > OVER_LINE_PERCENT) return blackoutWhenActive ? 'blackout' : 'loaded'
  return percent >= LOAD_THRESHOLD_PERCENT ? 'loaded' : 'healthy'
}

function loadFromPercent(percent: number): number {
  return Math.max(0, Math.min(1, percent / OVER_LINE_PERCENT))
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : value
}

function reportsMeasurement(evidence: Evidence): boolean {
  return evidence.status === 'Available' || evidence.status === 'Stale'
}

function burndownText(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return 'unavailable'
  if (minutes < 1) return '<1 min'
  if (minutes < 60) return `${Math.round(minutes)} min`
  return `${(minutes / 60).toFixed(1)} h`
}
