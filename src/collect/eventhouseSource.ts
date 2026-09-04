import { itemArchetype, normalizeItemKind } from '../itemKind'
import { SKU_CAPACITY_UNITS, TIMEPOINT_SECONDS } from '../fabricContracts'
import type {
  AtlasSnapshot,
  ByteMeasurement,
  CapacityAtlasItem,
  CapacityCollectionStatus,
  CapacityState,
  CapacityStateReason,
  CuMeasurement,
  Evidence,
  FabricSku,
  ThrottleStage,
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
  OperationSample,
} from '../capacityCityContracts'
import {
  buildEventhouseQueries,
  type EventhouseQueries,
  type EventhouseQueryOptions,
} from './eventhouseQueries'
import {
  CapacitySourceError,
  CITY_PAGE_SIZE,
  type CapacitySource,
  type CapacitySourceCapabilities,
  type CityPageRequest,
  type OperationSampleRequest,
  type SourceFailureKind,
  type TimepointRequest,
} from './source'

const SCHEMA_VERSION = '1.0'
const EVENTHOUSE_LATENCY_SECONDS = 30
const EVENTHOUSE_RETENTION_DAYS = 14

/*
 * Real-Time Hub emits Fabric capacity telemetry on the 30-second cadence used by throttling. The
 * source is therefore one timepoint behind live rather than the semantic model's 10-15 minutes.
 * Fabric capacity metrics are documented as a 14-day operational history; the Eventhouse table can
 * be configured differently, but this source declares the history the Fabric telemetry promises.
 */
export const EVENTHOUSE_CAPABILITIES: CapacitySourceCapabilities = Object.freeze({
  perItemBreakdown: false,
  operationFamilies: false,
  operationSamples: false,
  timepoints: true,
  latencySeconds: EVENTHOUSE_LATENCY_SECONDS,
  retentionDays: EVENTHOUSE_RETENTION_DAYS,
})

export type EventhouseQueryName = 'capacitySummary' | 'timepoints' | 'cityTopology'

export type EventhouseKqlParameter = string | number | boolean | null

export interface EventhouseKqlRequest {
  queryName: EventhouseQueryName
  query: string
  parameters: Readonly<Record<string, EventhouseKqlParameter>>
  signal?: AbortSignal
}

export type EventhouseRow = Record<string, unknown>

export interface EventhouseKqlClient {
  execute<T extends EventhouseRow = EventhouseRow>(request: EventhouseKqlRequest): Promise<readonly T[]>
}

export interface EventhouseSourceOptions extends EventhouseQueryOptions {
  client: EventhouseKqlClient
  tenant: { tenantId: string; displayName: string }
  now?: () => Date
}

interface CapacitySummaryRow extends EventhouseRow {
  CapacityId?: unknown
  CapacityName?: unknown
  Sku?: unknown
  CapacityUnits?: unknown
  Region?: unknown
  CapacityState?: unknown
  StateReason?: unknown
  ObservedAt?: unknown
  WindowStart?: unknown
  WindowEnd?: unknown
  TotalCuSeconds?: unknown
  MeanUtilizationPercent?: unknown
  PeakUtilizationPercent?: unknown
  InteractiveDelayPercent?: unknown
  InteractiveRejectionPercent?: unknown
  BackgroundRejectionPercent?: unknown
  CumulativeCarryOverPercent?: unknown
  ExpectedBurndownMinutes?: unknown
  SurgeProtectionActive?: unknown
  ThrottleStage?: unknown
}

interface TopologyRow extends EventhouseRow {
  ObservedAt?: unknown
  WorkspaceId?: unknown
  WorkspaceName?: unknown
  ItemId?: unknown
  ItemName?: unknown
  ItemType?: unknown
}

interface ParsedCapacity {
  capacityId: string
  displayName: string
  sku: FabricSku | null
  capacityUnits: number | null
  region: string | null
  state: CapacityState
  stateReason: CapacityStateReason
  observedAt: string | null
  windowStart: string | null
  windowEnd: string | null
  totalCuSeconds: string | null
  meanUtilizationPercent: number | null
  peakUtilizationPercent: number | null
  throttle: ThrottleState
}

