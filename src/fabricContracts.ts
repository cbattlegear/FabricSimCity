/*
 * Evidence primitives.
 *
 * Carried over from the SQL build unchanged in spirit: every measurement says where it came from
 * and whether it is trustworthy, and a subsystem that could not be sampled is rendered as
 * unavailable rather than as zero. That rule matters more on Fabric than it did on SQL Server,
 * because a paused capacity emits no telemetry at all — drawing it as an idle city would be a lie.
 */

export type MeasurementStatus = 'Known' | 'Unknown'

/**
 * Where a measurement came from.
 *
 * `SemanticModel` is the Capacity Metrics app's model, read over DAX. `CapacityEvent` is a
 * `Microsoft.Fabric.Capacity.Summary` event from Real-Time Hub. `FabricRest` is the platform REST
 * API, which supplies topology and state but never utilization. `NotProbed` means nobody asked.
 */
export type EvidenceSource =
  | 'Fixture'
  | 'FabricRest'
  | 'SemanticModel'
  | 'CapacityEvent'
  | 'NotProbed'

export type DataStatus =
  | 'Available'
  | 'Stale'
  | 'Disconnected'
  | 'PermissionDenied'
  | 'Unsupported'
  | 'Unknown'

export interface Evidence {
  source: EvidenceSource
  status: DataStatus
  observedAt: string | null
  /**
   * When this measurement stops being current. The Capacity Metrics model runs 10–15 minutes
   * behind and its dimension tables only refresh at midnight, so a city drawn from it is always
   * slightly historical and has to say so.
   */
  freshUntil: string | null
}

/** Bytes, as a decimal string: OneLake item sizes routinely exceed what a JSON number survives. */
export interface ByteMeasurement {
  bytes: string | null
  status: MeasurementStatus
  evidence: Evidence
}

/**
 * Capacity Units consumed, in CU-seconds.
 *
 * A decimal string for the same reason as bytes: a 14-day window on an F2048 is large enough to
 * lose precision as a double, and CU totals are the number the whole city is sized from.
 */
export interface CuMeasurement {
  cuSeconds: string | null
  status: MeasurementStatus
  evidence: Evidence
}

/* ------------------------------------------------------------------ *
 * Capacity identity and state
 * ------------------------------------------------------------------ */

/**
 * Fabric SKUs and their Capacity Unit budgets.
 *
 * `Trial` is 64 CUs, the same as F64, and is listed separately because it behaves differently for
 * billing and cannot be scaled. P/EM/A SKUs are deliberately absent: they are Power BI capacities
 * being retired, and the metrics model reports them without the item-level breakdown the city
 * needs.
 */
export type FabricSku =
  | 'F2' | 'F4' | 'F8' | 'F16' | 'F32' | 'F64'
  | 'F128' | 'F256' | 'F512' | 'F1024' | 'F2048' | 'F4096' | 'F8192'
  | 'Trial'

export const SKU_CAPACITY_UNITS: Readonly<Record<FabricSku, number>> = Object.freeze({
  F2: 2, F4: 4, F8: 8, F16: 16, F32: 32, F64: 64,
  F128: 128, F256: 256, F512: 512, F1024: 1024, F2048: 2048, F4096: 4096, F8192: 8192,
  Trial: 64,
})

/**
 * How long one smoothing timepoint is, in seconds.
 *
 * Fabric smooths every operation across 30-second timepoints — 2,880 of them in 24 hours. One
 * timepoint's CU budget is `SKU_CAPACITY_UNITS[sku] * TIMEPOINT_SECONDS`, and every throttle
 * threshold below is an average of that budget over a number of consecutive timepoints. This is
 * the unit the whole telemetry model is built on, so it is stated once here rather than repeated.
 */
export const TIMEPOINT_SECONDS = 30

/** Timepoints averaged for each throttle gauge: 10 minutes, 60 minutes, 24 hours. */
export const THROTTLE_WINDOW_TIMEPOINTS = Object.freeze({
  interactiveDelay: 20,
  interactiveRejection: 120,
  backgroundRejection: 2880,
})

export type CapacityState = 'Active' | 'Overloaded' | 'Suspended' | 'Deleted' | 'Unknown'

/**
 * Why the capacity is in the state it is in.
 *
 * These are the values the metrics app's system-events table reports. They are the difference
 * between a city that is merely busy and one that is turning work away, so the city's weather is
 * driven from the reason rather than from the state alone.
 */
