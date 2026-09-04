import type { DataStatus, MeasurementStatus } from './fabricContracts'
import {
  POWER_GRID_FACILITIES,
  POWER_GRID_FACILITY_ORDER,
  type PowerGridFacility,
  type PowerGridFacilityKind,
  type PowerGridFacilityState,
} from './powerGrid'

/**
 * Projects the capacity-wide power grid onto the city's infrastructure layer.
 *
 * SQLSimCity had six engine-resource facilities. FabricSimCity's civic layer is the Fabric capacity
 * itself: the purchased SKU, smoothing reservoirs, carry-forward debt and throttle gates are drawn as
 * power-grid facilities. This module adapts the pure domain projection in `powerGrid.ts` to the shape
 * the city plan and scene need for deterministic placement and measurable geometry.
 *
 * Missing telemetry stays missing. A facility whose driving measurement is absent renders as
 * wireframe/unbuilt; it is never coloured as a healthy zero-load facility.
 */

export type FacilityKind = PowerGridFacilityKind

/** Every possible site the deterministic city plan reserves, in stable placement order. */
export const FACILITY_ORDER: readonly FacilityKind[] = POWER_GRID_FACILITY_ORDER

/** Facilities that are real only when an explicit reason/flag says they exist. */
export const CONDITIONAL_FACILITY_ORDER: readonly FacilityKind[] = ['surgeSubstation']

export const FACILITY_LABELS: Readonly<Record<FacilityKind, string>> = Object.freeze(
  Object.fromEntries(
    FACILITY_ORDER.map(kind => [kind, POWER_GRID_FACILITIES[kind].label]),
  ) as Record<FacilityKind, string>,
)

/** One measured bar on a facility. `fill` is null whenever the underlying fact was not available. */
export interface FacilityUnit {
  readonly id: string
  readonly label: string
  /** Normalized 0..1 fill used for geometry, or null when the measurement is unavailable. */
  readonly fill: number | null
  /** Exact measured text, always shown alongside the geometry. */
  readonly detail: string
  /** Set when this unit represents a loaded, brownout or blackout state. */
  readonly alert: boolean
}

export interface Facility {
  readonly kind: FacilityKind
  readonly label: string
  readonly civicRole?: string
  readonly measurement?: {
    readonly kind: string
    readonly status: MeasurementStatus
    readonly evidence: { readonly status: DataStatus | string }
    readonly value: number | boolean | null
    readonly detail: string
  }
  readonly sizing?: PowerGridFacility['sizing']
  readonly state?: PowerGridFacilityState | null
  readonly load?: number | null
  readonly trafficStage?: PowerGridFacility['trafficStage']
  readonly status: DataStatus
  readonly reason: string
  /** True only when the driving measurement is known; false means render nonquantitative geometry. */
  readonly known: boolean
  readonly headline: string
  readonly units: readonly FacilityUnit[]
  /** Count of alerting measured units, used for compatibility with the address-book rank/readout. */
  readonly alertCount: number
  /** Normalized SKU scale for the power plant's massing, or null when SKU size is unmeasured. */
  readonly size: number | null
}

/**
 * Where one facility stands.
 *
 * Positions come from the city plan, which reserves every possible power-grid site from the capacity
 * seed. The conditional surge substation may not be drawn for a quiet capacity, but reserving its
 * site keeps the other landmarks from moving when surge protection appears later.
 */
export interface FacilitySite {
  readonly kind: FacilityKind
  readonly label: string
  /** Facility centre in world units. */
  readonly x: number
  readonly z: number
  /** Plot half-extent; the facility's geometry stays inside this. */
  readonly radius: number
}

const NO_GRID_REASON =
  'No capacity power-grid projection has been received yet, so no claim is made about this facility.'

/** Facilities in fixed order, with the surge substation omitted unless surge protection is present. */
export function projectFacilities(powerGrid: readonly PowerGridFacility[] | null): Facility[] {
  if (powerGrid === null) {
    return FACILITY_ORDER
      .filter(kind => !isConditional(kind))
      .map(kind => unavailableFacility(kind, 'Unknown', NO_GRID_REASON))
  }

  const byKind = new Map(powerGrid.map(facility => [facility.kind, facility]))
  const facilities: Facility[] = []
  for (const kind of FACILITY_ORDER) {
    const gridFacility = byKind.get(kind)
    if (!gridFacility) {
      if (!isConditional(kind)) facilities.push(unavailableFacility(kind, 'Unknown', NO_GRID_REASON))
      continue
    }
    if (!shouldRenderFacility(gridFacility)) continue
    facilities.push(toFacility(gridFacility))
  }
  return facilities
}

export function shouldRenderFacility(facility: Pick<PowerGridFacility, 'kind' | 'measurement'>): boolean {
  return facility.kind !== 'surgeSubstation' || facility.measurement.value === true
}

function toFacility(facility: PowerGridFacility): Facility {
  const known = facility.measurement.status === 'Known'
  const unit = facilityUnit(facility)
  return {
    ...facility,
    status: facility.measurement.evidence.status,
    known,
    headline: headline(facility, known),
    units: [unit],
    alertCount: unit.alert ? 1 : 0,
    size: facility.kind === 'powerPlant' ? skuSize(facility.sizing) : null,
  }
}

function unavailableFacility(kind: FacilityKind, status: DataStatus, reason: string): Facility {
  const definition = POWER_GRID_FACILITIES[kind]
  const measurement = {
    kind: definition.measurement,
    status: 'Unknown' as MeasurementStatus,
    evidence: { source: 'NotProbed' as const, status, observedAt: null, freshUntil: null },
    value: null,
    detail: reason,
  }
  return {
    ...definition,
    measurement,
    sizing: null,
    state: null,
    load: null,
    reason,
    status,
    known: false,
    headline: `${definition.label} evidence is ${status.toLowerCase()}; no quantity is claimed.`,
    units: [facilityUnit({
      ...definition,
      measurement,
      sizing: null,
      state: null,
      load: null,
      reason,
    })],
    alertCount: 0,
    size: null,
  }
}

function facilityUnit(facility: PowerGridFacility): FacilityUnit {
  return {
    id: `${facility.kind}:${facility.measurement.kind}`,
    label: facility.label,
    fill: facility.load,
    detail: facility.measurement.detail,
    alert: isAlertState(facility.state),
  }
}

function headline(facility: PowerGridFacility, known: boolean): string {
  if (!known) return `Unbuilt — ${facility.measurement.detail}`
  const state = stateLabel(facility.state)
  return `${state} · ${facility.measurement.detail}`
}

function stateLabel(state: PowerGridFacilityState | null): string {
  switch (state) {
    case 'healthy':
      return 'Healthy'
    case 'loaded':
      return 'Loaded'
    case 'brownout':
      return 'Brownout'
    case 'blackout':
      return 'Blackout'
    default:
      return 'Unbuilt'
  }
}

function isAlertState(state: PowerGridFacilityState | null): boolean {
  return state === 'loaded' || state === 'brownout' || state === 'blackout'
}

function isConditional(kind: FacilityKind): boolean {
  return (CONDITIONAL_FACILITY_ORDER as readonly FacilityKind[]).includes(kind)
}

function skuSize(sizing: PowerGridFacility['sizing']): number | null {
  const value = sizing?.value
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null
  // F2..F8192 spans twelve doublings. Keep the smallest plant visible and the largest inside its plot.
  return Math.max(0, Math.min(1, Math.log2(value / 2) / 12))
}
