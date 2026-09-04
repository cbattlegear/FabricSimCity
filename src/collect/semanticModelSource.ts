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
  BillingType,
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
  buildSemanticModelQueries,
  SEMANTIC_MODEL_SCHEMA_GENERATIONS,
  SEMANTIC_MODEL_SCHEMA_PROBE_QUERY,
  type SemanticModelQueries,
  type SemanticModelQueryName,
  type SemanticModelSchemaGeneration,
} from './semanticModelQueries'
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
const SEMANTIC_MODEL_LATENCY_SECONDS = 15 * 60
const SEMANTIC_MODEL_RETENTION_DAYS = 30

/*
 * The Capacity Metrics semantic model is refreshed on the metrics app cadence rather than the
 * Eventhouse event cadence, so this source declares a 15-minute latency instead of 30 seconds. The
 * app model keeps a longer historical window for capacity analysis; 30 days is an assumption that
 * must be verified against a real tenant before this source is made the default.
 */
export const SEMANTIC_MODEL_CAPABILITIES: CapacitySourceCapabilities = Object.freeze({
  perItemBreakdown: true,
  operationFamilies: true,
  operationSamples: false,
  timepoints: true,
  latencySeconds: SEMANTIC_MODEL_LATENCY_SECONDS,
  retentionDays: SEMANTIC_MODEL_RETENTION_DAYS,
})

export type SemanticModelDaxParameter = string | number | boolean | null

export interface SemanticModelDaxRequest {
  queryName: SemanticModelQueryName
  query: string
  parameters: Readonly<Record<string, SemanticModelDaxParameter>>
  schemaGeneration?: SemanticModelSchemaGeneration['name']
  signal?: AbortSignal
}

export type SemanticModelRow = Record<string, unknown>

export interface SemanticModelDaxClient {
  execute<T extends SemanticModelRow = SemanticModelRow>(
    request: SemanticModelDaxRequest,
  ): Promise<readonly T[]>
}

export interface SemanticModelSourceOptions {
  client: SemanticModelDaxClient
  tenant: { tenantId: string; displayName: string }
  now?: () => Date
}

interface SchemaRow extends SemanticModelRow {
  TableName?: unknown
  ColumnName?: unknown
  Table?: unknown
  Name?: unknown
}

interface DetectedSemanticModelSchema {
  generation: SemanticModelSchemaGeneration
  columns: ReadonlySet<string>
  queries: SemanticModelQueries
}

interface CapacitySummaryRow extends SemanticModelRow {
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
  StorageBytes?: unknown
  MeanUtilizationPercent?: unknown
  PeakUtilizationPercent?: unknown
  WorkspaceCount?: unknown
  ItemCount?: unknown
  InteractiveDelayPercent?: unknown
  InteractiveRejectionPercent?: unknown
  BackgroundRejectionPercent?: unknown
  CumulativeCarryOverPercent?: unknown
  ExpectedBurndownMinutes?: unknown
  SurgeProtectionActive?: unknown
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
  storageBytes: string | null
  meanUtilizationPercent: number | null
  peakUtilizationPercent: number | null
  workspaceCount: number | null
  itemCount: number | null
  throttle: ThrottleState
}

interface CityItemRow extends SemanticModelRow {
  CapacityId?: unknown
  WorkspaceId?: unknown
  WorkspaceName?: unknown
  ItemId?: unknown
  ItemName?: unknown
  ItemKind?: unknown
  CuSeconds?: unknown
  StorageBytes?: unknown
  DurationSeconds?: unknown
  OperationCount?: unknown
  SuccessfulOperationCount?: unknown
  RejectedOperationCount?: unknown
  FailedOperationCount?: unknown
  InvalidOperationCount?: unknown
  CancelledOperationCount?: unknown
  DistinctUsers?: unknown
  ThrottlingSeconds?: unknown
  PerformanceDeltaPercent?: unknown
  ObservedAt?: unknown
}