export function createEventhouseSource(options: EventhouseSourceOptions): CapacitySource {
  const clock = options.now ?? (() => new Date())
  let queries: EventhouseQueries | null = null

  function requireQueries(): EventhouseQueries {
    if (!queries) {
      try {
        queries = buildEventhouseQueries(options)
      } catch (error) {
        throw new CapacitySourceError('Eventhouse', 'NotConfigured', messageFrom(error))
      }
    }
    return queries
  }

  async function execute<T extends EventhouseRow>(
    queryName: EventhouseQueryName,
    query: string,
    parameters: Readonly<Record<string, EventhouseKqlParameter>>,
    signal?: AbortSignal,
  ): Promise<readonly T[]> {
    try {
      signal?.throwIfAborted()
      return await options.client.execute<T>({ queryName, query, parameters, signal })
    } catch (error) {
      if (isAbortError(error)) throw error
      throw sourceError(error)
    }
  }

  function queryWindow(now: Date): { start: string; end: string } {
    const end = new Date(now.getTime() - EVENTHOUSE_LATENCY_SECONDS * 1000)
    const start = new Date(end.getTime() - EVENTHOUSE_RETENTION_DAYS * 86_400_000)
    return { start: start.toISOString(), end: end.toISOString() }
  }

  async function readCapacitySummaries(signal?: AbortSignal): Promise<ParsedCapacity[]> {
    const now = clock()
    const window = queryWindow(now)
    const rows = await execute<CapacitySummaryRow>(
      'capacitySummary',
      requireQueries().capacitySummary,
      { _start: window.start, _end: window.end },
      signal,
    )
    return rows.map(parseCapacity).sort((left, right) =>
      left.displayName.localeCompare(right.displayName) || left.capacityId.localeCompare(right.capacityId),
    )
  }

  return {
    kind: 'Eventhouse',
    capabilities: EVENTHOUSE_CAPABILITIES,

    async readAtlas(signal?: AbortSignal): Promise<AtlasSnapshot> {
      const started = Date.now()
      const now = clock()
      const capacities = (await readCapacitySummaries(signal)).map(atlasItem)

      return {
        schemaVersion: SCHEMA_VERSION,
        snapshotId: `eventhouse-${now.toISOString()}`,
        tenant: options.tenant,
        generatedAt: now.toISOString(),
        capacities,
        links: [],
        collection: collectionStatus(capacities, now, started),
      }
    },

    async readCitySummaries(signal?: AbortSignal): Promise<CapacityCitySummarySnapshot> {
      const now = clock()
      const capacities = (await readCapacitySummaries(signal)).map(citySummary)
      return { schemaVersion: SCHEMA_VERSION, generatedAt: now.toISOString(), capacities }
    },

    async readCityPage(request: CityPageRequest): Promise<CapacityCityPage> {
      request.signal?.throwIfAborted()
      const now = clock()
      const querySet = requireQueries()
      const capacity = (await readCapacitySummaries(request.signal)).find(
        (entry) => entry.capacityId === request.capacityId,
      )
      const window = {
        start: capacity?.windowStart ?? queryWindow(now).start,
        end: capacity?.windowEnd ?? queryWindow(now).end,
      }
      const throttle = capacity?.throttle ?? unknownThrottle(null)
      const pageSize = normalizedPageSize(request.pageSize)
      const offset = pageOffset(request.pageToken)

      if (!querySet.cityTopology) {
        return emptyCityPage(request, pageSize, capacity, window, throttle)
      }

      const topology = await execute<TopologyRow>(
        'cityTopology',
        querySet.cityTopology,
        { _capacityId: request.capacityId },
        request.signal,
      )
      const sorted = [...topology].sort(compareTopologyRows)
      const pageRows = sorted.slice(offset, offset + pageSize)
      const workspaceOrdinals = workspaceOrdinalMap(sorted)
      const workspaceCounts = workspaceItemCounts(sorted)
      const items = pageRows.map((row, index) =>
        cityItem(row, index + offset, workspaceOrdinals, capacity?.observedAt ?? null),
      )
      const workspaces = cityWorkspaces(pageRows, workspaceOrdinals, workspaceCounts)
      const nextOffset = offset + pageRows.length

      return {
        schemaVersion: SCHEMA_VERSION,
        capacityId: request.capacityId,
        capacityName: capacity?.displayName ?? request.capacityId,
        metric: request.metric,
        pageSize,
        nextPageToken: nextOffset < sorted.length ? String(nextOffset) : null,
        totalItems: String(sorted.length),
        window,
        workspaces,
        items,
        topOperationFamilies: [],
        otherWorkload: unmeasuredWorkload(capacity?.observedAt ?? null),
        routes: [],
        throttle,
        evidence: capacity?.throttle.evidence ?? unsupportedEvidence(null),
      }
    },

    async readTimepoints(request: TimepointRequest): Promise<CapacityTimepoint[]> {
      const rows = await execute<EventhouseRow>(
        'timepoints',
        requireQueries().timepoints,
        { _capacityId: request.capacityId, _start: request.start, _end: request.end },
        request.signal,
      )
      return rows.map(parseTimepoint).sort((left, right) =>
        Date.parse(left.timepoint) - Date.parse(right.timepoint),
      )
    },

    async readOperationSamples(_request: OperationSampleRequest): Promise<OperationSample[]> {
      return []
    },
  }
}

