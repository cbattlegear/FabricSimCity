import { mulberry32, seededIndex } from '../citySeed'
import { itemArchetype } from '../itemKind'
import { TIMEPOINT_SECONDS } from '../fabricContracts'
import type {
  AtlasSnapshot,
  ByteMeasurement,
  CapacityAtlasItem,
  CuMeasurement,
  Evidence,
  ThrottleState,
} from '../fabricContracts'
import type {
  CapacityCityItem,
  CapacityCityPage,
  CapacityCitySummary,
  CapacityCitySummarySnapshot,
  CapacityCityWorkspace,
  CapacityTimepoint,
  FabricItemKind,
  ItemOperationCounts,
  OperationClass,
  OperationFamily,
  OperationSample,
} from '../capacityCityContracts'
import {
  buildFixtureTenant,
  createThrottleReader,
  stableHash,
  type FixtureCapacity,
  type FixtureTenant,
  type ThrottleReader,
} from '../fixtures/fabricFixture'
import type {
  CapacitySource,
  CapacitySourceCapabilities,
  CityPageRequest,
  OperationSampleRequest,
  TimepointRequest,
} from './source'

/**
 * The fixture implementation of `CapacitySource`.
 *
 * Answers every question the city can ask, from synthetic evidence, with no Fabric tenant and no
 * network. This is the development and test loop for the whole app.
 *
 * It is deliberately not a stub. It reports real evidence provenance (`source: 'Fixture'`), obeys
 * the same paging contract as the live sources, and derives its throttle gauges from its own load
 * series using Fabric's real window sizes — so a bug in how the city reads a throttle shows up
 * here rather than waiting for a deployment.
 */

const SCHEMA_VERSION = '1.0'

const FIXTURE_CAPABILITIES: CapacitySourceCapabilities = Object.freeze({
  perItemBreakdown: true,
  operationFamilies: true,
  operationSamples: true,
  timepoints: true,
  latencySeconds: 0,
  retentionDays: 14,
})

/** Operation names per archetype, with the class that decides which throttle gate they queue at. */
const OPERATIONS: Readonly<Record<string, ReadonlyArray<[string, OperationClass]>>> = Object.freeze({
  Lakehouse: [
    ['OneLake Read via Redirect', 'Interactive'],
    ['OneLake Write via Redirect', 'Background'],
    ['Lakehouse Table Maintenance', 'Background'],
  ],
  Warehouse: [
    ['Warehouse Query', 'Interactive'],
    ['Warehouse Query (Background)', 'Background'],
  ],
  WarehouseSnapshot: [['Warehouse Query', 'Interactive']],
  SqlEndpoint: [['SQL Analytics Endpoint Query', 'Interactive']],
  SqlDatabase: [
    ['SQL Database Query', 'Interactive'],
    ['SQL Database Storage', 'Background'],
  ],
  MirroredDatabase: [['Mirrored Database Replication', 'Background']],
  Eventhouse: [
    ['Eventhouse Query', 'Interactive'],
    ['Eventhouse Ingestion', 'Background'],
    ['Eventhouse Uptime', 'Background'],
  ],
  KqlDatabase: [['KQL Database Query', 'Interactive']],
  KqlQueryset: [['KQL Queryset Query', 'Interactive']],
  KqlDashboard: [['KQL Dashboard Render', 'Interactive']],
  Eventstream: [
    ['Eventstream Processing', 'Background'],
    ['Eventstream Uptime', 'Background'],
  ],
  SemanticModel: [
    ['Semantic model interactive query', 'Interactive'],
    ['Semantic model scheduled refresh', 'Background'],
    ['Semantic model on-demand refresh', 'Interactive'],
  ],
  Report: [['Report Render', 'Interactive']],
  PaginatedReport: [['Paginated Report Render', 'Interactive']],
  Dashboard: [['Dashboard Render', 'Interactive']],
  Datamart: [['Datamart Query', 'Interactive']],
  Notebook: [
    ['Notebook Run', 'Background'],
    ['Spark Interactive Session', 'Interactive'],
  ],
  SparkJobDefinition: [['Spark Job Run', 'Background']],
  Environment: [['Spark Environment Publish', 'Background']],
  DataPipeline: [
    ['Pipeline Activity Run', 'Background'],
    ['Data Movement', 'Background'],
  ],
  Dataflow: [['Dataflow Gen2 Refresh', 'Background']],
  CopyJob: [['Copy Job Run', 'Background']],
  ApacheAirflowJob: [['Airflow DAG Run', 'Background']],
  MlModel: [['ML Model Scoring', 'Interactive']],
  MlExperiment: [['ML Experiment Run', 'Background']],
  AiSkill: [['AI Skill Invocation', 'Interactive']],
  DataAgent: [['Data Agent Query', 'Interactive']],
  GraphQlApi: [['GraphQL Query', 'Interactive']],
  UserDataFunction: [['User Data Function Invocation', 'Interactive']],
  Reflex: [['Reflex Rule Evaluation', 'Background']],
  VariableLibrary: [['Variable Library Read', 'Interactive']],
  DigitalTwinBuilder: [['Digital Twin Flow Run', 'Background']],
  GraphModel: [['Graph Query', 'Interactive']],
  Ontology: [['Ontology Query', 'Interactive']],
  AppBackend: [['App Backend Request', 'Interactive']],
  OrgApp: [['Org App Render', 'Interactive']],
  Unknown: [['Operation', 'Unknown']],
})

