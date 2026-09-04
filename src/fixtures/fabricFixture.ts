import { mulberry32, seededIndex } from '../citySeed'
import { itemArchetype, normalizeItemKind } from '../itemKind'
import { SKU_CAPACITY_UNITS, TIMEPOINT_SECONDS, THROTTLE_WINDOW_TIMEPOINTS } from '../fabricContracts'
import type { CapacityState, CapacityStateReason, FabricSku, ThrottleStage } from '../fabricContracts'
import type { FabricItemKind } from '../capacityCityContracts'

/**
 * Synthetic Fabric evidence.
 *
 * This is not a demo convenience. Rayfin has no local backend and no `rayfin dev` — `npm run dev`
 * normally deploys to Fabric first and serves Vite against it — so without fixtures the city
 * cannot be opened, changed or tested by anyone who does not have a Fabric tenant with the
 * Capacity Metrics app installed and capacity-admin rights. Fixtures are the development loop.
 *
 * Everything here is a pure function of a seed string, so the same fixture draws the same city on
 * every machine forever, and a test can assert on an exact number rather than on a range.
 *
 * The generated numbers are made to be *internally consistent* rather than merely plausible. A
 * profile declares a load shape and nothing else; the capacity's state and throttle stage are
 * computed from that shape using Fabric's real window sizes. A fixture cannot therefore claim to
 * be overloaded while its own series says otherwise, which is exactly the kind of disagreement
 * that would let a bug in the throttle maths pass every test.
 */

const TIMEPOINTS_PER_DAY = (24 * 60 * 60) / TIMEPOINT_SECONDS

/** How much history the fixture covers. Matches the metrics app's 14-day compute window. */
export const FIXTURE_HISTORY_DAYS = 14

/**
 * Index of "now" within the generated series.
 *
 * The series deliberately runs 24 hours *past* now. Every Fabric throttle gauge is an average of
 * *future* smoothed usage — that is why a capacity can be throttled while the current timepoint
 * sits under the line — so a series that stopped at now would leave all three gauges reading a
 * one-element window, and every capacity would look healthy no matter how it was loaded.
 */
export const NOW_INDEX = TIMEPOINTS_PER_DAY * FIXTURE_HISTORY_DAYS

/** Total generated timepoints: 14 days of history plus 24 hours of committed future smoothing. */
export const SERIES_LENGTH = NOW_INDEX + THROTTLE_WINDOW_TIMEPOINTS.backgroundRejection