function atlasItem(capacity: ParsedCapacity): CapacityAtlasItem {
  const evidence = capacityEvidence(capacity.observedAt)
  return {
    capacityId: capacity.capacityId,
    displayName: capacity.displayName,
    sku: capacity.sku,
    capacityUnits: capacity.capacityUnits,
    region: capacity.region,
    state: capacity.state,
    stateReason: capacity.stateReason,
    cuConsumed: cu(capacity.totalCuSeconds, evidence),
    meanUtilizationPercent: capacity.meanUtilizationPercent,
    peakUtilizationPercent: capacity.peakUtilizationPercent,
    storage: unknownBytes(unsupportedEvidence(capacity.observedAt)),
    workspaceCount: null,
    itemCount: null,
    throttle: capacity.throttle,
  }
}

function citySummary(capacity: ParsedCapacity): CapacityCitySummary {
  const evidence = capacityEvidence(capacity.observedAt)
  return {
    capacityId: capacity.capacityId,
    name: capacity.displayName,
    workspaceCount: null,
    itemCount: null,
    cuSeconds: capacity.totalCuSeconds,
    storageBytes: null,
    sizeStatus: capacity.totalCuSeconds === null ? 'Unknown' : 'Known',
    evidence,
  }
}

function parseCapacity(row: CapacitySummaryRow): ParsedCapacity {
  const capacityId = requiredString(row, 'CapacityId')
  const observedAt = isoOrNull(row.ObservedAt)
  const capacityUnits = capacityUnitsFor(row)
  const stateReason = capacityStateReason(stringOrNull(row.StateReason))
  const throttle = throttleState(row, observedAt)

  return {
    capacityId,
    displayName: stringOrNull(row.CapacityName) ?? capacityId,
    sku: fabricSku(stringOrNull(row.Sku)),
    capacityUnits,
    region: stringOrNull(row.Region),
    state: capacityState(stringOrNull(row.CapacityState), stateReason, throttle.stage),
    stateReason,
    observedAt,
    windowStart: isoOrNull(row.WindowStart),
    windowEnd: isoOrNull(row.WindowEnd),
    totalCuSeconds: decimalStringOrNull(row.TotalCuSeconds),
    meanUtilizationPercent: numberOrNull(row.MeanUtilizationPercent),
    peakUtilizationPercent: numberOrNull(row.PeakUtilizationPercent),
    throttle,
  }
}