function operationsFor(kind: FabricItemKind): ReadonlyArray<[string, OperationClass]> {
  return OPERATIONS[kind] ?? OPERATIONS.Unknown
}

function fixtureEvidence(observedAt: Date, freshForSeconds = 300): Evidence {
  return {
    source: 'Fixture',
    status: 'Available',
    observedAt: observedAt.toISOString(),
    freshUntil: new Date(observedAt.getTime() + freshForSeconds * 1000).toISOString(),
  }
}

/**
 * Evidence for a capacity that is paused.
 *
 * A suspended capacity emits no telemetry at all, so its measurements are `Unknown` rather than
 * zero and its evidence says `Disconnected`. This is the case the whole evidence model exists for:
 * an idle capacity and a paused one produce identical zeroes and are completely different things.
 */
function pausedEvidence(observedAt: Date): Evidence {
  return {
    source: 'Fixture',
    status: 'Disconnected',
    observedAt: observedAt.toISOString(),
    freshUntil: null,
  }
}

function bytes(value: number | null, evidence: Evidence): ByteMeasurement {
  return value === null
    ? { bytes: null, status: 'Unknown', evidence }
    : { bytes: Math.round(value).toString(), status: 'Known', evidence }
}

function cu(value: number | null, evidence: Evidence): CuMeasurement {
  return value === null
    ? { cuSeconds: null, status: 'Unknown', evidence }
    : { cuSeconds: Math.round(value).toString(), status: 'Known', evidence }
}

function isPaused(capacity: FixtureCapacity): boolean {
  return capacity.state === 'Suspended' || capacity.state === 'Deleted'
}

/** Index of "now" — the point every current-state reading is taken at. */
function nowIndexOf(capacity: FixtureCapacity): number {
  return capacity.nowIndex
}

function throttleStateFor(capacity: FixtureCapacity, reader: ThrottleReader, now: Date): ThrottleState {
  if (isPaused(capacity)) {
    return {
      stage: 'None',
      interactiveDelayPercent: null,
      interactiveRejectionPercent: null,
      backgroundRejectionPercent: null,
      cumulativeCarryOverPercent: null,
      expectedBurndownMinutes: null,
      surgeProtectionActive: false,
      evidence: pausedEvidence(now),
    }
  }
  const reading = reader.at(nowIndexOf(capacity))
  return {
    stage: reading.stage,
    interactiveDelayPercent: reading.interactiveDelayPercent,
    interactiveRejectionPercent: reading.interactiveRejectionPercent,
    backgroundRejectionPercent: reading.backgroundRejectionPercent,
    cumulativeCarryOverPercent: reading.cumulativeCarryOverPercent,
    expectedBurndownMinutes: reading.expectedBurndownMinutes,
    surgeProtectionActive: capacity.stateReason.includes('SurgeProtection'),
    evidence: fixtureEvidence(now),
  }
}

