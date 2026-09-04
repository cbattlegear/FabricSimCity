import type {
  ByteMeasurement,
  CuMeasurement,
  Evidence,
  MeasurementStatus,
  ThrottleState,
} from './fabricContracts'

/** What the city is ranked and sized by. */
export type CapacityCityMetric = 'Cu' | 'Duration' | 'Operations' | 'Storage'

/**
 * Canonical item kinds.
 *
 * This is deliberately *not* the REST `ItemType` enum verbatim. The platform REST API reports 50
 * values (`DataPipeline`, `SemanticModel`, `UserDataFunction`), while the Capacity Metrics model
 * reports its own names for the same things (`Pipeline`, `Dataflow Gen2`, `LlmPlugin`,
 * `User Data Functions`). Two sources naming one item differently would put the same building in
 * two neighbourhoods, so both are normalised onto the list below by `itemKind.ts`.
 *
 * `Unknown` is a real member. Fabric ships new item types continuously and the metrics model
 * invents virtual kinds for Copilot; an unrecognised kind draws as a generic building rather than
 * being dropped from the city.
 */
export type FabricItemKind =
  | 'Lakehouse'
  | 'Warehouse'
  | 'WarehouseSnapshot'
  | 'SqlEndpoint'
  | 'SqlDatabase'
  | 'MirroredDatabase'
  | 'Eventhouse'
  | 'KqlDatabase'
  | 'KqlQueryset'
  | 'KqlDashboard'
  | 'Eventstream'
  | 'SemanticModel'
  | 'Report'
  | 'PaginatedReport'
  | 'Dashboard'
  | 'Datamart'
  | 'Notebook'
  | 'SparkJobDefinition'
  | 'Environment'
  | 'DataPipeline'
  | 'Dataflow'
  | 'CopyJob'
  | 'ApacheAirflowJob'
  | 'MlModel'
  | 'MlExperiment'
  | 'AiSkill'
  | 'DataAgent'
  | 'GraphQlApi'
  | 'UserDataFunction'
  | 'Reflex'
  | 'VariableLibrary'
  | 'DigitalTwinBuilder'
  | 'GraphModel'
  | 'Ontology'
  | 'AppBackend'
  | 'OrgApp'
  | 'Unknown'

/**
 * How an item's building is massed.
 *
 * Storage-bearing kinds get a footprint from real bytes. Compute-only kinds — a Notebook, a
 * Pipeline, a Report — have no storage to measure and sit on a minimum lot, which is a true
 * statement about them rather than a fallback. `Facility` is reserved for the civic infrastructure
 * that models the capacity itself and is never an item.
 */
export type ItemArchetype = 'Storage' | 'Compute' | 'Analytics' | 'Streaming' | 'Facility'

/* ------------------------------------------------------------------ *
 * Workspaces — the city's neighbourhoods
 * ------------------------------------------------------------------ */

export interface CapacityCityWorkspace {
  workspaceId: string
  name: string
  /**
   * The workspace's position among the capacity's workspaces. States an order and nothing else:
   * nothing that sizes the city may be derived from an ordinal, because an ordinal is not a count.
   */
  neighborhoodOrdinal: number
  itemCount: string | null
  evidence: Evidence
}

/* ------------------------------------------------------------------ *
 * Items — the city's buildings
 * ------------------------------------------------------------------ */

/**
 * Operation outcome counts for one item.
 *
 * `rejected` is the one that matters visually: it is the only count that proves throttling
 * actually turned work away, as opposed to the gauges merely running hot. All counts are decimal
 * strings and any of them may be null, meaning the source did not report that column — several are
 * optional in the metrics model's matrix and absent entirely from the Eventhouse feed.
 */
export interface ItemOperationCounts {
  total: string | null
  successful: string | null
  rejected: string | null
  failed: string | null
  invalid: string | null
  cancelled: string | null
}

export interface CapacityCityItem {
  itemId: string
  workspaceId: string
  workspaceName: string
  name: string
  kind: FabricItemKind
  archetype: ItemArchetype