function parseTimepoint(row: EventhouseRow): CapacityTimepoint {
  const sku = fabricSku(stringOrNull(row.Sku))
  const capacityUnits = numberOrNull(row.CapacityUnits) ?? (sku ? SKU_CAPACITY_UNITS[sku] : null)
  return {
    timepoint: requiredIso(row.Timepoint, 'Timepoint'),
    cuLimit: capacityUnits === null ? null : capacityUnits * TIMEPOINT_SECONDS,
    interactiveBillablePercent: numberOrNull(row.InteractiveBillablePercent),
    backgroundBillablePercent: numberOrNull(row.BackgroundBillablePercent),
    interactiveNonBillablePercent: numberOrNull(row.InteractiveNonBillablePercent),
    backgroundNonBillablePercent: numberOrNull(row.BackgroundNonBillablePercent),
    interactiveDelayPercent: numberOrNull(row.InteractiveDelayPercent),
    interactiveRejectionPercent: numberOrNull(row.InteractiveRejectionPercent),
    backgroundRejectionPercent: numberOrNull(row.BackgroundRejectionPercent),
    carryOverAddPercent: numberOrNull(row.CarryOverAddPercent),
    carryOverBurndownPercent: numberOrNull(row.CarryOverBurndownPercent),
    cumulativeCarryOverPercent: numberOrNull(row.CumulativeCarryOverPercent),
    expectedBurndownMinutes: numberOrNull(row.ExpectedBurndownMinutes),
  }
}

function throttleState(row: CapacitySummaryRow, observedAt: string | null): ThrottleState {
  const interactiveDelayPercent = numberOrNull(row.InteractiveDelayPercent)
  const interactiveRejectionPercent = numberOrNull(row.InteractiveRejectionPercent)
  const backgroundRejectionPercent = numberOrNull(row.BackgroundRejectionPercent)
  const stage = throttleStage(
    stringOrNull(row.ThrottleStage),
    interactiveDelayPercent,
    interactiveRejectionPercent,
    backgroundRejectionPercent,
  )
  const surgeProtectionActive = booleanOrFalse(row.SurgeProtectionActive)

  return {
    stage,
    interactiveDelayPercent,
    interactiveRejectionPercent,
    backgroundRejectionPercent,
    cumulativeCarryOverPercent: numberOrNull(row.CumulativeCarryOverPercent),
    expectedBurndownMinutes: numberOrNull(row.ExpectedBurndownMinutes),
    surgeProtectionActive,
    evidence: capacityEvidence(observedAt),
  }
}

function unknownThrottle(observedAt: string | null): ThrottleState {
  return {
    stage: 'None',
    interactiveDelayPercent: null,
    interactiveRejectionPercent: null,
    backgroundRejectionPercent: null,
    cumulativeCarryOverPercent: null,
    expectedBurndownMinutes: null,
    surgeProtectionActive: false,
    evidence: unsupportedEvidence(observedAt),
  }
}

function throttleStage(
  raw: string | null,
  interactiveDelay: number | null,
  interactiveRejection: number | null,
  backgroundRejection: number | null,
): ThrottleStage {
  const normalized = normalizeToken(raw)
  if (normalized === 'backgroundrejection' || normalized === 'backgroundrejected' || normalized === 'allrejected') {
    return 'BackgroundRejection'
  }
  if (normalized === 'interactiverejection' || normalized === 'interactiverejected') {
    return 'InteractiveRejection'
  }
  if (normalized === 'interactivedelay') return 'InteractiveDelay'
  if (normalized === 'none' || normalized === 'notthrottled' || normalized === 'notoverloaded') return 'None'
  if ((backgroundRejection ?? 0) > 100) return 'BackgroundRejection'
  if ((interactiveRejection ?? 0) > 100) return 'InteractiveRejection'
  if ((interactiveDelay ?? 0) > 100) return 'InteractiveDelay'
  return 'None'
}