interface OperationFamilyRow extends SemanticModelRow {
  WorkspaceId?: unknown
  ItemId?: unknown
  OperationName?: unknown
  OperationClass?: unknown
  BillingType?: unknown
  CuSeconds?: unknown
  DurationSeconds?: unknown
  OperationCount?: unknown
  SuccessfulOperationCount?: unknown
  RejectedOperationCount?: unknown
  FailedOperationCount?: unknown
  InvalidOperationCount?: unknown
  CancelledOperationCount?: unknown
  DistinctUsers?: unknown
  ThrottlingSeconds?: unknown
  ObservedAt?: unknown
}

interface ParsedCityItem {
  item: CapacityCityItem
  metricValues: {
    cuSeconds: string | null
    storageBytes: string | null
    durationSeconds: number | null
    operationCount: string | null
  }
}

export function createSemanticModelSource(options: SemanticModelSourceOptions): CapacitySource {
  const clock = options.now ?? (() => new Date())
  let schemaPromise: Promise<DetectedSemanticModelSchema> | null = null

  async function execute<T extends SemanticModelRow>(
    schema: DetectedSemanticModelSchema | null,
    queryName: SemanticModelQueryName,
    query: string,
    parameters: Readonly<Record<string, SemanticModelDaxParameter>>,
    signal?: AbortSignal,
  ): Promise<readonly T[]> {
    try {
      signal?.throwIfAborted()
      return await options.client.execute<T>({
        queryName,
        query,
        parameters,
        schemaGeneration: schema?.generation.name,
        signal,
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      throw sourceError(error)
    }
  }

  async function schema(signal?: AbortSignal): Promise<DetectedSemanticModelSchema> {
    if (!schemaPromise) {
      schemaPromise = detectSchema(signal).catch((error) => {
        schemaPromise = null
        throw error
      })
    }
    return schemaPromise
  }

  async function detectSchema(signal?: AbortSignal): Promise<DetectedSemanticModelSchema> {
    const rows = await execute<SchemaRow>(null, 'schemaProbe', SEMANTIC_MODEL_SCHEMA_PROBE_QUERY, {}, signal)
    const tables = schemaTables(rows)

    for (const generation of SEMANTIC_MODEL_SCHEMA_GENERATIONS) {
      const columns = tables.get(generation.metricsByItemOperationAndDayTable)
      if (!columns) continue
      if (generation.requiredColumns.every((key) => columns.has(generation.columns[key]))) {
        return { generation, columns, queries: buildSemanticModelQueries(generation, columns) }
      }
    }

    throw new CapacitySourceError(
      'SemanticModel',
      'Unsupported',
      'Capacity Metrics semantic model schema did not match either supported generation.',
    )
  }

  function queryWindow(now: Date): { start: string; end: string } {
    const end = new Date(now.getTime() - SEMANTIC_MODEL_LATENCY_SECONDS * 1000)
    const start = new Date(end.getTime() - SEMANTIC_MODEL_RETENTION_DAYS * 86_400_000)
    return { start: start.toISOString(), end: end.toISOString() }
  }

  async function readCapacitySummaries(signal?: AbortSignal): Promise<ParsedCapacity[]> {
    const now = clock()
    const window = queryWindow(now)
    const detected = await schema(signal)
    const rows = await execute<CapacitySummaryRow>(
      detected,
      'capacitySummary',
      detected.queries.capacitySummary,
      { Start: window.start, End: window.end },
      signal,
    )

    return rows
      .map((row) => parseCapacity(row, detected.generation, window))
      .sort((left, right) =>
        left.displayName.localeCompare(right.displayName) || left.capacityId.localeCompare(right.capacityId),
      )
  }

  return {
    kind: 'SemanticModel',
    capabilities: SEMANTIC_MODEL_CAPABILITIES,

    async readAtlas(signal?: AbortSignal): Promise<AtlasSnapshot> {
      const started = Date.now()
      const now = clock()
      const capacities = (await readCapacitySummaries(signal)).map(atlasItem)

      return {
        schemaVersion: SCHEMA_VERSION,
        snapshotId: `semantic-model-${now.toISOString()}`,
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
      const detected = await schema(request.signal)
      const capacity = (await readCapacitySummaries(request.signal)).find(
        (entry) => entry.capacityId === request.capacityId,
      )
      const window = {
        start: capacity?.windowStart ?? queryWindow(now).start,
        end: capacity?.windowEnd ?? queryWindow(now).end,
      }
      const rows = await execute<CityItemRow>(
        detected,
        'cityItems',
        detected.queries.cityItems,
        { CapacityId: request.capacityId, Start: window.start, End: window.end },
        request.signal,
      )
      const familyRows = await execute<OperationFamilyRow>(
        detected,
        'operationFamilies',
        detected.queries.operationFamilies,
        { CapacityId: request.capacityId, Start: window.start, End: window.end },
        request.signal,
      )
      const allItems = rows
        .map((row, index) => cityItem(row, detected.generation, index, capacity?.observedAt ?? null))
        .sort((left, right) => compareItems(left, right, request.metric))
      const pageSize = normalizedPageSize(request.pageSize)
      const offset = pageOffset(request.pageToken)
      const page = allItems.slice(offset, offset + pageSize)
      const pageItemIds = new Set(page.map((entry) => entry.item.itemId))
      const workspaceCounts = workspaceItemCounts(allItems)
      const workspaceOrdinals = workspaceOrdinalMap(allItems)
      const workspaces = cityWorkspaces(page, workspaceCounts, workspaceOrdinals)
      const families = familyRows
        .map((row) => operationFamily(row, detected.generation, capacity?.observedAt ?? null))
        .filter((family): family is OperationFamily => family !== null)
      const topOperationFamilies = families.filter((family) => pageItemIds.has(family.itemId))
      const nextOffset = offset + page.length
      const hiddenItems = allItems.filter((entry) => !pageItemIds.has(entry.item.itemId))

      return {
        schemaVersion: SCHEMA_VERSION,
        capacityId: request.capacityId,
        capacityName: capacity?.displayName ?? request.capacityId,
        metric: request.metric,
        pageSize,
        nextPageToken: nextOffset < allItems.length ? String(nextOffset) : null,
        totalItems: String(allItems.length),
        window,
        workspaces,
        items: page.map((entry, index) => ({
          ...entry.item,
          layout: {
            neighborhoodOrdinal: workspaceOrdinals.get(entry.item.workspaceId) ?? 0,
            itemOrdinal: offset + index,
          },
        })),
        topOperationFamilies,
        otherWorkload: otherWorkload(hiddenItems, families, pageItemIds, capacity?.observedAt ?? null),
        routes: [],
        throttle: capacity?.throttle ?? unknownThrottle(null),
        evidence: capacity?.throttle.evidence ?? semanticEvidence(null, 'Unknown'),
      }
    },

    async readTimepoints(request: TimepointRequest): Promise<CapacityTimepoint[]> {
      const detected = await schema(request.signal)
      const rows = await execute<SemanticModelRow>(
        detected,
        'timepoints',
        detected.queries.timepoints,
        { CapacityId: request.capacityId, Start: request.start, End: request.end },
        request.signal,
      )
      return rows.map((row) => parseTimepoint(row, detected.generation)).sort((left, right) =>
        Date.parse(left.timepoint) - Date.parse(right.timepoint),
      )
    },

    async readOperationSamples(request: OperationSampleRequest): Promise<OperationSample[]> {
      request.signal?.throwIfAborted()
      return []
    },
  }
}

function schemaTables(rows: readonly SchemaRow[]): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>()
  for (const row of rows) {
    const table = stringOrNull(row.TableName) ?? stringOrNull(row.Table)
    const column = stringOrNull(row.ColumnName) ?? stringOrNull(row.Name)
    if (!table || !column) continue
    const columns = tables.get(table) ?? new Set<string>()
    columns.add(column)
    tables.set(table, columns)
  }
  return tables
}

function atlasItem(capacity: ParsedCapacity): CapacityAtlasItem {
  const evidence = semanticEvidence(capacity.observedAt)
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
    storage: bytes(capacity.storageBytes, evidence),
    workspaceCount: capacity.workspaceCount,
    itemCount: capacity.itemCount,
    throttle: capacity.throttle,
  }
}

function citySummary(capacity: ParsedCapacity): CapacityCitySummary {
  const evidence = semanticEvidence(capacity.observedAt)
  return {
    capacityId: capacity.capacityId,
    name: capacity.displayName,
    workspaceCount: countString(capacity.workspaceCount),
    itemCount: countString(capacity.itemCount),
    cuSeconds: capacity.totalCuSeconds,
    storageBytes: capacity.storageBytes,
    sizeStatus: capacity.totalCuSeconds === null && capacity.storageBytes === null ? 'Unknown' : 'Known',
    evidence,
  }
}

function parseCapacity(
  row: CapacitySummaryRow,
  generation: SemanticModelSchemaGeneration,
  window: { start: string; end: string },
): ParsedCapacity {
  const capacityId = requiredString(rowValue(row, 'CapacityId', generation.columns.capacityId), 'CapacityId')
  const observedAt = isoOrNull(rowValue(row, 'ObservedAt', '__ObservedAt', generation.columns.observedAt))
  const capacityUnits = capacityUnitsFor(row, generation)
  const stateReason = capacityStateReason(stringOrNull(rowValue(row, 'StateReason', generation.columns.stateReason)))
  const throttle = throttleState(row, generation, observedAt)

  return {
    capacityId,
    displayName: stringOrNull(rowValue(row, 'CapacityName', generation.columns.capacityName)) ?? capacityId,
    sku: fabricSku(stringOrNull(rowValue(row, 'Sku', generation.columns.sku))),
    capacityUnits,
    region: stringOrNull(rowValue(row, 'Region', generation.columns.region)),
    state: capacityState(stringOrNull(rowValue(row, 'CapacityState', generation.columns.capacityState)), stateReason, throttle.stage),
    stateReason,
    observedAt,
    windowStart: isoOrNull(rowValue(row, 'WindowStart')) ?? window.start,
    windowEnd: isoOrNull(rowValue(row, 'WindowEnd')) ?? window.end,
    totalCuSeconds: decimalStringOrNull(rowValue(row, 'TotalCuSeconds', '__TotalCuSeconds')),
    storageBytes: decimalStringOrNull(rowValue(row, 'StorageBytes', '__StorageBytes', generation.columns.storageBytes)),
    meanUtilizationPercent: numberOrNull(rowValue(row, 'MeanUtilizationPercent', '__MeanUtilizationPercent')),
    peakUtilizationPercent: numberOrNull(rowValue(row, 'PeakUtilizationPercent', '__PeakUtilizationPercent')),
    workspaceCount: countOrNull(rowValue(row, 'WorkspaceCount', '__WorkspaceCount')),
    itemCount: countOrNull(rowValue(row, 'ItemCount', '__ItemCount')),
    throttle,
  }
}

function parseTimepoint(row: SemanticModelRow, generation: SemanticModelSchemaGeneration): CapacityTimepoint {
  const sku = fabricSku(stringOrNull(rowValue(row, 'Sku', generation.columns.sku)))
  const capacityUnits = numberOrNull(rowValue(row, 'CapacityUnits', generation.columns.capacityUnits)) ?? (sku ? SKU_CAPACITY_UNITS[sku] : null)
  return {
    timepoint: requiredIso(rowValue(row, 'Timepoint', generation.columns.observedAt), 'Timepoint'),
    cuLimit: capacityUnits === null ? null : capacityUnits * TIMEPOINT_SECONDS,
    interactiveBillablePercent: numberOrNull(rowValue(row, 'InteractiveBillablePercent', '__InteractiveBillablePercent', generation.columns.interactiveBillablePercent)),
    backgroundBillablePercent: numberOrNull(rowValue(row, 'BackgroundBillablePercent', '__BackgroundBillablePercent', generation.columns.backgroundBillablePercent)),
    interactiveNonBillablePercent: numberOrNull(rowValue(row, 'InteractiveNonBillablePercent', '__InteractiveNonBillablePercent', generation.columns.interactiveNonBillablePercent)),
    backgroundNonBillablePercent: numberOrNull(rowValue(row, 'BackgroundNonBillablePercent', '__BackgroundNonBillablePercent', generation.columns.backgroundNonBillablePercent)),
    interactiveDelayPercent: numberOrNull(rowValue(row, 'InteractiveDelayPercent', '__InteractiveDelayPercent', generation.columns.interactiveDelayPercent)),
    interactiveRejectionPercent: numberOrNull(rowValue(row, 'InteractiveRejectionPercent', '__InteractiveRejectionPercent', generation.columns.interactiveRejectionPercent)),
    backgroundRejectionPercent: numberOrNull(rowValue(row, 'BackgroundRejectionPercent', '__BackgroundRejectionPercent', generation.columns.backgroundRejectionPercent)),
    carryOverAddPercent: null,
    carryOverBurndownPercent: null,
    cumulativeCarryOverPercent: numberOrNull(rowValue(row, 'CumulativeCarryOverPercent', '__CumulativeCarryOverPercent', generation.columns.cumulativeCarryOverPercent)),
    expectedBurndownMinutes: numberOrNull(rowValue(row, 'ExpectedBurndownMinutes', '__ExpectedBurndownMinutes', generation.columns.expectedBurndownMinutes)),
  }
}

function cityItem(
  row: CityItemRow,
  generation: SemanticModelSchemaGeneration,
  itemOrdinal: number,
  observedAt: string | null,
): ParsedCityItem {
  const workspaceId = requiredString(rowValue(row, 'WorkspaceId', generation.columns.workspaceId), 'WorkspaceId')
  const itemId = requiredString(rowValue(row, 'ItemId', generation.columns.itemId), 'ItemId')
  const kind: FabricItemKind = normalizeItemKind(stringOrNull(rowValue(row, 'ItemKind', generation.columns.itemKind)))
  const evidence = semanticEvidence(isoOrNull(rowValue(row, 'ObservedAt', '__ObservedAt')) ?? observedAt)
  const cuSeconds = decimalStringOrNull(rowValue(row, 'CuSeconds', '__CuSeconds'))
  const storageBytes = decimalStringOrNull(rowValue(row, 'StorageBytes', '__StorageBytes', generation.columns.storageBytes))
  const durationSeconds = numberOrNull(rowValue(row, 'DurationSeconds', '__DurationSeconds', generation.columns.durationSeconds))
  const operations = operationCounts(row, generation)

  return {
    item: {
      itemId,
      workspaceId,
      workspaceName: stringOrNull(rowValue(row, 'WorkspaceName', generation.columns.workspaceName)) ?? workspaceId,
      name: stringOrNull(rowValue(row, 'ItemName', generation.columns.itemName)) ?? itemId,
      kind,
      archetype: itemArchetype(kind),
      storage: bytes(storageBytes, evidence),
      cuConsumed: cu(cuSeconds, evidence),
      durationSeconds,
      operations,
      distinctUsers: decimalStringOrNull(rowValue(row, 'DistinctUsers', '__DistinctUsers', generation.columns.distinctUsers)),
      throttlingMinutes: throttlingMinutes(rowValue(row, 'ThrottlingSeconds', '__ThrottlingSeconds', generation.columns.throttlingSeconds)),
      performanceDeltaPercent: numberOrNull(rowValue(row, 'PerformanceDeltaPercent', '__PerformanceDeltaPercent', generation.columns.performanceDeltaPercent)),
      layout: { neighborhoodOrdinal: 0, itemOrdinal },
      sizeStatus: cuSeconds === null && storageBytes === null ? 'Unknown' : 'Known',
      evidence,
    },
    metricValues: {
      cuSeconds,
      storageBytes,
      durationSeconds,
      operationCount: operations.total,
    },
  }
}

function operationFamily(
  row: OperationFamilyRow,
  generation: SemanticModelSchemaGeneration,
  observedAt: string | null,
): OperationFamily | null {
  const itemId = stringOrNull(rowValue(row, 'ItemId', generation.columns.itemId))
  const workspaceId = stringOrNull(rowValue(row, 'WorkspaceId', generation.columns.workspaceId))
  const operationName = stringOrNull(rowValue(row, 'OperationName', generation.columns.operationName))
  const cuSeconds = decimalStringOrNull(rowValue(row, 'CuSeconds', '__CuSeconds'))
  const durationSeconds = numberOrNull(rowValue(row, 'DurationSeconds', '__DurationSeconds', generation.columns.durationSeconds))
  const operationCount = decimalStringOrNull(rowValue(row, 'OperationCount', '__OperationCount', generation.columns.operationCount))
  if (!itemId || !workspaceId || !operationName || cuSeconds === null || durationSeconds === null || operationCount === null) {
    return null
  }

  return {
    familyId: `${itemId}:${operationName}`,
    operationName,
    itemId,
    itemIds: [itemId],
    workspaceId,
    operationClass: operationClass(stringOrNull(rowValue(row, 'OperationClass', generation.columns.operationClass))),
    billingType: billingType(stringOrNull(rowValue(row, 'BillingType', generation.columns.billingType))),
    cuSeconds,
    durationSeconds,
    operationCount,
    throttlingSeconds: numberOrNull(rowValue(row, 'ThrottlingSeconds', '__ThrottlingSeconds', generation.columns.throttlingSeconds)),
    distinctUsers: decimalStringOrNull(rowValue(row, 'DistinctUsers', '__DistinctUsers', generation.columns.distinctUsers)),
    counts: operationCounts(row, generation),
    evidence: semanticEvidence(isoOrNull(rowValue(row, 'ObservedAt', '__ObservedAt')) ?? observedAt),
  }
}

function operationCounts(row: SemanticModelRow, generation: SemanticModelSchemaGeneration): ItemOperationCounts {
  return {
    total: decimalStringOrNull(rowValue(row, 'OperationCount', '__OperationCount', generation.columns.operationCount)),
    successful: decimalStringOrNull(rowValue(row, 'SuccessfulOperationCount', '__SuccessfulOperationCount', generation.columns.successfulOperationCount)),
    rejected: decimalStringOrNull(rowValue(row, 'RejectedOperationCount', '__RejectedOperationCount', generation.columns.rejectedOperationCount)),
    failed: decimalStringOrNull(rowValue(row, 'FailedOperationCount', '__FailedOperationCount', generation.columns.failedOperationCount)),
    invalid: decimalStringOrNull(rowValue(row, 'InvalidOperationCount', '__InvalidOperationCount', generation.columns.invalidOperationCount)),
    cancelled: decimalStringOrNull(rowValue(row, 'CancelledOperationCount', '__CancelledOperationCount', generation.columns.cancelledOperationCount)),
  }
}

function cityWorkspaces(
  rows: readonly ParsedCityItem[],
  workspaceCounts: ReadonlyMap<string, number>,
  workspaceOrdinals: ReadonlyMap<string, number>,
): CapacityCityWorkspace[] {
  const names = Array.from(new Set(rows.map((entry) => entry.item.workspaceId))).sort((left, right) => {
    const leftName = rows.find((entry) => entry.item.workspaceId === left)?.item.workspaceName ?? left
    const rightName = rows.find((entry) => entry.item.workspaceId === right)?.item.workspaceName ?? right
    return leftName.localeCompare(rightName) || left.localeCompare(right)
  })

  return names.map((workspaceId, neighborhoodOrdinal) => {
    const item = rows.find((entry) => entry.item.workspaceId === workspaceId)!.item
    return {
      workspaceId,
      name: item.workspaceName,
      neighborhoodOrdinal: workspaceOrdinals.get(workspaceId) ?? neighborhoodOrdinal,
      itemCount: countString(workspaceCounts.get(workspaceId) ?? 0),
      evidence: item.evidence,
    }
  })
}

function workspaceOrdinalMap(rows: readonly ParsedCityItem[]): Map<string, number> {
  const names = Array.from(new Set(rows.map((entry) => entry.item.workspaceId))).sort((left, right) => {
    const leftName = rows.find((entry) => entry.item.workspaceId === left)?.item.workspaceName ?? left
    const rightName = rows.find((entry) => entry.item.workspaceId === right)?.item.workspaceName ?? right
    return leftName.localeCompare(rightName) || left.localeCompare(right)
  })
  return new Map(names.map((workspaceId, index) => [workspaceId, index]))
}

function workspaceItemCounts(rows: readonly ParsedCityItem[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    counts.set(row.item.workspaceId, (counts.get(row.item.workspaceId) ?? 0) + 1)
  }
  return counts
}

function otherWorkload(
  hiddenItems: readonly ParsedCityItem[],
  families: readonly OperationFamily[],
  pageItemIds: ReadonlySet<string>,
  observedAt: string | null,
): CapacityCityPage['otherWorkload'] {
  const hiddenItemIds = new Set(hiddenItems.map((entry) => entry.item.itemId))
  const hiddenFamilies = families.filter((family) => hiddenItemIds.has(family.itemId) && !pageItemIds.has(family.itemId))
  return {
    familyCount: String(hiddenFamilies.length),
    operationCount: sumDecimal(hiddenItems.map((entry) => entry.metricValues.operationCount)),
    cuSeconds: sumDecimal(hiddenItems.map((entry) => entry.metricValues.cuSeconds)),
    durationSeconds: sumNumbers(hiddenItems.map((entry) => entry.metricValues.durationSeconds)),
    evidence: semanticEvidence(observedAt),
  }
}

function compareItems(
  left: ParsedCityItem,
  right: ParsedCityItem,
  metric: CityPageRequest['metric'],
): number {
  const metricOrder = compareMetric(metricValue(right, metric), metricValue(left, metric))
  if (metricOrder !== 0) return metricOrder
  return (
    left.item.workspaceName.localeCompare(right.item.workspaceName) ||
    left.item.name.localeCompare(right.item.name) ||
    left.item.itemId.localeCompare(right.item.itemId)
  )
}

function metricValue(item: ParsedCityItem, metric: CityPageRequest['metric']): string | number | null {
  switch (metric) {
    case 'Storage':
      return item.metricValues.storageBytes
    case 'Duration':
      return item.metricValues.durationSeconds
    case 'Operations':
      return item.metricValues.operationCount
    case 'Cu':
      return item.metricValues.cuSeconds
  }
}

function compareMetric(left: string | number | null, right: string | number | null): number {
  if (left === null && right === null) return 0
  if (left === null) return -1
  if (right === null) return 1
  const leftNumber = typeof left === 'number' ? left : Number(left)
  const rightNumber = typeof right === 'number' ? right : Number(right)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber
  }
  return String(left).localeCompare(String(right))
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
    source: 'SemanticModel',
    state: 'Ready',
    collectedAt: now.toISOString(),
    isStale: stale,
    capacityCount: capacities.length,
    failureCount: 0,
    durationMilliseconds: Math.max(0, Date.now() - started),
  }
}