function totalStorage(capacity: FixtureCapacity): number {
  return capacity.items.reduce((sum, entry) => sum + (entry.storageBytes ?? 0), 0)
}

function totalCu(capacity: FixtureCapacity): number {
  return capacity.items.reduce((sum, entry) => sum + entry.cuSeconds, 0)
}

function emptyCounts(): ItemOperationCounts {
  return { total: null, successful: null, rejected: null, failed: null, invalid: null, cancelled: null }
}

/**
 * Operation outcome counts for one item.
 *
 * Rejections are only produced for capacities that are actually in a rejecting stage, and failures
 * only ever appear alongside real traffic. A fixture that sprinkled rejections everywhere would
 * make the incident pins meaningless, and one that never produced any would leave the whole
 * throttle-incident path untested.
 */
function operationCounts(
  total: number,
  stage: ThrottleState['stage'],
  operationClass: OperationClass,
  rng: () => number,
): ItemOperationCounts {
  const rounded = Math.max(0, Math.round(total))
  if (rounded === 0) return emptyCounts()

  const rejecting =
    (operationClass === 'Interactive' && stage === 'InteractiveRejection') ||
    stage === 'BackgroundRejection'
  const rejected = rejecting ? Math.round(rounded * (0.08 + rng() * 0.22)) : 0
  const failed = Math.round(rounded * rng() * 0.02)
  const cancelled = Math.round(rounded * rng() * 0.01)
  const successful = Math.max(0, rounded - rejected - failed - cancelled)

  return {
    total: rounded.toString(),
    successful: successful.toString(),
    rejected: rejected.toString(),
    failed: failed.toString(),
    invalid: '0',
    cancelled: cancelled.toString(),
  }
}

interface DerivedCapacity {
  fixture: FixtureCapacity
  reader: ThrottleReader
  throttle: ThrottleState
}

export interface FixtureSourceOptions {
  /** Fixed clock, so a test never races midnight. Defaults to the real one. */
  now?: () => Date
  seed?: string
  /** Artificial delay in milliseconds, to exercise loading states. */
  latencyMs?: number
}