function capacityState(
  raw: string | null,
  reason: CapacityStateReason,
  stage: ThrottleStage,
): CapacityState {
  const normalized = normalizeToken(raw)
  if (normalized === 'active') return 'Active'
  if (normalized === 'overloaded') return 'Overloaded'
  if (normalized === 'suspended' || normalized === 'paused') return 'Suspended'
  if (normalized === 'deleted') return 'Deleted'
  if (reason === 'Deleted') return 'Deleted'
  if (reason === 'ManuallyPaused') return 'Suspended'
  if (stage !== 'None') return 'Overloaded'
  return 'Active'
}

function capacityStateReason(raw: string | null): CapacityStateReason {
  const normalized = normalizeToken(raw)
  switch (normalized) {
    case 'created':
      return 'Created'
    case 'manuallyresumed':
      return 'ManuallyResumed'
    case 'notoverloaded':
      return 'NotOverloaded'
    case 'allrejected':
    case 'backgroundrejection':
    case 'backgroundrejected':
      return 'AllRejected'
    case 'interactivedelay':
      return 'InteractiveDelay'
    case 'interactiverejected':
    case 'interactiverejection':
      return 'InteractiveRejected'
    case 'surgeprotectionactive':
      return 'SurgeProtectionActive'
    case 'interactivedelayandsurgeprotectionactive':
      return 'InteractiveDelayAndSurgeProtectionActive'
    case 'interactiverejectedandsurgeprotectionactive':
    case 'interactiverejectionandsurgeprotectionactive':
      return 'InteractiveRejectedAndSurgeProtectionActive'
    case 'manuallypaused':
    case 'paused':
      return 'ManuallyPaused'
    case 'deleted':
      return 'Deleted'
    default:
      return 'Unknown'
  }
}

function cityItem(
  row: TopologyRow,
  itemOrdinal: number,
  workspaceOrdinals: ReadonlyMap<string, number>,
  observedAt: string | null,
): CapacityCityItem {
  const workspaceId = requiredString(row, 'WorkspaceId')
  const itemId = requiredString(row, 'ItemId')
  const kind: FabricItemKind = normalizeItemKind(stringOrNull(row.ItemType))
  const evidence = unsupportedEvidence(observedAt)

  return {
    itemId,
    workspaceId,
    workspaceName: stringOrNull(row.WorkspaceName) ?? workspaceId,
    name: stringOrNull(row.ItemName) ?? itemId,
    kind,
    archetype: itemArchetype(kind),
    storage: unknownBytes(evidence),
    cuConsumed: unknownCu(evidence),
    durationSeconds: null,
    operations: emptyCounts(),
    distinctUsers: null,
    throttlingMinutes: null,
    performanceDeltaPercent: null,
    layout: { neighborhoodOrdinal: workspaceOrdinals.get(workspaceId) ?? 0, itemOrdinal },
    sizeStatus: 'Unknown',
    evidence,
  }
}

function cityWorkspaces(
  rows: readonly TopologyRow[],
  workspaceOrdinals: ReadonlyMap<string, number>,
  workspaceCounts: ReadonlyMap<string, number>,
): CapacityCityWorkspace[] {
  const seen = new Set<string>()
  const workspaces: CapacityCityWorkspace[] = []
  for (const row of rows) {
    const workspaceId = requiredString(row, 'WorkspaceId')
    if (seen.has(workspaceId)) continue
    seen.add(workspaceId)
    workspaces.push({
      workspaceId,
      name: stringOrNull(row.WorkspaceName) ?? workspaceId,
      neighborhoodOrdinal: workspaceOrdinals.get(workspaceId) ?? 0,
      itemCount: String(workspaceCounts.get(workspaceId) ?? 0),
      evidence: topologyEvidence(isoOrNull(row.ObservedAt)),
    })
  }
  return workspaces
}

