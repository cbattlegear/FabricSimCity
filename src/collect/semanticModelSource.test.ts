import { describe, expect, it } from 'vitest'
import { TIMEPOINT_SECONDS } from '../fabricContracts'
import {
  buildSemanticModelQueries,
  SEMANTIC_MODEL_SCHEMA_GENERATIONS,
  type SemanticModelQueryName,
} from './semanticModelQueries'
import {
  SEMANTIC_MODEL_CAPABILITIES,
  createSemanticModelSource,
  type SemanticModelDaxClient,
  type SemanticModelDaxRequest,
  type SemanticModelRow,
} from './semanticModelSource'

const NOW = new Date(Date.UTC(2026, 0, 8, 12, 20, 0))
const OBSERVED = new Date(Date.UTC(2026, 0, 8, 12, 5, 0)).toISOString()
const REQUEST = {
  capacityId: 'cap-1',
  start: new Date(Date.UTC(2026, 0, 8, 11, 0, 0)).toISOString(),
  end: new Date(Date.UTC(2026, 0, 8, 12, 10, 0)).toISOString(),
}

class FakeDaxClient implements SemanticModelDaxClient {
  readonly calls: SemanticModelDaxRequest[] = []

  constructor(
    private readonly rows: Partial<Record<SemanticModelQueryName, readonly SemanticModelRow[]>> = {},
    private readonly errors: Partial<Record<SemanticModelQueryName, unknown>> = {},
  ) {}

  async execute<T extends SemanticModelRow = SemanticModelRow>(request: SemanticModelDaxRequest): Promise<readonly T[]> {
    this.calls.push(request)
    const error = this.errors[request.queryName]
    if (error) throw error
    return (this.rows[request.queryName] ?? []) as readonly T[]
  }
}

const legacyGeneration = SEMANTIC_MODEL_SCHEMA_GENERATIONS[0]
const currentGeneration = SEMANTIC_MODEL_SCHEMA_GENERATIONS[1]

function source(client: FakeDaxClient) {
  return createSemanticModelSource({
    client,
    tenant: { tenantId: 'tenant-1', displayName: 'Contoso Tenant' },
    now: () => NOW,
  })
}

function schemaRows(generation = currentGeneration): SemanticModelRow[] {
  return Object.values(generation.columns).map((column) => ({
    TableName: generation.metricsByItemOperationAndDayTable,
    ColumnName: column,
  }))
}

function summaryRow(overrides: SemanticModelRow = {}): SemanticModelRow {
  return {
    CapacityId: 'cap-1',
    CapacityName: 'Contoso Capacity',
    Sku: 'F64',
    CapacityUnits: 64,
    Region: 'westus',
    CapacityState: 'Active',
    StateReason: 'NotOverloaded',
    ObservedAt: OBSERVED,
    WindowStart: new Date(Date.UTC(2026, 0, 7, 12, 5, 0)).toISOString(),
    WindowEnd: OBSERVED,
    TotalCuSeconds: 1200,
    StorageBytes: 4096,
    MeanUtilizationPercent: 42.5,
    PeakUtilizationPercent: 88.25,
    WorkspaceCount: 2,
    ItemCount: 3,
    InteractiveDelayPercent: 20,
    InteractiveRejectionPercent: 30,
    BackgroundRejectionPercent: 40,
    CumulativeCarryOverPercent: 5,
    ExpectedBurndownMinutes: 7,
    SurgeProtectionActive: false,
    ...overrides,
  }
}

function itemRow(overrides: SemanticModelRow = {}): SemanticModelRow {
  return {
    CapacityId: 'cap-1',
    WorkspaceId: 'workspace-a',
    WorkspaceName: 'Alpha',
    ItemId: 'item-1',
    ItemName: 'One',
    ItemKind: 'Pipeline',
    CuSeconds: 500,
    StorageBytes: null,
    DurationSeconds: 60,
    OperationCount: 10,
    SuccessfulOperationCount: 8,
    RejectedOperationCount: 2,
    FailedOperationCount: 0,
    InvalidOperationCount: 0,
    CancelledOperationCount: 0,
    DistinctUsers: 3,
    ThrottlingSeconds: 120,
    PerformanceDeltaPercent: null,
    ObservedAt: OBSERVED,
    ...overrides,
  }
}

