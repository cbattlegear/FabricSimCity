import { SKU_CAPACITY_UNITS, type AtlasSnapshot, type CapacityAtlasItem, type CapacityState, type CapacityStateReason, type Evidence, type FabricSku, type ThrottleState } from '../fabricContracts'
import { itemArchetype, normalizeItemKind } from '../itemKind'
import { getRayfinClient } from '../services/rayfinClient'
import type {
  CapacityCityItem,
  CapacityCityPage,
  CapacityCitySummary,
  CapacityCitySummarySnapshot,
  CapacityCityWorkspace,
  ItemOperationCounts,
} from '../capacityCityContracts'
import {
  CapacitySourceError,
  type CapacitySource,
  type CapacitySourceCapabilities,
  type CapacitySourceKind,
  type CityPageRequest,
  type OperationSampleRequest,
  type SourceFailureKind,
  type TimepointRequest,
} from './source'

export interface FabricTopologyCapacity {
  capacityId: string
  displayName: string
  sku: string | null
  region: string | null
  state: string | null
  stateReason: string | null
}

export interface FabricTopologyWorkspace {
  workspaceId: string
  capacityId: string | null
  name: string
}

export interface FabricTopologyItem {
  itemId: string
  workspaceId: string
  capacityId: string | null
  name: string
  itemType: string | null
}

export interface FabricTopologyFailure {
  scope: 'Capacities' | 'Workspaces' | 'WorkspaceItems'
  endpoint: string
  status: number | null
  failure: SourceFailureKind
  message: string
  capacityId?: string | null
  workspaceId?: string
}

export interface FabricTopologySnapshot {
  schemaVersion: '1.0'
  generatedAt: string
  capacities: FabricTopologyCapacity[]
  workspaces: FabricTopologyWorkspace[]
  items: FabricTopologyItem[]
  failures: FabricTopologyFailure[]
  partial: boolean
}

export type ReadFabricTopology = (signal?: AbortSignal) => Promise<FabricTopologySnapshot>

const SCHEMA_VERSION = '1.0'
const TOPOLOGY_SOURCE_KIND: CapacitySourceKind = 'Eventhouse'

const TOPOLOGY_CAPABILITIES: CapacitySourceCapabilities = Object.freeze({
  perItemBreakdown: false,
  operationFamilies: false,
  operationSamples: false,
  timepoints: false,
  latencySeconds: 0,
  retentionDays: 0,
})

const KNOWN_SKUS = new Set<string>(Object.keys(SKU_CAPACITY_UNITS))

function topologyEvidence(observedAt: string, status: Evidence['status'] = 'Available'): Evidence {
  return {
    source: 'FabricRest',
    status,
    observedAt,
    freshUntil: status === 'Available'
      ? new Date(Date.parse(observedAt) + 5 * 60_000).toISOString()
      : null,
  }
}

function unmeasuredEvidence(observedAt: string): Evidence {
  return topologyEvidence(observedAt, 'Unsupported')
}

function emptyCounts(): ItemOperationCounts {
  return { total: null, successful: null, rejected: null, failed: null, invalid: null, cancelled: null }
}

function normalizeSku(raw: string | null): FabricSku | null {
  return raw && KNOWN_SKUS.has(raw) ? raw as FabricSku : null
}

function normalizeCapacityState(raw: string | null): CapacityState {
  switch (raw) {
    case 'Active':
    case 'Overloaded':
    case 'Suspended':
    case 'Deleted':
      return raw
    default:
      return 'Unknown'
  }
}

function normalizeCapacityStateReason(raw: string | null): CapacityStateReason {
  switch (raw) {
    case 'Created':
    case 'ManuallyResumed':
    case 'NotOverloaded':
    case 'AllRejected':
    case 'InteractiveDelay':
    case 'InteractiveRejected':
    case 'SurgeProtectionActive':
    case 'InteractiveDelayAndSurgeProtectionActive':
    case 'InteractiveRejectedAndSurgeProtectionActive':
    case 'ManuallyPaused':
    case 'Deleted':
      return raw
    default:
      return 'Unknown'
  }
}

function unmeasuredThrottle(observedAt: string): ThrottleState {
  return {
    stage: 'None',
    interactiveDelayPercent: null,
    interactiveRejectionPercent: null,
    backgroundRejectionPercent: null,
    cumulativeCarryOverPercent: null,
    expectedBurndownMinutes: null,
    surgeProtectionActive: false,
    evidence: unmeasuredEvidence(observedAt),
  }
}

function capacityFailureIds(topology: FabricTopologySnapshot): Set<string> {
  const ids = new Set<string>()
  for (const failure of topology.failures) {
    if (failure.capacityId) ids.add(failure.capacityId)
  }
  return ids
}

function capacityEvidence(topology: FabricTopologySnapshot, capacityId: string): Evidence {
  return capacityFailureIds(topology).has(capacityId)
    ? topologyEvidence(topology.generatedAt, 'PermissionDenied')
    : topologyEvidence(topology.generatedAt)
}