export function createFixtureSource(options: FixtureSourceOptions = {}): CapacitySource {
  const clock = options.now ?? (() => new Date())
  const latencyMs = options.latencyMs ?? 0

  let tenant: FixtureTenant | null = null
  let derived = new Map<string, DerivedCapacity>()
  let builtForMinute = ''

  /**
   * Rebuild the tenant when the clock crosses into a new minute.
   *
   * Rebuilding per call would make every number move under the city on every poll; never
   * rebuilding would freeze the live feed. A minute is coarse enough that a render is stable and
   * fine enough that the clock visibly advances.
   */
  function tenantNow(): { tenant: FixtureTenant; now: Date } {
    const now = clock()
    const minute = now.toISOString().slice(0, 16)
    if (!tenant || minute !== builtForMinute) {
      tenant = buildFixtureTenant(now, options.seed)
      builtForMinute = minute
      derived = new Map(
        tenant.capacities.map((capacity) => {
          const reader = createThrottleReader(capacity.utilization)
          return [
            capacity.capacityId,
            { fixture: capacity, reader, throttle: throttleStateFor(capacity, reader, now) },
          ]
        }),
      )
    }
    return { tenant, now }
  }

  function requireCapacity(capacityId: string): DerivedCapacity {
    tenantNow()
    const found = derived.get(capacityId)
    if (!found) throw new Error(`Unknown fixture capacity: ${capacityId}`)
    return found
  }

  async function settle<T>(value: T, signal?: AbortSignal): Promise<T> {
    if (latencyMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const handle = setTimeout(resolve, latencyMs)
        signal?.addEventListener('abort', () => {
          clearTimeout(handle)
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
    }
    signal?.throwIfAborted()
    return value
  }

  function atlasItem(entry: DerivedCapacity, now: Date): CapacityAtlasItem {
    const { fixture, reader, throttle } = entry
    const paused = isPaused(fixture)
    const evidence = paused ? pausedEvidence(now) : fixtureEvidence(now)

    let peak = 0
    let mean = 0
    if (!paused) {
      // History only. The series carries 24 hours of future for the gauges; it has not happened.
      for (let index = 0; index < fixture.nowIndex; index += 1) {
        const value = fixture.utilization[index]
        if (value > peak) peak = value
        mean += value
      }
      mean /= fixture.nowIndex
    }

    return {
      capacityId: fixture.capacityId,
      displayName: fixture.displayName,
      sku: fixture.sku,
      capacityUnits: fixture.capacityUnits,
      region: fixture.region,
      state: fixture.state,
      stateReason: fixture.stateReason,
      cuConsumed: cu(paused ? null : totalCu(fixture), evidence),
      meanUtilizationPercent: paused ? null : mean * 100,
      peakUtilizationPercent: paused ? null : peak * 100,
      /*
       * Storage survives a pause and CU does not. OneLake bytes are still there and still billed
       * when the compute is switched off, so reporting them as unknown would be as wrong as
       * reporting the CU as zero.
       */
      storage: bytes(totalStorage(fixture), fixtureEvidence(now)),
      workspaceCount: fixture.workspaces.length,
      itemCount: fixture.items.length,
      throttle: paused ? throttle : throttleStateFor(fixture, reader, now),
    }
  }

  function cityItem(
    entry: DerivedCapacity,
    item: FixtureCapacity['items'][number],
    now: Date,
  ): CapacityCityItem {
    const paused = isPaused(entry.fixture)
    const evidence = paused ? pausedEvidence(now) : fixtureEvidence(now)
    const rng = mulberry32(stableHash(`counts:${item.itemId}`))
    const archetype = itemArchetype(item.kind)

    const families = operationsFor(item.kind)
    const operationTotal = paused ? 0 : Math.max(1, item.cuSeconds / 45)
    const primaryClass = families[0]?.[1] ?? 'Unknown'
    const counts = paused
      ? emptyCounts()
      : operationCounts(operationTotal, entry.throttle.stage, primaryClass, rng)

    const throttled =
      !paused && entry.throttle.stage !== 'None' && Number(counts.rejected ?? '0') > 0
        ? Math.round(item.cuSeconds / 600)
        : 0

    return {
      itemId: item.itemId,
      workspaceId: item.workspaceId,
      workspaceName:
        entry.fixture.workspaces.find((w) => w.workspaceId === item.workspaceId)?.name ?? '',
      name: item.name,
      kind: item.kind,
      archetype,
      storage: bytes(item.storageBytes, fixtureEvidence(now)),
      cuConsumed: cu(paused ? null : item.cuSeconds, evidence),
      durationSeconds: paused ? null : item.cuSeconds * 0.6,
      operations: counts,
      distinctUsers: paused ? null : (1 + seededIndex(rng, 40)).toString(),
      throttlingMinutes: paused ? null : throttled,
      /*
       * Null for a quarter of items on purpose. The metrics app reports no delta for anything
       * younger than the comparison window, and "no comparable window" has to be distinguishable
       * from "unchanged" — a zero here would draw a flat trend line over an item that has none.
       */
      performanceDeltaPercent: paused || rng() < 0.25 ? null : (rng() - 0.45) * 60,
      layout: { neighborhoodOrdinal: item.neighborhoodOrdinal, itemOrdinal: item.ordinal },
      sizeStatus: item.storageBytes === null ? 'Unknown' : 'Known',
      evidence,
    }
  }

  function operationFamilies(entry: DerivedCapacity, now: Date): OperationFamily[] {
    const paused = isPaused(entry.fixture)
    const evidence = paused ? pausedEvidence(now) : fixtureEvidence(now)
    const families: OperationFamily[] = []

    for (const item of entry.fixture.items) {
      const defined = operationsFor(item.kind)
      const rng = mulberry32(stableHash(`family:${item.itemId}`))
      // Weights are drawn once and normalised, so a family's share is stable across refreshes.
      const weights = defined.map(() => 0.4 + rng())
      const weightTotal = weights.reduce((sum, value) => sum + value, 0)

      defined.forEach(([operationName, operationClass], index) => {
        const share = weights[index] / weightTotal
        const cuSeconds = paused ? 0 : item.cuSeconds * share
        const operationCount = paused ? 0 : Math.max(1, Math.round(cuSeconds / 45))
        const familyRng = mulberry32(stableHash(`fam:${item.itemId}:${operationName}`))
        const counts = paused
          ? emptyCounts()
          : operationCounts(operationCount, entry.throttle.stage, operationClass, familyRng)
        const throttlingSeconds =
          paused || Number(counts.rejected ?? '0') === 0 ? 0 : operationCount * 20

        families.push({
          familyId: `${item.itemId}:${operationName}`,
          operationName,
          itemId: item.itemId,
          itemIds: [item.itemId],
          workspaceId: item.workspaceId,
          operationClass,
          billingType: 'Billable',
          cuSeconds: Math.round(cuSeconds).toString(),
          durationSeconds: cuSeconds * 0.6,
          operationCount: operationCount.toString(),
          throttlingSeconds,
          distinctUsers: paused ? null : (1 + seededIndex(familyRng, 25)).toString(),
          counts,
          recentActivity: {
            windowMinutes: 60,
            windowStart: new Date(now.getTime() - 3600_000).toISOString(),
            windowEnd: now.toISOString(),
            /*
             * A paused capacity retains no coverage, which is what stops its streets being graded
             * as quiet. Nothing was captured; the road is unmeasured, not clear.
             */
            covered: !paused,
            operationCount: paused ? '0' : Math.round(operationCount / 336).toString(),
            cuSeconds: paused ? '0' : Math.round(cuSeconds / 336).toString(),
            throttlingSeconds: paused ? 0 : throttlingSeconds / 336,
          },
          evidence,
        })
      })
    }

    return families
  }

  return {
    kind: 'Fixture',
    capabilities: FIXTURE_CAPABILITIES,

    async readAtlas(signal?: AbortSignal): Promise<AtlasSnapshot> {
      const { tenant: current, now } = tenantNow()
      const capacities = current.capacities.map((capacity) =>
        atlasItem(derived.get(capacity.capacityId)!, now),
      )

      return settle<AtlasSnapshot>(
        {
          schemaVersion: SCHEMA_VERSION,
          snapshotId: `fixture-${now.toISOString()}`,
          tenant: { tenantId: current.tenantId, displayName: current.displayName },
          generatedAt: now.toISOString(),
          capacities,
          links: [],
          collection: {
            source: 'Fixture',
            state: 'Ready',
            collectedAt: now.toISOString(),
            isStale: false,
            capacityCount: capacities.length,
            failureCount: 0,
            durationMilliseconds: latencyMs,
          },
        },
        signal,
      )
    },

    async readCitySummaries(signal?: AbortSignal): Promise<CapacityCitySummarySnapshot> {
      const { tenant: current, now } = tenantNow()
      const capacities: CapacityCitySummary[] = current.capacities.map((capacity) => {
        const paused = isPaused(capacity)
        return {
          capacityId: capacity.capacityId,
          name: capacity.displayName,
          workspaceCount: capacity.workspaces.length.toString(),
          itemCount: capacity.items.length.toString(),
          cuSeconds: paused ? null : Math.round(totalCu(capacity)).toString(),
          storageBytes: Math.round(totalStorage(capacity)).toString(),
          sizeStatus: 'Known',
          evidence: paused ? pausedEvidence(now) : fixtureEvidence(now),
        }
      })

      return settle<CapacityCitySummarySnapshot>(
        { schemaVersion: SCHEMA_VERSION, generatedAt: now.toISOString(), capacities },
        signal,
      )
    },

    async readCityPage(request: CityPageRequest): Promise<CapacityCityPage> {
      const entry = requireCapacity(request.capacityId)
      const { now } = tenantNow()
      const { fixture } = entry

      const ranked = [...fixture.items].sort((left, right) => {
        switch (request.metric) {
          case 'Storage':
            return (right.storageBytes ?? 0) - (left.storageBytes ?? 0)
          case 'Operations':
          case 'Duration':
          case 'Cu':
          default:
            return right.cuSeconds - left.cuSeconds
        }
      })

      const offset = request.pageToken ? Number.parseInt(request.pageToken, 10) || 0 : 0
      const page = ranked.slice(offset, offset + request.pageSize)
      const nextOffset = offset + page.length

      const items = page.map((item) => cityItem(entry, item, now))
      const shownWorkspaceIds = new Set(items.map((item) => item.workspaceId))
      const workspaces: CapacityCityWorkspace[] = fixture.workspaces
        .filter((workspace) => shownWorkspaceIds.has(workspace.workspaceId))
        .map((workspace) => ({
          workspaceId: workspace.workspaceId,
          name: workspace.name,
          neighborhoodOrdinal: workspace.ordinal,
          itemCount: fixture.items
            .filter((item) => item.workspaceId === workspace.workspaceId)
            .length.toString(),
          evidence: fixtureEvidence(now),
        }))

      const shownItemIds = new Set(page.map((item) => item.itemId))
      const allFamilies = operationFamilies(entry, now)
      const shownFamilies = allFamilies.filter((family) => shownItemIds.has(family.itemId))
      const hiddenFamilies = allFamilies.filter((family) => !shownItemIds.has(family.itemId))

      const paused = isPaused(fixture)

      return settle<CapacityCityPage>(
        {
          schemaVersion: SCHEMA_VERSION,
          capacityId: fixture.capacityId,
          capacityName: fixture.displayName,
          metric: request.metric,
          pageSize: request.pageSize,
          nextPageToken: nextOffset < ranked.length ? String(nextOffset) : null,
          totalItems: ranked.length.toString(),
          window: {
            start: fixture.windowStart.toISOString(),
            end: fixture.windowEnd.toISOString(),
          },
          workspaces,
          items,
          topOperationFamilies: shownFamilies,
          /*
           * Totals for the work that did not make the page. Without these a city drawn from the
           * top 50 items silently claims to be the whole capacity.
           */
          otherWorkload: {
            familyCount: hiddenFamilies.length.toString(),
            operationCount: hiddenFamilies
              .reduce((sum, family) => sum + Number(family.operationCount), 0)
              .toString(),
            cuSeconds: Math.round(
              hiddenFamilies.reduce((sum, family) => sum + Number(family.cuSeconds), 0),
            ).toString(),
            durationSeconds: hiddenFamilies.reduce(
              (sum, family) => sum + family.durationSeconds,
              0,
            ),
            evidence: paused ? pausedEvidence(now) : fixtureEvidence(now),
          },
          routes: [],
          throttle: entry.throttle,
          evidence: paused ? pausedEvidence(now) : fixtureEvidence(now),
        },
        request.signal,
      )
    },

    async readTimepoints(request: TimepointRequest): Promise<CapacityTimepoint[]> {
      const entry = requireCapacity(request.capacityId)
      const { fixture, reader } = entry

      // A paused capacity emits nothing at all — not zeroes.
      if (isPaused(fixture)) return settle<CapacityTimepoint[]>([], request.signal)

      const stepMs = TIMEPOINT_SECONDS * 1000
      const startMs = Date.parse(request.start)
      const endMs = Date.parse(request.end)
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return settle<CapacityTimepoint[]>([], request.signal)
      }

      const baseMs = fixture.windowStart.getTime()
      const firstIndex = Math.max(0, Math.ceil((startMs - baseMs) / stepMs))
      /*
       * Clamped to `nowIndex`, not to the series length. The series carries 24 hours past now so
       * the forward-window gauges have something to average, but those timepoints have not
       * happened and must never be handed back as observed telemetry.
       */
      const lastExclusive = Math.min(
        fixture.nowIndex + 1,
        Math.ceil((endMs - baseMs) / stepMs),
      )
      const cuLimit = fixture.capacityUnits * TIMEPOINT_SECONDS

      const out: CapacityTimepoint[] = []
      for (let index = firstIndex; index < lastExclusive; index += 1) {
        const usage = fixture.utilization[index]
        const reading = reader.at(index)
        const rng = mulberry32(stableHash(`tp:${fixture.capacityId}:${index}`))
        // Split the timepoint's load between interactive and background work.
        const interactiveShare = 0.3 + rng() * 0.4

        out.push({
          timepoint: new Date(baseMs + index * stepMs).toISOString(),
          cuLimit,
          interactiveBillablePercent: usage * interactiveShare * 100,
          backgroundBillablePercent: usage * (1 - interactiveShare) * 100,
          interactiveNonBillablePercent: usage * 0.02 * 100,
          backgroundNonBillablePercent: usage * 0.01 * 100,
          interactiveDelayPercent: reading.interactiveDelayPercent,
          interactiveRejectionPercent: reading.interactiveRejectionPercent,
          backgroundRejectionPercent: reading.backgroundRejectionPercent,
          carryOverAddPercent: reading.carryOverAddPercent,
          carryOverBurndownPercent: reading.carryOverBurndownPercent,
          cumulativeCarryOverPercent: reading.cumulativeCarryOverPercent,
          expectedBurndownMinutes: reading.expectedBurndownMinutes,
        })
      }

      return settle(out, request.signal)
    },

    async readOperationSamples(request: OperationSampleRequest): Promise<OperationSample[]> {
      const entry = requireCapacity(request.capacityId)
      const { now } = tenantNow()
      const { fixture } = entry

      if (isPaused(fixture)) return settle<OperationSample[]>([], request.signal)

      const at = request.timepoint ? new Date(Date.parse(request.timepoint)) : fixture.windowEnd
      const bucket = Math.floor(at.getTime() / (TIMEPOINT_SECONDS * 1000))
      const families = operationFamilies(entry, now).filter(
        (family) => Number(family.operationCount) > 0,
      )
      if (families.length === 0) return settle<OperationSample[]>([], request.signal)

      const rng = mulberry32(stableHash(`ops:${fixture.capacityId}:${bucket}`))
      const out: OperationSample[] = []

      for (let index = 0; index < request.limit; index += 1) {
        const family = families[seededIndex(rng, families.length)]
        const durationSeconds = 0.4 + rng() * 90
        const startedAt = new Date(at.getTime() - Math.round(rng() * TIMEPOINT_SECONDS * 1000))
        const rejects = Number(family.counts.rejected ?? '0') > 0
        const draw = rng()
        const status: OperationSample['status'] = rejects && draw < 0.18
          ? 'Rejected'
          : draw < 0.2
            ? 'Failure'
            : draw < 0.24
              ? 'InProgress'
              : 'Success'

        const totalCuSeconds = durationSeconds * (0.5 + rng() * 6)
        /*
         * Interactive work smooths over 5–64 minutes, background over 24 hours. This is the
         * mechanism behind every throttle the city draws, so the sample carries the window rather
         * than only the cost.
         */
        const smoothingMinutes =
          family.operationClass === 'Background' ? 24 * 60 : 5 + rng() * 59
        const ended = status === 'InProgress' ? null : new Date(startedAt.getTime() + durationSeconds * 1000)

        out.push({
          operationId: `${family.familyId}:${bucket}:${index}`,
          operationName: family.operationName,
          itemId: family.itemId,
          workspaceId: family.workspaceId,
          operationClass: family.operationClass,
          billingType: family.billingType,
          status,
          startedAt: startedAt.toISOString(),
          endedAt: ended ? ended.toISOString() : null,
          durationSeconds: status === 'InProgress' ? null : durationSeconds,
          totalCuSeconds,
          timepointCuSeconds: totalCuSeconds / ((smoothingMinutes * 60) / TIMEPOINT_SECONDS),
          throttlingSeconds: status === 'Rejected' ? 20 : 0,
          smoothingStart: startedAt.toISOString(),
          smoothingEnd: new Date(startedAt.getTime() + smoothingMinutes * 60_000).toISOString(),
          user: `user${seededIndex(rng, 40) + 1}@contoso.com`,
        })
      }

      return settle(out, request.signal)
    },
  }
}