function familyRow(overrides: SemanticModelRow = {}): SemanticModelRow {
  return {
    WorkspaceId: 'workspace-a',
    ItemId: 'item-1',
    OperationName: 'Pipeline Activity Run',
    OperationClass: 'Background',
    BillingType: 'Billable',
    CuSeconds: 500,
    DurationSeconds: 60,
    OperationCount: 10,
    RejectedOperationCount: 2,
    ObservedAt: OBSERVED,
    ...overrides,
  }
}

describe('semantic model DAX source capabilities and query assumptions', () => {
  it('declares the unsupported-but-rich semantic-model shape up front', () => {
    const feed = source(new FakeDaxClient())

    expect(feed.kind).toBe('SemanticModel')
    expect(feed.capabilities).toEqual(SEMANTIC_MODEL_CAPABILITIES)
    expect(feed.capabilities).toMatchObject({
      perItemBreakdown: true,
      operationFamilies: true,
      operationSamples: false,
      timepoints: true,
      latencySeconds: 900,
      retentionDays: 30,
    })
  })

  it('keeps DAX table and schema assumptions reviewable', () => {
    const queries = buildSemanticModelQueries(
      currentGeneration,
      new Set(Object.values(currentGeneration.columns)),
    )

    expect(queries.schemaProbe).toContain('INFO.COLUMNS()')
    expect(queries.cityItems).toContain('MetricsByItemandOperationandDay')
    expect(queries.cityItems).toContain('CuSeconds')
    expect(queries.operationFamilies).toContain('OperationName')
    expect(queries.timepoints).toContain('@CapacityId')
  })
})

describe('semantic model schema probing', () => {
  it('detects the legacy spaced table generation and sends legacy DAX', async () => {
    const client = new FakeDaxClient({
      schemaProbe: schemaRows(legacyGeneration),
      capacitySummary: [summaryRow()],
    })

    await source(client).readAtlas()

    const summary = client.calls.find((call) => call.queryName === 'capacitySummary')
    expect(summary?.schemaGeneration).toBe('metricsByItemOperationAndDay')
    expect(summary?.query).toContain("'Metrics By Item Operation And Day'")
  })

  it('detects the current compact table generation and sends current DAX', async () => {
    const client = new FakeDaxClient({
      schemaProbe: schemaRows(currentGeneration),
      capacitySummary: [summaryRow()],
    })

    await source(client).readAtlas()

    const summary = client.calls.find((call) => call.queryName === 'capacitySummary')
    expect(summary?.schemaGeneration).toBe('metricsByItemandOperationandDay')
    expect(summary?.query).toContain("'MetricsByItemandOperationandDay'")
  })

  it('returns Unsupported instead of guessing when neither known schema matches', async () => {
    const client = new FakeDaxClient({
      schemaProbe: [{ TableName: 'SomethingElse', ColumnName: 'CapacityId' }],
      capacitySummary: [summaryRow()],
    })

    await expect(source(client).readAtlas()).rejects.toMatchObject({
      name: 'CapacitySourceError',
      sourceKind: 'SemanticModel',
      failure: 'Unsupported',
    })
    expect(client.calls.map((call) => call.queryName)).toEqual(['schemaProbe'])
  })
})