function workspacesFor(topology: FabricTopologySnapshot, capacityId: string): FabricTopologyWorkspace[] {
  return topology.workspaces.filter((workspace) => workspace.capacityId === capacityId)
}

function itemsFor(topology: FabricTopologySnapshot, capacityId: string): FabricTopologyItem[] {
  return topology.items.filter((item) => item.capacityId === capacityId)
}

function atlasItem(topology: FabricTopologySnapshot, capacity: FabricTopologyCapacity): CapacityAtlasItem {
  const sku = normalizeSku(capacity.sku)
  const failures = capacityFailureIds(topology)
  const itemCount = failures.has(capacity.capacityId) ? null : itemsFor(topology, capacity.capacityId).length
  const telemetryEvidence = unmeasuredEvidence(topology.generatedAt)

  return {
    capacityId: capacity.capacityId,
    displayName: capacity.displayName,
    sku,
    capacityUnits: sku ? SKU_CAPACITY_UNITS[sku] : null,
    region: capacity.region,
    state: normalizeCapacityState(capacity.state),
    stateReason: normalizeCapacityStateReason(capacity.stateReason),
    cuConsumed: { cuSeconds: null, status: 'Unknown', evidence: telemetryEvidence },
    meanUtilizationPercent: null,
    peakUtilizationPercent: null,
    storage: { bytes: null, status: 'Unknown', evidence: telemetryEvidence },
    workspaceCount: workspacesFor(topology, capacity.capacityId).length,
    itemCount,
    throttle: unmeasuredThrottle(topology.generatedAt),
  }
}

function workspaceOrdinal(topology: FabricTopologySnapshot, workspaceId: string): number {
  const index = topology.workspaces.findIndex((workspace) => workspace.workspaceId === workspaceId)
  return index < 0 ? 0 : index
}

function cityItem(
  topology: FabricTopologySnapshot,
  item: FabricTopologyItem,
  ordinal: number,
): CapacityCityItem {
  const kind = normalizeItemKind(item.itemType)
  const archetype = itemArchetype(kind)
  const workspace = topology.workspaces.find((entry) => entry.workspaceId === item.workspaceId)
  const telemetryEvidence = unmeasuredEvidence(topology.generatedAt)

  return {
    itemId: item.itemId,
    workspaceId: item.workspaceId,
    workspaceName: workspace?.name ?? '',
    name: item.name,
    kind,
    archetype,
    storage: { bytes: null, status: 'Unknown', evidence: telemetryEvidence },
    cuConsumed: { cuSeconds: null, status: 'Unknown', evidence: telemetryEvidence },
    durationSeconds: null,
    operations: emptyCounts(),
    distinctUsers: null,
    throttlingMinutes: null,
    performanceDeltaPercent: null,
    layout: { neighborhoodOrdinal: workspaceOrdinal(topology, item.workspaceId), itemOrdinal: ordinal },
    sizeStatus: 'Unknown',
    evidence: topologyEvidence(topology.generatedAt),
  }
}

function summary(topology: FabricTopologySnapshot, capacity: FabricTopologyCapacity): CapacityCitySummary {
  const failureIds = capacityFailureIds(topology)
  return {
    capacityId: capacity.capacityId,
    name: capacity.displayName,
    workspaceCount: workspacesFor(topology, capacity.capacityId).length.toString(),
    itemCount: failureIds.has(capacity.capacityId)
      ? null
      : itemsFor(topology, capacity.capacityId).length.toString(),
    cuSeconds: null,
    storageBytes: null,
    sizeStatus: 'Unknown',
    evidence: failureIds.has(capacity.capacityId)
      ? topologyEvidence(topology.generatedAt, 'PermissionDenied')
      : topologyEvidence(topology.generatedAt),
  }
}

export function failureFromUnknown(error: unknown): SourceFailureKind {
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : Number.NaN
  if (status === 401) return 'Unauthenticated'
  if (status === 403) return 'PermissionDenied'
  if (status === 404) return 'NotConfigured'
  if (status === 400 || status === 405 || status === 410) return 'Unsupported'
  if (status === 0 || status === 408 || status === 429 || status >= 500) return 'Network'

  const message = error instanceof Error ? error.message : String(error)
  if (/\b401\b|unauth/i.test(message)) return 'Unauthenticated'
  if (/\b403\b|permission|forbidden/i.test(message)) return 'PermissionDenied'
  if (/network|fetch|timeout|abort/i.test(message)) return 'Network'
  return 'Unknown'
}

async function invokeFabricTopology(signal?: AbortSignal): Promise<FabricTopologySnapshot> {
  signal?.throwIfAborted()
  try {
    const topology = await getRayfinClient().functions.readFabricTopology.invoke()
    signal?.throwIfAborted()
    return topology as FabricTopologySnapshot
  } catch (error) {
    throw new CapacitySourceError(
      TOPOLOGY_SOURCE_KIND,
      failureFromUnknown(error),
      error instanceof Error ? error.message : 'Fabric topology function failed',
    )
  }
}