export type CapacityStateReason =
  | 'Created'
  | 'ManuallyResumed'
  | 'NotOverloaded'
  | 'AllRejected'
  | 'InteractiveDelay'
  | 'InteractiveRejected'
  | 'SurgeProtectionActive'
  | 'InteractiveDelayAndSurgeProtectionActive'
  | 'InteractiveRejectedAndSurgeProtectionActive'
  | 'ManuallyPaused'
  | 'Deleted'
  | 'Unknown'

/**
 * Which throttle stage the capacity is standing in.
 *
 * The stages are cumulative and ordered: exceeding the 24-hour threshold implies the other two are
 * also exceeded. `None` is overage protection — usage is above the SKU but inside the 10-minute
 * window, which is normal bursting and not a fault.
 */
export type ThrottleStage =
  | 'None'
  | 'InteractiveDelay'
  | 'InteractiveRejection'
  | 'BackgroundRejection'

/**
 * The three throttle gauges, as percentages of the SKU budget averaged over their windows.
 *
 * Each is `> 100` exactly when its stage is active. They are reported rather than derived because
 * the metrics model computes them against future smoothed usage, which this client cannot
 * reconstruct from any total it holds.
 *
 * Null means the gauge was not measured — a paused capacity, or an Eventhouse feed that predates
 * the field. Rendering an unmeasured gauge as 0% draws a healthy grid over an unknown one.
 */
export interface ThrottleState {
  stage: ThrottleStage
  interactiveDelayPercent: number | null
  interactiveRejectionPercent: number | null
  backgroundRejectionPercent: number | null
  /** Cumulative carry-forward debt as a percentage of the SKU budget. */
  cumulativeCarryOverPercent: number | null
  /** Minutes to clear the carry-forward assuming no further consumption. */
  expectedBurndownMinutes: number | null
  surgeProtectionActive: boolean
  evidence: Evidence
}

/* ------------------------------------------------------------------ *
 * Atlas — one capacity per city
 * ------------------------------------------------------------------ */

export interface CapacityAtlasItem {
  capacityId: string
  displayName: string
  sku: FabricSku | null
  /** CU budget for the SKU. Null when the SKU is unrecognised, which is not the same as zero. */
  capacityUnits: number | null
  region: string | null
  state: CapacityState
  stateReason: CapacityStateReason
  /** Total CU-seconds consumed over the snapshot window. Sizes the city's plot. */
  cuConsumed: CuMeasurement
  /**
   * Mean consumption across the window as a percentage of the SKU budget.
   *
   * The Fabric analogue of "how full is it": 100 means the capacity consumed exactly what it was
   * provisioned for. Reported rather than derived because the client does not hold the window
   * length, and a ratio computed against the wrong window is worse than no ratio.
   */
  meanUtilizationPercent: number | null
  /** Peak share of the SKU budget reached in any single timepoint. Sizes the tallest tower. */
  peakUtilizationPercent: number | null
  /** OneLake storage across every item in the capacity. */
  storage: ByteMeasurement
  workspaceCount: number | null
  itemCount: number | null
  throttle: ThrottleState
}

/**
 * A link between two capacities.
 *
 * Fabric has no cross-capacity foreign keys, so these are never structural. They are drawn from
 * shortcuts and mirrored items whose source lives on another capacity, which is a real dependency
 * and a real reason one capacity's load shows up on another.
 */
export type CapacityLinkKind = 'Shortcut' | 'MirroredSource' | 'Unknown'

/** Confidence in a link between two capacities. */
export type LinkConfidence = 'Confirmed' | 'Probable' | 'Unknown'

export interface CapacityLink {
  linkId: string
  fromCapacityId: string
  toCapacityId: string
  kind: CapacityLinkKind
  confidence: LinkConfidence
  evidence: Evidence
}

export interface CapacityCollectionStatus {
  source: EvidenceSource
  state: 'Ready' | 'Collecting' | 'Degraded' | 'Disconnected'
  collectedAt: string | null
  /** True once `freshUntil` has passed. The city dims rather than clearing. */
  isStale: boolean
  capacityCount: number
  failureCount: number
  durationMilliseconds: number
}

export interface AtlasSnapshot {
  schemaVersion: string
  snapshotId: string
  tenant: { tenantId: string; displayName: string }
  generatedAt: string
  capacities: CapacityAtlasItem[]
  links: CapacityLink[]
  collection: CapacityCollectionStatus | null
}