function throttleState(
  row: CapacitySummaryRow,
  generation: SemanticModelSchemaGeneration,
  observedAt: string | null,
): ThrottleState {
  const interactiveDelayPercent = numberOrNull(rowValue(row, 'InteractiveDelayPercent', '__InteractiveDelayPercent', generation.columns.interactiveDelayPercent))
  const interactiveRejectionPercent = numberOrNull(rowValue(row, 'InteractiveRejectionPercent', '__InteractiveRejectionPercent', generation.columns.interactiveRejectionPercent))
  const backgroundRejectionPercent = numberOrNull(rowValue(row, 'BackgroundRejectionPercent', '__BackgroundRejectionPercent', generation.columns.backgroundRejectionPercent))

  return {
    stage: throttleStage(
      stringOrNull(rowValue(row, 'StateReason', generation.columns.stateReason)),
      interactiveDelayPercent,
      interactiveRejectionPercent,
      backgroundRejectionPercent,
    ),
    interactiveDelayPercent,
    interactiveRejectionPercent,
    backgroundRejectionPercent,
    cumulativeCarryOverPercent: numberOrNull(rowValue(row, 'CumulativeCarryOverPercent', '__CumulativeCarryOverPercent', generation.columns.cumulativeCarryOverPercent)),
    expectedBurndownMinutes: numberOrNull(rowValue(row, 'ExpectedBurndownMinutes', '__ExpectedBurndownMinutes', generation.columns.expectedBurndownMinutes)),
    surgeProtectionActive: booleanOrFalse(rowValue(row, 'SurgeProtectionActive', '__SurgeProtectionActive', generation.columns.surgeProtectionActive)),
    evidence: semanticEvidence(observedAt),
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
    evidence: semanticEvidence(observedAt, 'Unknown'),
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

function semanticEvidence(observedAt: string | null, status: Evidence['status'] = 'Available'): Evidence {
  return {
    source: 'SemanticModel',
    status: observedAt === null && status === 'Available' ? 'Unknown' : status,
    observedAt,
    freshUntil: observedAt === null || status !== 'Available'
      ? null
      : new Date(Date.parse(observedAt) + SEMANTIC_MODEL_LATENCY_SECONDS * 1000).toISOString(),
  }
}

function bytes(value: string | null, evidence: Evidence): ByteMeasurement {
  return value === null ? { bytes: null, status: 'Unknown', evidence } : { bytes: value, status: 'Known', evidence }
}

function cu(value: string | null, evidence: Evidence): CuMeasurement {
  return value === null ? { cuSeconds: null, status: 'Unknown', evidence } : { cuSeconds: value, status: 'Known', evidence }
}

function fabricSku(raw: string | null): FabricSku | null {
  if (!raw) return null
  return raw in SKU_CAPACITY_UNITS ? (raw as FabricSku) : null
}

function capacityUnitsFor(row: CapacitySummaryRow, generation: SemanticModelSchemaGeneration): number | null {
  const reported = numberOrNull(rowValue(row, 'CapacityUnits', generation.columns.capacityUnits))
  if (reported !== null) return reported
  const sku = fabricSku(stringOrNull(rowValue(row, 'Sku', generation.columns.sku)))
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

function requiredString(value: unknown, key: string): string {
  const text = stringOrNull(value)
  if (text === null) {
    throw new CapacitySourceError('SemanticModel', 'Unsupported', `Semantic model query did not return ${key}`)
  }
  return text
}

function requiredIso(value: unknown, key: string): string {
  const iso = isoOrNull(value)
  if (iso === null) {
    throw new CapacitySourceError('SemanticModel', 'Unsupported', `Semantic model query did not return ${key}`)
  }
  return iso
}

function rowValue(row: SemanticModelRow, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in row) return row[key]
    const bracketed = `[${key}]`
    if (bracketed in row) return row[bracketed]
    const tableColumn = Object.entries(row).find(([entryKey]) => entryKey.endsWith(bracketed))
    if (tableColumn) return tableColumn[1]
  }
  return undefined
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

function countOrNull(value: unknown): number | null {
  const count = numberOrNull(value)
  return count === null || count < 0 ? null : Math.round(count)
}

function countString(value: number | null): string | null {
  return value === null ? null : Math.max(0, Math.round(value)).toString()
}

function decimalStringOrNull(value: unknown): string | null {
  const number = numberOrNull(value)
  if (number === null || number < 0) return null
  return Math.round(number).toString()
}

function booleanOrFalse(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const normalized = normalizeToken(stringOrNull(value))
  return normalized === 'true' || normalized === '1' || normalized === 'yes'
}

function throttlingMinutes(value: unknown): number | null {
  const seconds = numberOrNull(value)
  return seconds === null ? null : seconds / 60
}

function operationClass(raw: string | null): OperationClass {
  const normalized = normalizeToken(raw)
  if (normalized === 'interactive') return 'Interactive'
  if (normalized === 'background') return 'Background'
  return 'Unknown'
}

function billingType(raw: string | null): BillingType {
  const normalized = normalizeToken(raw)
  if (normalized === 'billable') return 'Billable'
  if (normalized === 'nonbillable' || normalized === 'nonbillableoperation') return 'NonBillable'
  return 'Unknown'
}

function sumDecimal(values: readonly (string | null)[]): string | null {
  if (values.length === 0) return '0'
  let sum = 0n
  for (const value of values) {
    if (value === null || !/^\d+$/.test(value)) return null
    sum += BigInt(value)
  }
  return sum.toString()
}

function sumNumbers(values: readonly (number | null)[]): number | null {
  if (values.length === 0) return 0
  let sum = 0
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) return null
    sum += value
  }
  return sum
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function normalizeToken(value: string | null): string {
  return value?.toLowerCase().replace(/[\s_-]/g, '') ?? ''
}

function sourceError(error: unknown): CapacitySourceError {
  if (error instanceof CapacitySourceError) return error
  return new CapacitySourceError('SemanticModel', classifyFailure(error), messageFrom(error))
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
  if (status === 404 || /notconfigured|notfound|not found|semantic model not found|workspace not found/.test(message)) {
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
  return 'Semantic model query failed'
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