function emptyCityPage(
  request: CityPageRequest,
  pageSize: number,
  capacity: ParsedCapacity | undefined,
  window: { start: string; end: string },
  throttle: ThrottleState,
): CapacityCityPage {
  return {
    schemaVersion: SCHEMA_VERSION,
    capacityId: request.capacityId,
    capacityName: capacity?.displayName ?? request.capacityId,
    metric: request.metric,
    pageSize,
    nextPageToken: null,
    totalItems: '0',
    window,
    workspaces: [],
    items: [],
    topOperationFamilies: [],
    otherWorkload: unmeasuredWorkload(capacity?.observedAt ?? null),
    routes: [],
    throttle,
    evidence: capacity?.throttle.evidence ?? unsupportedEvidence(null),
  }
}

function unmeasuredWorkload(observedAt: string | null): CapacityCityPage['otherWorkload'] {
  return {
    familyCount: null,
    operationCount: null,
    cuSeconds: null,
    durationSeconds: null,
    evidence: unsupportedEvidence(observedAt),
  }
}

function emptyCounts(): ItemOperationCounts {
  return { total: null, successful: null, rejected: null, failed: null, invalid: null, cancelled: null }
}

function workspaceOrdinalMap(rows: readonly TopologyRow[]): Map<string, number> {
  const names = Array.from(
    new Set(rows.map((row) => requiredString(row, 'WorkspaceId'))),
  ).sort((left, right) => {
    const leftName = stringOrNull(rows.find((row) => stringOrNull(row.WorkspaceId) === left)?.WorkspaceName) ?? left
    const rightName = stringOrNull(rows.find((row) => stringOrNull(row.WorkspaceId) === right)?.WorkspaceName) ?? right
    return leftName.localeCompare(rightName) || left.localeCompare(right)
  })
  return new Map(names.map((workspaceId, index) => [workspaceId, index]))
}

function workspaceItemCounts(rows: readonly TopologyRow[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const workspaceId = requiredString(row, 'WorkspaceId')
    counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1)
  }
  return counts
}

function compareTopologyRows(left: TopologyRow, right: TopologyRow): number {
  const leftWorkspace = stringOrNull(left.WorkspaceName) ?? requiredString(left, 'WorkspaceId')
  const rightWorkspace = stringOrNull(right.WorkspaceName) ?? requiredString(right, 'WorkspaceId')
  const leftItem = stringOrNull(left.ItemName) ?? requiredString(left, 'ItemId')
  const rightItem = stringOrNull(right.ItemName) ?? requiredString(right, 'ItemId')
  return (
    leftWorkspace.localeCompare(rightWorkspace) ||
    leftItem.localeCompare(rightItem) ||
    requiredString(left, 'ItemId').localeCompare(requiredString(right, 'ItemId'))
  )
}

function collectionStatus(
  capacities: readonly CapacityAtlasItem[],
  now: Date,
  started: number,
): CapacityCollectionStatus {
  const latestFreshUntil = capacities
    .map((capacity) => capacity.throttle.evidence.freshUntil)
    .filter((value): value is string => value !== null)
    .map(Date.parse)
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0]
  const stale = latestFreshUntil === undefined ? false : latestFreshUntil < now.getTime()

  return {
    source: 'CapacityEvent',
    state: 'Ready',
    collectedAt: now.toISOString(),
    isStale: stale,
    capacityCount: capacities.length,
    failureCount: 0,
    durationMilliseconds: Math.max(0, Date.now() - started),
  }
}

function capacityEvidence(observedAt: string | null): Evidence {
  return {
    source: 'CapacityEvent',
    status: observedAt === null ? 'Unknown' : 'Available',
    observedAt,
    freshUntil: observedAt === null
      ? null
      : new Date(Date.parse(observedAt) + (EVENTHOUSE_LATENCY_SECONDS + TIMEPOINT_SECONDS) * 1000).toISOString(),
  }
}

function topologyEvidence(observedAt: string | null): Evidence {
  return { source: 'FabricRest', status: 'Available', observedAt, freshUntil: null }
}

function unsupportedEvidence(observedAt: string | null): Evidence {
  return { source: 'CapacityEvent', status: 'Unsupported', observedAt, freshUntil: null }
}

function unknownBytes(evidence: Evidence): ByteMeasurement {
  return { bytes: null, status: 'Unknown', evidence }
}