describe('semantic model atlas and summaries', () => {
  it('flows capacity CU and storage through as measured values', async () => {
    const client = new FakeDaxClient({
      schemaProbe: schemaRows(),
      capacitySummary: [summaryRow({ TotalCuSeconds: 1200.6, StorageBytes: 4096.4 })],
    })

    const [capacity] = (await source(client).readAtlas()).capacities

    expect(capacity.cuConsumed).toMatchObject({
      cuSeconds: '1201',
      status: 'Known',
      evidence: { source: 'SemanticModel', status: 'Available', observedAt: OBSERVED },
    })
    expect(capacity.storage).toMatchObject({
      bytes: '4096',
      status: 'Known',
      evidence: { source: 'SemanticModel', status: 'Available' },
    })
    expect(capacity.workspaceCount).toBe(2)
    expect(capacity.itemCount).toBe(3)
  })

  it('leaves absent capacity telemetry unmeasured rather than zero', async () => {
    const client = new FakeDaxClient({
      schemaProbe: schemaRows(),
      capacitySummary: [summaryRow({ TotalCuSeconds: null, StorageBytes: undefined })],
    })

    const [capacity] = (await source(client).readAtlas()).capacities

    expect(capacity.cuConsumed).toMatchObject({ cuSeconds: null, status: 'Unknown' })
    expect(capacity.storage).toMatchObject({ bytes: null, status: 'Unknown' })
  })
})

describe('semantic model city pages', () => {
  it('pages ranked items and preserves measured per-item CU', async () => {
    const client = new FakeDaxClient({
      schemaProbe: schemaRows(),
      capacitySummary: [summaryRow()],
      cityItems: [
        itemRow({ ItemId: 'item-3', ItemName: 'Three', CuSeconds: 300, OperationCount: 3 }),
        itemRow({ ItemId: 'item-1', ItemName: 'One', CuSeconds: 900, OperationCount: 9 }),
        itemRow({ ItemId: 'item-2', ItemName: 'Two', CuSeconds: 600, OperationCount: 6 }),
      ],
      operationFamilies: [
        familyRow({ ItemId: 'item-1', CuSeconds: 900, OperationCount: 9 }),
        familyRow({ ItemId: 'item-2', CuSeconds: 600, OperationCount: 6 }),
        familyRow({ ItemId: 'item-3', CuSeconds: 300, OperationCount: 3 }),
      ],
    })

    const first = await source(client).readCityPage({ capacityId: 'cap-1', metric: 'Cu', pageSize: 2 })
    const second = await source(client).readCityPage({
      capacityId: 'cap-1',
      metric: 'Cu',
      pageSize: 2,
      pageToken: first.nextPageToken,
    })

    expect(first.items.map((item) => item.itemId)).toEqual(['item-1', 'item-2'])
    expect(first.items[0].cuConsumed).toMatchObject({ cuSeconds: '900', status: 'Known' })
    expect(first.nextPageToken).toBe('2')
    expect(first.totalItems).toBe('3')
    expect(second.items.map((item) => item.itemId)).toEqual(['item-3'])
    expect(second.nextPageToken).toBeNull()
  })

  it('normalizes metrics item kinds and keeps unknown kinds instead of dropping them', async () => {
    const client = new FakeDaxClient({
      schemaProbe: schemaRows(),
      capacitySummary: [summaryRow()],
      cityItems: [
        itemRow({ ItemId: 'pipeline', ItemKind: 'Pipeline' }),
        itemRow({ ItemId: 'function', ItemKind: 'User Data Functions' }),
        itemRow({ ItemId: 'future', ItemKind: 'Copilot Mystery Item' }),
      ],
      operationFamilies: [],
    })

    const page = await source(client).readCityPage({ capacityId: 'cap-1', metric: 'Cu', pageSize: 50 })

    expect(page.items.map((item) => [item.itemId, item.kind]).sort()).toEqual([
      ['function', 'UserDataFunction'],
      ['future', 'Unknown'],
      ['pipeline', 'DataPipeline'],
    ])
    expect(page.items.map((item) => item.archetype).sort()).toEqual(['Compute', 'Compute', 'Compute'])
  })

  it('leaves absent item CU unmeasured rather than fabricating zero', async () => {
    const client = new FakeDaxClient({
      schemaProbe: schemaRows(),
      capacitySummary: [summaryRow()],
      cityItems: [itemRow({ CuSeconds: undefined, StorageBytes: 2048 })],
      operationFamilies: [],
    })

    const page = await source(client).readCityPage({ capacityId: 'cap-1', metric: 'Cu', pageSize: 50 })

    expect(page.items[0].cuConsumed).toMatchObject({ cuSeconds: null, status: 'Unknown' })
    expect(page.items[0].storage).toMatchObject({ bytes: '2048', status: 'Known' })
  })

  it('maps throttle stages without treating interactive delay as rejection', async () => {
    const client = new FakeDaxClient({
      schemaProbe: schemaRows(),
      capacitySummary: [
        summaryRow({
          StateReason: 'InteractiveDelay',
          InteractiveDelayPercent: 125,
          InteractiveRejectionPercent: 99,
          BackgroundRejectionPercent: 50,
        }),
      ],
      cityItems: [itemRow()],
      operationFamilies: [familyRow()],
    })

    const page = await source(client).readCityPage({ capacityId: 'cap-1', metric: 'Cu', pageSize: 50 })

    expect(page.throttle.stage).toBe('InteractiveDelay')
    expect(page.throttle.interactiveDelayPercent).toBe(125)
    expect(page.throttle.interactiveRejectionPercent).toBe(99)
    expect(page.throttle.backgroundRejectionPercent).toBe(50)
  })
})