function stableHash(text: string): number {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** A deterministic GUID-shaped id. Real Fabric ids are GUIDs and some code slices them. */
function fixtureGuid(seed: string): string {
  const rng = mulberry32(stableHash(seed))
  const hex = '0123456789abcdef'
  let out = ''
  for (let index = 0; index < 32; index += 1) {
    out += hex[seededIndex(rng, 16)]
    if (index === 7 || index === 11 || index === 15 || index === 19) out += '-'
  }
  return out
}

/**
 * A recurring surge in load, anchored so that one of its peaks lands exactly on `NOW_INDEX`.
 *
 * Surges are how a fixture reaches a *specific* throttle stage rather than merely a busy one. The
 * three gauges average 10 minutes, 60 minutes and 24 hours, so the width of a surge decides which
 * of them it lifts over the line: a five-minute spike moves only the first, an hour-long swell
 * moves the first two, and a load that never comes down moves all three. Anchoring a peak at now
 * is what makes the resulting state stable regardless of what time of day the fixture is built.
 */
export interface FixtureSurge {
  /** Peak height, as a fraction of the SKU budget added on top of the daily curve. */
  amplitude: number
  /** Gaussian width in timepoints. 10 is five minutes; 120 is an hour. */
  widthTimepoints: number
  /** Timepoints between peaks. */
  cycleTimepoints: number
}

export interface FixtureItemProfile {
  name: string
  kind: FabricItemKind
  /** Share of the capacity's CU consumption. Normalised across the capacity's items. */
  cuWeight: number
  /** OneLake bytes. Null for kinds that genuinely store nothing. */
  storageBytes: number | null
}

export interface FixtureWorkspaceProfile {
  name: string
  items: FixtureItemProfile[]
}

export interface FixtureCapacityProfile {
  displayName: string
  sku: FabricSku
  region: string
  /**
   * Paused capacities are the one state that is *not* derived from load, because it is not a
   * function of load. Everything else about a capacity's state falls out of its series.
   */
  paused: boolean
  /** Baseline utilization as a fraction of the SKU budget, before the daily curve is applied. */
  baseUtilization: number
  /** How pronounced the business-hours curve is. 0 is flat, 1 is a deep trough overnight. */
  peakiness: number
  surges: readonly FixtureSurge[]
  workspaces: FixtureWorkspaceProfile[]
}

const GB = 1024 ** 3

function item(
  name: string,
  kind: string,
  cuWeight: number,
  storageGb: number | null = null,
): FixtureItemProfile {
  const normalized = normalizeItemKind(kind)
  /*
   * A compute-only kind is forced to null storage regardless of what the profile asks for. The
   * distinction between "stores nothing" and "storage not measured" is load-bearing in the city —
   * one draws as a minimum lot and the other as wireframe — and a fixture that gave a Notebook
   * bytes would quietly prove the wrong one.
   */
  const canStore = itemArchetype(normalized) === 'Storage'
  return {
    name,
    kind: normalized,
    cuWeight,
    storageBytes: canStore && storageGb !== null ? Math.round(storageGb * GB) : null,
  }
}

/** A five-minute interactive spike every 90 minutes. Lifts only the 10-minute gauge. */
const SHORT_SPIKE: FixtureSurge = { amplitude: 1.6, widthTimepoints: 10, cycleTimepoints: 180 }

/** An hour-long swell once a day. Lifts the 10- and 60-minute gauges but not the 24-hour one. */
const HOUR_SWELL: FixtureSurge = { amplitude: 0.8, widthTimepoints: 120, cycleTimepoints: 2880 }

/**
 * The tenant the fixture draws.
 *
 * Six capacities chosen to cover every state the city has to render: two healthy, then one at each
 * of the three throttle stages, then a paused capacity that emits no telemetry at all. That last
 * one is the case most likely to be drawn wrong, because a suspended capacity and an idle one
 * produce identical zeroes and are completely different things.
 */
export const FIXTURE_PROFILES: readonly FixtureCapacityProfile[] = Object.freeze([
  {
    displayName: 'Contoso Analytics',
    sku: 'F64',
    region: 'West Europe',
    paused: false,
    baseUtilization: 0.46,
    peakiness: 0.7,
    surges: [],
    workspaces: [
      {
        name: 'Sales Reporting',
        items: [
          item('sales_gold', 'Lakehouse', 9, 840),
          item('sales_silver', 'Lakehouse', 6, 2100),
          item('Sales Warehouse', 'Warehouse', 11, 460),
          item('Sales Executive', 'Report', 3),
          item('Sales Semantic', 'SemanticModel', 7),
          item('Nightly Sales Load', 'DataPipeline', 5),
          item('Revenue Forecast', 'Notebook', 4),
        ],
      },
      {
        name: 'Customer 360',
        items: [
          item('customer_raw', 'Lakehouse', 5, 3400),
          item('customer_curated', 'Lakehouse', 7, 1250),
          item('Identity Resolution', 'Notebook', 8),
          item('Churn Model', 'MLModel', 3),
          item('Churn Experiment', 'MLExperiment', 2),
          item('Customer Insights', 'Report', 2),
        ],
      },
      {
        name: 'Supply Chain',
        items: [
          item('inventory_lh', 'Lakehouse', 6, 720),
          item('Inventory Warehouse', 'Warehouse', 8, 310),
          item('Supplier Feed', 'Eventstream', 4),
          item('Logistics Events', 'Eventhouse', 5, 180),
          item('Reorder Alerts', 'Reflex', 1),
          item('Supply Dashboard', 'Dashboard', 2),
        ],
      },
      {
        name: 'Platform Engineering',
        items: [
          item('FabricSimCity', 'AppBackend', 2),
          item('Ops Copy Job', 'CopyJob', 3),
          item('Shared Environment', 'Environment', 1),
          item('Platform Variables', 'VariableLibrary', 1),
          item('Cost API', 'GraphQLApi', 2),
        ],
      },
    ],
  },
  {
    displayName: 'Adventure Works Platform',
    sku: 'F256',
    region: 'East US 2',
    paused: false,
    baseUtilization: 0.34,
    peakiness: 0.45,
    surges: [],
    workspaces: [
      {
        name: 'Enterprise Warehouse',
        items: [
          item('EDW', 'Warehouse', 14, 12400),
          item('EDW Snapshot', 'WarehouseSnapshot', 3, 12400),
          item('edw_staging', 'Lakehouse', 9, 8600),
          item('EDW Semantic', 'SemanticModel', 8),
          item('EDW Load', 'DataPipeline', 7),
        ],
      },
      {
        name: 'Manufacturing Telemetry',
        items: [
          item('Plant Telemetry', 'Eventhouse', 12, 5200),
          item('Plant Stream', 'Eventstream', 6),
          item('Sensor Queries', 'KQLQueryset', 3),
          item('Plant Floor', 'KQLDashboard', 2),
          item('Anomaly Watch', 'AnomalyDetector', 4),
        ],
      },
      {
        name: 'Finance',
        items: [
          item('finance_lh', 'Lakehouse', 5, 940),
          item('Finance Mart', 'Datamart', 4, 260),
          item('Statutory Reporting', 'PaginatedReport', 3),
          item('Close Pipeline', 'DataPipeline', 4),
          item('Finance Agent', 'DataAgent', 2),
        ],
      },
    ],
  },
  {
    /*
     * Reliably in interactive delay and nothing worse: a moderate baseline with a sharp five-minute
     * spike on top. The spike is far too brief to move the 60-minute gauge, which is precisely what
     * separates this stage from the next one.
     */
    displayName: 'Northwind Reporting',
    sku: 'F8',
    region: 'North Europe',
    paused: false,
    baseUtilization: 0.75,
    peakiness: 0.35,
    surges: [SHORT_SPIKE],
    workspaces: [
      {
        name: 'Executive Reporting',
        items: [
          item('Exec Semantic', 'SemanticModel', 18),
          item('Exec Dashboard', 'Dashboard', 6),
          item('Daily Exec Report', 'Report', 9),
          item('Board Pack', 'PaginatedReport', 5),
        ],
      },
      {
        name: 'Regional Sales',
        items: [
          item('region_lh', 'Lakehouse', 7, 410),
          item('Region Warehouse', 'Warehouse', 12, 220),
          item('Hourly Refresh', 'DataPipeline', 8),
          item('Region Dataflow', 'Dataflow Gen2', 11),
          item('Territory Report', 'Report', 4),
        ],
      },
    ],
  },
  {
    /*
     * Interactive rejection but background still flowing: an hour-long swell once a day. Wide
     * enough to carry the 60-minute gauge over the line, far too narrow to move the 24-hour one.
     */
    displayName: 'Litware Trading',
    sku: 'F32',
    region: 'Southeast Asia',
    paused: false,
    baseUtilization: 0.75,
    peakiness: 0.2,
    surges: [HOUR_SWELL],
    workspaces: [
      {
        name: 'Market Data',
        items: [
          item('ticks_lh', 'Lakehouse', 10, 6100),
          item('Market Eventhouse', 'Eventhouse', 14, 3300),
          item('Tick Stream', 'Eventstream', 8),
          item('Quote Queryset', 'KQLQueryset', 4),
        ],
      },
      {
        name: 'Risk',
        items: [
          item('Risk Warehouse', 'Warehouse', 12, 880),
          item('VaR Notebook', 'Notebook', 9),
          item('Risk Semantic', 'SemanticModel', 7),
          item('Overnight Risk Run', 'DataPipeline', 6),
          item('Risk Report', 'Report', 3),
        ],
      },
    ],
  },
  {
    /*
     * Everything rejected. A baseline that never comes below the SKU line, so even the 24-hour
     * gauge is over — which is the only way to reach this stage, and the reason carry-forward debt
     * on this capacity grows without ever burning down.
     */
    displayName: 'Fabrikam Dev',
    sku: 'F2',
    region: 'Central US',
    paused: false,
    baseUtilization: 1.62,
    peakiness: 0.3,
    surges: [],
    workspaces: [
      {
        name: 'Data Science Sandbox',
        items: [
          item('Runaway Training', 'Notebook', 34),
          item('Feature Store', 'Lakehouse', 6, 120),
          item('Experiment Sweep', 'MLExperiment', 12),
          item('Candidate Model', 'MLModel', 5),
          item('Spark Batch', 'SparkJobDefinition', 9),
        ],
      },
      {
        name: 'Prototypes',
        items: [
          item('proto_lh', 'Lakehouse', 3, 45),
          item('Scratch Pipeline', 'DataPipeline', 4),
          item('Prototype API', 'GraphQL', 2),
        ],
      },
    ],
  },
  {
    displayName: 'Tailspin Archive',
    sku: 'F4',
    region: 'UK South',
    paused: true,
    baseUtilization: 0,
    peakiness: 0,
    surges: [],
    workspaces: [
      {
        name: 'Cold Storage',
        items: [
          item('archive_2023', 'Lakehouse', 1, 9800),
          item('archive_2024', 'Lakehouse', 1, 11200),
          item('Archive Catalog', 'SemanticModel', 1),
        ],
      },
    ],
  },
])

export interface FixtureCapacity {
  capacityId: string
  displayName: string
  sku: FabricSku
  capacityUnits: number
  region: string
  state: CapacityState
  stateReason: CapacityStateReason
  workspaces: Array<{ workspaceId: string; name: string; ordinal: number }>
  items: Array<{
    itemId: string
    workspaceId: string
    name: string
    kind: FabricItemKind
    cuSeconds: number
    storageBytes: number | null
    ordinal: number
    neighborhoodOrdinal: number
  }>
  /**
   * Utilization per timepoint as a fraction of the SKU budget, from `windowStart` to 24 hours
   * after `windowEnd`.
   *
   * Everything else about the capacity's load — the throttle gauges, the carry-forward, the
   * per-timepoint split, even the state — is derived from this one series, so the fixture cannot
   * contradict itself.
   */
  utilization: readonly number[]
  /** Start of the history window. */
  windowStart: Date
  /** "Now": the end of history, and the point every current-state reading is taken at. */
  windowEnd: Date
  /** Index of `windowEnd` in `utilization`. Always `NOW_INDEX`. */
  nowIndex: number
}

/**
 * The daily load curve at an absolute time.
 *
 * A business-hours hump plus a small overnight batch bump, scaled by `peakiness`, plus any surges
 * the profile declares. Hour-of-day comes from the real timestamp rather than the array index, so
 * the fixture's busy period lines up with the city's own day/night cycle.
 */
function utilizationAt(
  index: number,
  timestampMs: number,
  profile: FixtureCapacityProfile,
  rng: () => number,
): number {
  if (profile.baseUtilization <= 0) return 0

  const hour = (timestampMs % 86_400_000) / 3_600_000

  // Interactive work clusters between 08:00 and 18:00.
  const business = Math.exp(-(((hour - 13) / 4.2) ** 2))
  // Background refreshes cluster just after midnight.
  const batch = 0.55 * Math.exp(-(((hour - 2) / 1.6) ** 2))

  const shape = 1 - profile.peakiness + profile.peakiness * (business + batch) * 1.35
  const noise = 0.95 + rng() * 0.1

  let surge = 0
  for (const entry of profile.surges) {
    // Distance to the nearest peak, with peaks anchored so one lands exactly on NOW_INDEX.
    const cycle = entry.cycleTimepoints
    let phase = (((index - NOW_INDEX) % cycle) + cycle) % cycle
    if (phase > cycle / 2) phase -= cycle
    surge += entry.amplitude * Math.exp(-((phase / entry.widthTimepoints) ** 2))
  }

  return Math.max(0, profile.baseUtilization * shape * noise + surge)
}

/**
 * Prefix sums, so a forward-window mean is two lookups instead of a loop.
 *
 * The background gauge averages 2,880 timepoints and the city asks for it at every one of the
 * 43,200 timepoints in the series. Done naively that is 124 million additions to draw one chart,
 * which is slow enough to be felt on every refresh.
 */
function prefixSums(series: readonly number[]): Float64Array {
  const out = new Float64Array(series.length + 1)
  for (let index = 0; index < series.length; index += 1) out[index + 1] = out[index] + series[index]
  return out
}

/**
 * Mean of a forward window, clamped to the end of the series.
 *
 * Clamping rather than wrapping matters: wrapping would let the end of the series borrow the
 * beginning's load and invent a throttle the series does not contain. The series carries 24 hours
 * of future precisely so that this clamp is never reached for a reading taken at `NOW_INDEX`.
 */
function forwardMean(prefix: Float64Array, from: number, length: number): number {
  const count = prefix.length - 1
  const end = Math.min(count, from + length)
  if (end <= from) return 0
  return (prefix[end] - prefix[from]) / (end - from)
}

export function throttleStageFor(
  interactiveDelayPercent: number,
  interactiveRejectionPercent: number,
  backgroundRejectionPercent: number,
): ThrottleStage {
  if (backgroundRejectionPercent > 100) return 'BackgroundRejection'
  if (interactiveRejectionPercent > 100) return 'InteractiveRejection'
  if (interactiveDelayPercent > 100) return 'InteractiveDelay'
  return 'None'
}

export interface FixtureThrottleReading {
  interactiveDelayPercent: number
  interactiveRejectionPercent: number
  backgroundRejectionPercent: number
  carryOverAddPercent: number
  carryOverBurndownPercent: number
  cumulativeCarryOverPercent: number
  expectedBurndownMinutes: number | null
  stage: ThrottleStage
}

/** Carry-forward debt at each timepoint, accumulated forward through the series. */
export function carryOverSeries(series: readonly number[]): number[] {
  const out = new Array<number>(series.length)
  let debt = 0
  for (let index = 0; index < series.length; index += 1) {
    const usage = series[index]
    debt += Math.max(0, usage - 1)
    debt -= Math.min(debt, Math.max(0, 1 - usage))
    out[index] = debt
  }
  return out
}

/**
 * Reads the throttle gauges at any timepoint of one capacity's series.
 *
 * Built once per capacity and reused, because the three gauges share one set of prefix sums and
 * the carry-forward has to be accumulated forward through the whole series before any single
 * timepoint can be answered.
 */
export interface ThrottleReader {
  readonly length: number
  readonly carryOver: readonly number[]
  at(index: number): FixtureThrottleReading
}

export function createThrottleReader(series: readonly number[]): ThrottleReader {
  const prefix = prefixSums(series)
  const carryOver = carryOverSeries(series)

  return {
    length: series.length,
    carryOver,
    at(index: number): FixtureThrottleReading {
      const clamped = Math.max(0, Math.min(series.length - 1, index))
      const delay = forwardMean(prefix, clamped, THROTTLE_WINDOW_TIMEPOINTS.interactiveDelay) * 100
      const rejection =
        forwardMean(prefix, clamped, THROTTLE_WINDOW_TIMEPOINTS.interactiveRejection) * 100
      const background =
        forwardMean(prefix, clamped, THROTTLE_WINDOW_TIMEPOINTS.backgroundRejection) * 100

      const current = series[clamped] ?? 0
      const debt = carryOver[clamped] ?? 0
      const added = Math.max(0, current - 1)
      const burndown = Math.min(debt, Math.max(0, 1 - current))

      return {
        interactiveDelayPercent: delay,
        interactiveRejectionPercent: rejection,
        backgroundRejectionPercent: background,
        carryOverAddPercent: added * 100,
        carryOverBurndownPercent: burndown * 100,
        cumulativeCarryOverPercent: debt * 100,
        /*
         * Minutes to clear the debt assuming no further consumption. Null rather than Infinity when
         * nothing is being burned down while debt remains: "this will never clear at the current
         * rate" is a real state, and a number would draw a countdown that is not true.
         */
        expectedBurndownMinutes:
          debt <= 0 ? 0 : burndown > 0 ? (debt / burndown) * (TIMEPOINT_SECONDS / 60) : null,
        stage: throttleStageFor(delay, rejection, background),
      }
    },
  }
}

/** Convenience for a one-off read. Builds a whole reader, so never call this in a loop. */
export function readThrottle(series: readonly number[], index: number): FixtureThrottleReading {
  return createThrottleReader(series).at(index)
}

/**
 * The capacity state implied by a throttle stage.
 *
 * Derived rather than declared. A profile says how hard the capacity is worked and the state falls
 * out of the resulting series, so the fixture cannot advertise a state its own numbers contradict.
 */
export function stateForStage(
  stage: ThrottleStage,
  paused: boolean,
): { state: CapacityState; reason: CapacityStateReason } {
  if (paused) return { state: 'Suspended', reason: 'ManuallyPaused' }
  switch (stage) {
    case 'BackgroundRejection':
      return { state: 'Overloaded', reason: 'AllRejected' }
    case 'InteractiveRejection':
      return { state: 'Overloaded', reason: 'InteractiveRejected' }
    case 'InteractiveDelay':
      return { state: 'Overloaded', reason: 'InteractiveDelay' }
    case 'None':
    default:
      return { state: 'Active', reason: 'NotOverloaded' }
  }
}

export function buildFixtureCapacity(
  profile: FixtureCapacityProfile,
  now: Date,
  seed: string,
): FixtureCapacity {
  const capacityId = fixtureGuid(`${seed}:capacity:${profile.displayName}`)
  const capacityUnits = SKU_CAPACITY_UNITS[profile.sku]
  const stepMs = TIMEPOINT_SECONDS * 1000

  const windowEnd = new Date(Math.floor(now.getTime() / stepMs) * stepMs)
  const windowStart = new Date(windowEnd.getTime() - NOW_INDEX * stepMs)

  const rng = mulberry32(stableHash(`${seed}:util:${profile.displayName}`))
  const utilization: number[] = new Array(SERIES_LENGTH)
  for (let index = 0; index < SERIES_LENGTH; index += 1) {
    utilization[index] = utilizationAt(index, windowStart.getTime() + index * stepMs, profile, rng)
  }

  const { state, reason } = stateForStage(
    createThrottleReader(utilization).at(NOW_INDEX).stage,
    profile.paused,
  )

  const workspaces = profile.workspaces.map((workspace, ordinal) => ({
    workspaceId: fixtureGuid(`${seed}:ws:${profile.displayName}:${workspace.name}`),
    name: workspace.name,
    ordinal,
  }))

  const totalWeight = profile.workspaces.reduce(
    (sum, workspace) => sum + workspace.items.reduce((inner, entry) => inner + entry.cuWeight, 0),
    0,
  )
  /*
   * Total CU-seconds consumed across the *history* window, from the series rather than from the
   * baseline. Deriving it from the series is what keeps the sum of the buildings equal to the area
   * under the capacity's own load curve — otherwise the city's towers and its power plant would
   * disagree about how much work was done. The future tail is excluded: it has not happened yet.
   */
  let consumedFraction = 0
  for (let index = 0; index < NOW_INDEX; index += 1) consumedFraction += utilization[index]
  const consumedCuSeconds = consumedFraction * capacityUnits * TIMEPOINT_SECONDS

  let itemOrdinal = 0
  const items: FixtureCapacity['items'] = []
  profile.workspaces.forEach((workspace, workspaceIndex) => {
    for (const entry of workspace.items) {
      const share = totalWeight > 0 ? entry.cuWeight / totalWeight : 0
      items.push({
        itemId: fixtureGuid(`${seed}:item:${profile.displayName}:${workspace.name}:${entry.name}`),
        workspaceId: workspaces[workspaceIndex].workspaceId,
        name: entry.name,
        kind: entry.kind,
        cuSeconds: consumedCuSeconds * share,
        storageBytes: entry.storageBytes,
        ordinal: itemOrdinal,
        neighborhoodOrdinal: workspaceIndex,
      })
      itemOrdinal += 1
    }
  })

  return {
    capacityId,
    displayName: profile.displayName,
    sku: profile.sku,
    capacityUnits,
    region: profile.region,
    state,
    stateReason: reason,
    workspaces,
    items,
    utilization,
    windowStart,
    windowEnd,
    nowIndex: NOW_INDEX,
  }
}

export interface FixtureTenant {
  tenantId: string
  displayName: string
  generatedAt: Date
  capacities: FixtureCapacity[]
}

export const FIXTURE_SEED = 'fabricsimcity'

export function buildFixtureTenant(now: Date, seed: string = FIXTURE_SEED): FixtureTenant {
  return {
    tenantId: fixtureGuid(`${seed}:tenant`),
    displayName: 'Contoso Ltd',
    generatedAt: now,
    capacities: FIXTURE_PROFILES.map((profile) => buildFixtureCapacity(profile, now, seed)),
  }
}

export { TIMEPOINTS_PER_DAY, fixtureGuid, stableHash }