  /** Footprint. OneLake bytes; null for compute-only kinds, which is measured, not missing. */
  storage: ByteMeasurement
  /** Height. CU-seconds consumed over the window. */
  cuConsumed: CuMeasurement

  durationSeconds: number | null
  operations: ItemOperationCounts
  distinctUsers: string | null

  /** Minutes this item spent throttled. Non-zero is what pins a throttle incident to it. */
  throttlingMinutes: number | null

  /**
   * Percentage change in CU against the same item seven days ago, as the metrics app computes it.
   * Negative is a regression. Null means there was no comparable window, which is the normal case
   * for an item younger than a week and must not render as "unchanged".
   */
  performanceDeltaPercent: number | null

  /**
   * Where the collector put this item in its stable ordering. `itemOrdinal` counts across the
   * whole capacity rather than within the workspace, so that loading another page never renumbers
   * an item already on screen and moves its building.
   */
  layout: { neighborhoodOrdinal: number; itemOrdinal: number }

  sizeStatus: MeasurementStatus
  evidence: Evidence
}

/* ------------------------------------------------------------------ *
 * Operations — the city's traffic
 * ------------------------------------------------------------------ */

/**
 * Interactive work is a car; background work is freight.
 *
 * The split is not cosmetic. It decides which throttle gate an operation queues at — interactive
 * work is delayed at 10 minutes and rejected at 60, background survives until 24 hours — so the
 * two genuinely travel different routes through the city.
 */
export type OperationClass = 'Interactive' | 'Background' | 'Unknown'

/** Non-billable operations are excluded from throttling maths and drawn without a load colour. */
export type BillingType = 'Billable' | 'NonBillable' | 'Unknown'

/**
 * One operation family: an operation name performed against one item.
 *
 * This is the analogue of a Query Store query family, and it carries the same warning. The metrics
 * model reports one total per operation family; those totals are *not* divisible across the items
 * a chained operation touched, so summing families over a city double-counts anything that spanned
 * more than one item.
 */
export interface OperationFamily {
  familyId: string
  /** Verbatim operation name, e.g. `Warehouse Query`, `Semantic model scheduled refresh`. */
  operationName: string
  itemId: string
  /**
   * Every item this family touches, `itemId` first.
   *
   * The metrics model attributes an operation to exactly one item, so this is usually a single
   * entry — but a mirrored or lineage-carrying operation reads one item and writes another, and
   * the city needs both endpoints to draw the road. Kept as a list so that case is representable
   * rather than silently dropped onto the attributed item.
   */
  itemIds: string[]
  workspaceId: string
  operationClass: OperationClass
  billingType: BillingType
  cuSeconds: string
  durationSeconds: number
  operationCount: string
  throttlingSeconds: number | null
  distinctUsers: string | null
  counts: ItemOperationCounts

  /**
   * What this family did inside the recent traffic window, which is what street colour is graded
   * from. Absent on a snapshot built before the window existed, and there the retained totals are
   * all there is, so grading falls back to them rather than to grey.
   */
  recentActivity?: OperationRecentActivity | null
  evidence: Evidence
}

/**
 * An operation family's activity inside the recent window.
 *
 * `covered` is the field that matters. False means no retained interval overlapped the window at
 * all, and every count below is then zero — which is "nothing was captured here", not "this street
 * is quiet". Rendering the two the same makes the map claim a road is clear when it was never
 * measured.
 */
export interface OperationRecentActivity {
  windowMinutes: number
  windowStart: string
  windowEnd: string
  covered: boolean
  operationCount: string
  cuSeconds: string
  throttlingSeconds: number
}

/**
 * A route between two items, drawn from a real dependency rather than from co-occurrence.
 *
 * `Shortcut` and `MirroredSource` come from item definitions and are Confirmed. `Lineage` comes
 * from the semantic-model-to-lakehouse relationships Fabric reports, and `SharedOperation` is
 * inferred from operations that named both items — the weakest evidence here, and labelled so.
 */
