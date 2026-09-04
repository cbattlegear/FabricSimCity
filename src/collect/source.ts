import type { AtlasSnapshot } from '../fabricContracts'
import type {
  CapacityCityMetric,
  CapacityCityPage,
  CapacityCitySummarySnapshot,
  CapacityTimepoint,
  OperationSample,
} from '../capacityCityContracts'

/**
 * Which backend a source reads from.
 *
 * These are not interchangeable in quality, only in shape. `SemanticModel` is the only one with a
 * per-item CU breakdown and is also the only one Microsoft documents as unsupported for
 * programmatic use. `Eventhouse` is fully supported and 30 seconds fresh but knows nothing below
 * the capacity, so a city drawn from it has live infrastructure and static buildings. `Fixture` is
 * synthetic and is what makes the app developable without a Fabric tenant at all.
 */
export type CapacitySourceKind = 'SemanticModel' | 'Eventhouse' | 'Fixture'

/**
 * What a source can actually answer.
 *
 * Declared up front rather than discovered by calling and failing, because the UI has to decide
 * what to draw *before* it asks. An Eventhouse source reports `perItemBreakdown: false`, and the
 * city then draws its buildings from topology alone and says so, instead of rendering every item
 * at zero CU — which is the same "unmeasured drawn as measured" failure the evidence model exists
 * to prevent.
 */
export interface CapacitySourceCapabilities {
  /** Per-item CU and storage. False means buildings cannot be massed from telemetry. */
  perItemBreakdown: boolean
  /** Per-operation-family totals, which is what roads are drawn from. */
  operationFamilies: boolean
  /** Individual operation samples, which is what the live feed and vehicles are drawn from. */
  operationSamples: boolean
  /** 30-second timepoints, which drive the clock and every throttle gauge. */
  timepoints: boolean
  /** How far behind live the source runs, in seconds. */
  latencySeconds: number
  /** How much history it retains, in days. */
  retentionDays: number
}

export interface CityPageRequest {
  capacityId: string
  metric: CapacityCityMetric
  pageSize: number
  pageToken?: string | null
  signal?: AbortSignal
}

export interface TimepointRequest {
  capacityId: string
  /** Inclusive ISO start of the window. */
  start: string
  /** Exclusive ISO end of the window. */
  end: string
  signal?: AbortSignal
}

export interface OperationSampleRequest {
  capacityId: string
  /** The timepoint to sample, or the most recent one when omitted. */
  timepoint?: string | null
  limit: number
  signal?: AbortSignal
}

/**
 * One interface, three implementations.
 *
 * Everything the city knows about Fabric arrives through here. Keeping it this narrow is what lets
 * the officially-unsupported semantic model be swapped for the supported Eventhouse feed without
 * the visualization noticing, and what lets the whole app run on fixtures with no tenant.
 *
 * Implementations must not throw for a missing capability — a source whose capabilities say
 * `operationSamples: false` returns an empty array rather than rejecting, so a caller that forgot
 * to check degrades to a quiet city instead of an error screen.
 */
export interface CapacitySource {
  readonly kind: CapacitySourceKind
  readonly capabilities: CapacitySourceCapabilities

  /** Every capacity the signed-in user can see, with enough telemetry to size the atlas. */
  readAtlas(signal?: AbortSignal): Promise<AtlasSnapshot>

  /** Lightweight per-capacity totals, used before any city is opened. */
  readCitySummaries(signal?: AbortSignal): Promise<CapacityCitySummarySnapshot>

  /** One page of a capacity's workspaces, items, operation families and routes. */
  readCityPage(request: CityPageRequest): Promise<CapacityCityPage>

  /** 30-second timepoints across a window. Empty when the source cannot supply them. */
  readTimepoints(request: TimepointRequest): Promise<CapacityTimepoint[]>

  /** Individual operations for the live feed. Empty when the source cannot supply them. */
  readOperationSamples(request: OperationSampleRequest): Promise<OperationSample[]>
}

/**
 * Why a source could not be used.
 *
 * `Unsupported` is the load-bearing one: it is what the semantic-model source returns when the
 * Capacity Metrics model's schema has moved under it. That is a recoverable, expected condition —
 * Microsoft documents this access path as unsupported and it has already changed once — so it
 * surfaces as a reason to fall back rather than as a crash.
 */
export type SourceFailureKind =
  | 'Unauthenticated'
  | 'PermissionDenied'
  | 'NotConfigured'
  | 'Unsupported'
  | 'Network'
  | 'Unknown'

export class CapacitySourceError extends Error {
  readonly failure: SourceFailureKind
  readonly sourceKind: CapacitySourceKind

  constructor(sourceKind: CapacitySourceKind, failure: SourceFailureKind, message: string) {
    super(message)
    this.name = 'CapacitySourceError'
    this.failure = failure
    this.sourceKind = sourceKind
  }
}

/** Items requested per city page. Matches the old collector's ceiling on inventory probes. */
export const CITY_PAGE_SIZE = 50

export type { CapacityCityMetric }