function unknownCu(evidence: Evidence): CuMeasurement {
  return { cuSeconds: null, status: 'Unknown', evidence }
}

function cu(value: string | null, evidence: Evidence): CuMeasurement {
  return value === null ? unknownCu(evidence) : { cuSeconds: value, status: 'Known', evidence }
}

function fabricSku(raw: string | null): FabricSku | null {
  if (!raw) return null
  return raw in SKU_CAPACITY_UNITS ? (raw as FabricSku) : null
}

function capacityUnitsFor(row: CapacitySummaryRow): number | null {
  const reported = numberOrNull(row.CapacityUnits)
  if (reported !== null) return reported
  const sku = fabricSku(stringOrNull(row.Sku))
  return sku ? SKU_CAPACITY_UNITS[sku] : null
}

function normalizedPageSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return CITY_PAGE_SIZE
  return Math.min(CITY_PAGE_SIZE, Math.floor(value))
}

function pageOffset(token: string | null | undefined): number {
  if (!token) return 0
  const parsed = Number.parseInt(token, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function requiredString(row: EventhouseRow, key: string): string {
  const value = stringOrNull(row[key])
  if (value === null) {
    throw new CapacitySourceError('Eventhouse', 'Unsupported', `Eventhouse query did not return ${key}`)
  }
  return value
}

function requiredIso(value: unknown, key: string): string {
  const iso = isoOrNull(value)
  if (iso === null) {
    throw new CapacitySourceError('Eventhouse', 'Unsupported', `Eventhouse query did not return ${key}`)
  }
  return iso
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text.length === 0 ? null : text
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function booleanOrFalse(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const normalized = normalizeToken(stringOrNull(value))
  return normalized === 'true' || normalized === '1' || normalized === 'yes'
}

function decimalStringOrNull(value: unknown): string | null {
  const number = numberOrNull(value)
  if (number === null || number < 0) return null
  return Math.round(number).toString()
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  const text = String(value)
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function normalizeToken(value: string | null): string {
  return value?.toLowerCase().replace(/[\s_-]/g, '') ?? ''
}

function sourceError(error: unknown): CapacitySourceError {
  if (error instanceof CapacitySourceError) return error
  return new CapacitySourceError('Eventhouse', classifyFailure(error), messageFrom(error))
}

function classifyFailure(error: unknown): SourceFailureKind {
  const status = httpStatus(error)
  const code = errorCode(error)
  const message = messageFrom(error).toLowerCase()

  if (status === 401 || /unauth|login|token|credential/.test(code) || /unauth|login|token|credential/.test(message)) {
    return 'Unauthenticated'
  }
  if (status === 403 || /forbidden|permission|denied/.test(code) || /forbidden|permission|denied/.test(message)) {
    return 'PermissionDenied'
  }
  if (status === 404 || /notconfigured|notfound|not found|unknown database|unknown cluster/.test(message)) {
    return 'NotConfigured'
  }
  if (
    status === 400 ||
    /badrequest|semantic|schema|column|table|resolve|parse/.test(code) ||
    /semantic|schema|column|table|failed to resolve|parse/.test(message)
  ) {
    return 'Unsupported'
  }
  if (
    status === 0 ||
    status === 408 ||
    status === 429 ||
    (status !== null && status >= 500) ||
    /network|timeout|timedout|econn|enotfound|fetch/.test(code) ||
    /network|timeout|timed out|connection|fetch/.test(message)
  ) {
    return 'Network'
  }
  return 'Unknown'
}

function httpStatus(error: unknown): number | null {
  if (!isRecord(error)) return null
  const status = error.status ?? error.statusCode ?? error.responseStatus
  return typeof status === 'number' && Number.isFinite(status) ? status : null
}

function errorCode(error: unknown): string {
  if (!isRecord(error)) return ''
  const code = error.code ?? error.name
  return typeof code === 'string' ? code.toLowerCase() : ''
}

function messageFrom(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Eventhouse query failed'
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