describe('semantic model timepoints and unsupported capabilities', () => {
  it('parses timepoints and preserves null gauges as unmeasured', async () => {
    const first = new Date(Date.UTC(2026, 0, 8, 12, 0, 0)).toISOString()
    const second = new Date(Date.UTC(2026, 0, 8, 12, 0, 30)).toISOString()
    const client = new FakeDaxClient({
      schemaProbe: schemaRows(),
      timepoints: [
        { Timepoint: second, Sku: 'F64', InteractiveBillablePercent: 30, InteractiveDelayPercent: null },
        { Timepoint: first, CapacityUnits: 64, InteractiveBillablePercent: 20, BackgroundRejectionPercent: 110 },
      ],
    })

    const timepoints = await source(client).readTimepoints(REQUEST)

    expect(timepoints.map((entry) => entry.timepoint)).toEqual([first, second])
    expect(timepoints[0]).toMatchObject({
      cuLimit: 64 * TIMEPOINT_SECONDS,
      interactiveBillablePercent: 20,
      backgroundRejectionPercent: 110,
    })
    expect(timepoints[1]).toMatchObject({
      cuLimit: 64 * TIMEPOINT_SECONDS,
      interactiveDelayPercent: null,
    })
  })

  it('returns an empty operation sample list without touching DAX', async () => {
    const client = new FakeDaxClient({}, { schemaProbe: new Error('would fail if queried') })

    const samples = await source(client).readOperationSamples({ capacityId: 'cap-1', limit: 20 })

    expect(samples).toEqual([])
    expect(client.calls).toEqual([])
  })
})

describe('semantic model error mapping', () => {
  it.each([
    ['Unauthenticated', Object.assign(new Error('token expired'), { status: 401 })],
    ['PermissionDenied', Object.assign(new Error('Forbidden'), { status: 403 })],
    ['NotConfigured', Object.assign(new Error('semantic model not found'), { status: 404 })],
    ['Unsupported', Object.assign(new Error('Semantic error: failed to resolve column'), { status: 400 })],
    ['Network', Object.assign(new Error('Service unavailable'), { status: 503 })],
    ['Network', Object.assign(new TypeError('Failed to fetch'), { code: 'ENOTFOUND' })],
    ['Unknown', new Error('boom')],
  ] as const)('maps %s failures to CapacitySourceError', async (failure, error) => {
    const client = new FakeDaxClient({ schemaProbe: schemaRows() }, { timepoints: error })

    await expect(source(client).readTimepoints(REQUEST)).rejects.toMatchObject({
      name: 'CapacitySourceError',
      sourceKind: 'SemanticModel',
      failure,
    })
  })
})