export type CapacityRouteKind = 'Shortcut' | 'MirroredSource' | 'Lineage' | 'SharedOperation'

export interface CapacityCityRoute {
  routeId: string
  fromItemId: string
  toItemId: string
  kind: CapacityRouteKind
  confidence: 'Confirmed' | 'Probable' | 'Unknown'
  evidence: Evidence
}

/* ------------------------------------------------------------------ *
 * Timepoints — the city's clock
 * ------------------------------------------------------------------ */

/**
 * One 30-second smoothing timepoint.
 *
 * This is the animation clock and the source of every throttle gauge. 2,880 of them cover 24
 * hours. Percentages are of the SKU's per-timepoint CU budget, so 100 is exactly the SKU line and
 * values above it are bursting.
 */
export interface CapacityTimepoint {
  timepoint: string
  /** The SKU line for this timepoint, in CU-seconds. */
  cuLimit: number | null
  interactiveBillablePercent: number | null
  backgroundBillablePercent: number | null
  interactiveNonBillablePercent: number | null
  backgroundNonBillablePercent: number | null

  interactiveDelayPercent: number | null
  interactiveRejectionPercent: number | null
  backgroundRejectionPercent: number | null

  carryOverAddPercent: number | null
  carryOverBurndownPercent: number | null
  cumulativeCarryOverPercent: number | null
  expectedBurndownMinutes: number | null
}

/**
 * A single operation observed at a timepoint, for the live feed.
 *
 * `smoothingStart`/`smoothingEnd` are what make this more than a log line: they say how far into
 * the future this operation's CU cost has been spread, which is the mechanism behind every
 * throttle the city draws. An interactive operation smooths over 5–64 minutes and a background one
 * over 24 hours.
 */
export interface OperationSample {
  operationId: string
  operationName: string
  itemId: string
  workspaceId: string
  operationClass: OperationClass
  billingType: BillingType
  status: 'Success' | 'Failure' | 'Rejected' | 'Cancelled' | 'InProgress' | 'Unknown'
  startedAt: string
  endedAt: string | null
  durationSeconds: number | null
  totalCuSeconds: number | null
  /** CU charged to *this* timepoint, which is the smoothed share rather than the whole cost. */
  timepointCuSeconds: number | null
  throttlingSeconds: number | null
  smoothingStart: string | null
  smoothingEnd: string | null
  user: string | null
}

/* ------------------------------------------------------------------ *
 * The page the city is drawn from
 * ------------------------------------------------------------------ */

/**
 * Totals for the work that did not make the ranked page.
 *
 * Without this a city drawn from the top 50 items silently claims to be the whole capacity. These
 * are the figures that let the map state how much of the load is off-screen.
 */
export interface CapacityWorkloadAggregate {
  familyCount: string | null
  operationCount: string | null
  cuSeconds: string | null
  durationSeconds: number | null
  evidence: Evidence
}

export interface CapacityCityPage {
  schemaVersion: string
  capacityId: string
  capacityName: string
  metric: CapacityCityMetric
  pageSize: number
  nextPageToken: string | null
  totalItems: string | null
  window: { start: string; end: string }

  workspaces: CapacityCityWorkspace[]
  items: CapacityCityItem[]
  topOperationFamilies: OperationFamily[]
  otherWorkload: CapacityWorkloadAggregate
  routes: CapacityCityRoute[]

  /** Capacity-wide throttle state, which drives the civic infrastructure and the city's weather. */
  throttle: ThrottleState
  evidence: Evidence
}

export interface CapacityCitySummary {
  capacityId: string
  name: string
  workspaceCount: string | null
  itemCount: string | null
  cuSeconds: string | null
  storageBytes: string | null
  sizeStatus: MeasurementStatus
  evidence: Evidence
}

export interface CapacityCitySummarySnapshot {
  schemaVersion: string
  generatedAt: string
  capacities: CapacityCitySummary[]
}