export interface TopologySourceOptions {
  readTopology?: ReadFabricTopology
}

export function createTopologySource(options: TopologySourceOptions = {}): CapacitySource {
  const readTopology = options.readTopology ?? invokeFabricTopology

  async function load(signal?: AbortSignal): Promise<FabricTopologySnapshot> {
    try {
      signal?.throwIfAborted()
      const topology = await readTopology(signal)
      signal?.throwIfAborted()
      return topology
    } catch (error) {
      if (error instanceof CapacitySourceError) throw error
      throw new CapacitySourceError(
        TOPOLOGY_SOURCE_KIND,
        failureFromUnknown(error),
        error instanceof Error ? error.message : 'Fabric topology source failed',
      )
    }
  }

  return {
    kind: TOPOLOGY_SOURCE_KIND,
    capabilities: TOPOLOGY_CAPABILITIES,

    async readAtlas(signal?: AbortSignal): Promise<AtlasSnapshot> {
      const topology = await load(signal)
      return {
        schemaVersion: SCHEMA_VERSION,
        snapshotId: `fabric-rest-${topology.generatedAt}`,
        tenant: { tenantId: 'current', displayName: 'Current Fabric tenant' },
        generatedAt: topology.generatedAt,
        capacities: topology.capacities.map((capacity) => atlasItem(topology, capacity)),
        links: [],
        collection: {
          source: 'FabricRest',
          state: topology.partial ? 'Degraded' : 'Ready',
          collectedAt: topology.generatedAt,
          isStale: false,
          capacityCount: topology.capacities.length,
          failureCount: topology.failures.length,
          durationMilliseconds: 0,
        },
      }
    },

    async readCitySummaries(signal?: AbortSignal): Promise<CapacityCitySummarySnapshot> {
      const topology = await load(signal)
      return {
        schemaVersion: SCHEMA_VERSION,
        generatedAt: topology.generatedAt,
        capacities: topology.capacities.map((capacity) => summary(topology, capacity)),
      }
    },

    async readCityPage(request: CityPageRequest): Promise<CapacityCityPage> {
      const topology = await load(request.signal)
      const capacity = topology.capacities.find((entry) => entry.capacityId === request.capacityId)
      if (!capacity) throw new CapacitySourceError(TOPOLOGY_SOURCE_KIND, 'NotConfigured', `Unknown capacity: ${request.capacityId}`)

      const ranked = itemsFor(topology, request.capacityId)
      const offset = request.pageToken ? Number.parseInt(request.pageToken, 10) || 0 : 0
      const page = ranked.slice(offset, offset + request.pageSize)
      const nextOffset = offset + page.length
      const pageItems = page.map((item, index) => cityItem(topology, item, offset + index))
      const workspaceIds = new Set(pageItems.map((item) => item.workspaceId))
      const workspaces: CapacityCityWorkspace[] = workspacesFor(topology, request.capacityId)
        .filter((workspace) => workspaceIds.has(workspace.workspaceId))
        .map((workspace) => ({
          workspaceId: workspace.workspaceId,
          name: workspace.name,
          neighborhoodOrdinal: workspaceOrdinal(topology, workspace.workspaceId),
          itemCount: topology.failures.some((failure) => failure.workspaceId === workspace.workspaceId)
            ? null
            : topology.items.filter((item) => item.workspaceId === workspace.workspaceId).length.toString(),
          evidence: topology.failures.some((failure) => failure.workspaceId === workspace.workspaceId)
            ? topologyEvidence(topology.generatedAt, 'PermissionDenied')
            : topologyEvidence(topology.generatedAt),
        }))

      return {
        schemaVersion: SCHEMA_VERSION,
        capacityId: capacity.capacityId,
        capacityName: capacity.displayName,
        metric: request.metric,
        pageSize: request.pageSize,
        nextPageToken: nextOffset < ranked.length ? String(nextOffset) : null,
        totalItems: capacityFailureIds(topology).has(capacity.capacityId) ? null : ranked.length.toString(),
        window: { start: topology.generatedAt, end: topology.generatedAt },
        workspaces,
        items: pageItems,
        topOperationFamilies: [],
        otherWorkload: {
          familyCount: null,
          operationCount: null,
          cuSeconds: null,
          durationSeconds: null,
          evidence: unmeasuredEvidence(topology.generatedAt),
        },
        routes: [],
        throttle: unmeasuredThrottle(topology.generatedAt),
        evidence: capacityEvidence(topology, capacity.capacityId),
      }
    },

    async readTimepoints(request: TimepointRequest) {
      request.signal?.throwIfAborted()
      return []
    },

    async readOperationSamples(request: OperationSampleRequest) {
      request.signal?.throwIfAborted()
      return []
    },
  }
}
