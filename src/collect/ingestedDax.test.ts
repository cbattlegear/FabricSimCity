import { describe, expect, it } from 'vitest'

import {
  DEFAULT_INGEST_INTERVAL_MINUTES,
  DEFAULT_INGEST_WINDOW_DAYS,
  TENANT_WIDE_CAPACITY_ID,
  createIngestedCapacitySource,
  createIngestedDaxClient,
  ingestedCapabilities,
  parseIngestedRow,
  type IngestRowQuery,
  type IngestRowRecord,
  type IngestRunRecord,
  type IngestStore,
} from './ingestedDax'
import { SEMANTIC_MODEL_CAPABILITIES, createSemanticModelSource, type SemanticModelRow } from './semanticModelSource'
import { SEMANTIC_MODEL_SCHEMA_GENERATIONS, type SemanticModelQueryName } from './semanticModelQueries'
import { CapacitySourceError, type CityPageRequest } from './source'

function run(overrides: Partial<IngestRunRecord> = {}): IngestRunRecord {
  return {
    id: 'run-1',
    tenantId: 'tenant',
    datasetId: 'dataset',
    schemaGeneration: 'v2',
    status: 'Complete',
    startedAt: '2024-05-01T00:00:00.000Z',
    completedAt: '2024-05-01T00:05:00.000Z',
    windowStart: '2024-04-28T00:00:00.000Z',
    windowEnd: '2024-05-01T00:00:00.000Z',
    rowCount: 3,
    ...overrides,
  }
}

function row(rowJson: string, overrides: Partial<IngestRowRecord> = {}): IngestRowRecord {
  return { queryName: 'cityItems', capacityId: 'cap-1', rowIndex: 0, rowJson, ...overrides }
}

class FakeStore implements IngestStore {
  readonly queries: IngestRowQuery[] = []
  runCalls = 0

  constructor(
    private readonly latest: IngestRunRecord | null,
    private readonly rows: readonly IngestRowRecord[] = [],
  ) {}

  async latestCompleteRun(): Promise<IngestRunRecord | null> {
    this.runCalls += 1
    return this.latest
  }

  async readRows(query: IngestRowQuery): Promise<readonly IngestRowRecord[]> {
    this.queries.push(query)
    return this.rows
  }
}

describe('parseIngestedRow', () => {
  it('strips the brackets both DAX transports wrap column names in', () => {
    const parsed = parseIngestedRow(
      row('{"[CapacityId]":"cap-1","Items[ItemName]":"Sales","Plain":3}'),
    )
    expect(parsed).toEqual({ CapacityId: 'cap-1', ItemName: 'Sales', Plain: 3 })
  })

  it('keeps a name that merely contains brackets in the middle', () => {
    // The regex is anchored at the end on purpose: only a trailing `[...]` is a column reference.
    expect(parseIngestedRow(row('{"a[b]c":1}'))).toEqual({ 'a[b]c': 1 })
  })

  it('names the row when the stored JSON is unparseable', () => {
    expect(() => parseIngestedRow(row('{not json', { queryName: 'timepoints', rowIndex: 7 })))
      .toThrowError(/timepoints#7/)
  })

  it('rejects a stored array, which would otherwise read as a row with numeric columns', () => {
    expect(() => parseIngestedRow(row('[1,2]'))).toThrowError(/not a JSON object/)
  })
})

describe('createIngestedDaxClient', () => {
  it('reads the newest complete run and returns its rows', async () => {
    const store = new FakeStore(run(), [row('{"[ItemName]":"Sales"}')])
    const client = createIngestedDaxClient({ store })

    const rows = await client.execute({
      queryName: 'cityItems',
      query: 'ignored',
      parameters: { CapacityId: 'cap-1', Start: '2024-04-30T00:00:00.000Z', End: '2024-05-01T00:00:00.000Z' },
    })

    expect(rows).toEqual([{ ItemName: 'Sales' }])
    expect(store.queries[0]).toMatchObject({ runId: 'run-1', queryName: 'cityItems', capacityId: 'cap-1' })
  })

  it('resolves the run once across queries, so a city cannot be torn across two ingests', async () => {
    const store = new FakeStore(run(), [])
    const client = createIngestedDaxClient({ store })

    await client.execute({ queryName: 'cityItems', query: '', parameters: { CapacityId: 'c' } })
    await client.execute({ queryName: 'operationFamilies', query: '', parameters: { CapacityId: 'c' } })

    expect(store.runCalls).toBe(1)
    expect(store.queries.map((query) => query.runId)).toEqual(['run-1', 'run-1'])
  })

  it('windows only the timepoints query', async () => {
    const store = new FakeStore(run(), [])
    const client = createIngestedDaxClient({ store })
    const parameters = {
      CapacityId: 'cap-1',
      Start: '2024-04-30T00:00:00.000Z',
      End: '2024-05-01T00:00:00.000Z',
    }

    await client.execute({ queryName: 'timepoints', query: '', parameters })
    await client.execute({ queryName: 'operationFamilies', query: '', parameters })

    expect(store.queries[0]).toMatchObject({
      windowStart: '2024-04-30T00:00:00.000Z',
      windowEnd: '2024-05-01T00:00:00.000Z',
    })
    // The aggregated queries carry one row per item, not per timepoint. Filtering them by the
    // caller's narrower window would silently drop every item the model summarized earlier.
    expect(store.queries[1].windowStart).toBeUndefined()
    expect(store.queries[1].windowEnd).toBeUndefined()
  })

  it('files a query with no CapacityId under the tenant-wide id', async () => {
    const store = new FakeStore(run(), [])
    const client = createIngestedDaxClient({ store })

    await client.execute({ queryName: 'capacitySummary', query: '', parameters: { Start: 'x' } })

    expect(store.queries[0].capacityId).toBe(TENANT_WIDE_CAPACITY_ID)
  })

  it('serves scoped DirectQuery summaries from one pinned tenant-wide snapshot', async () => {
    const store = new FakeStore(run(), [
      row('{"[CapacityId]":"cap-1","TotalCuSeconds":12}'),
      row('{"[CapacityId]":"cap-2","TotalCuSeconds":34}'),
    ])
    const client = createIngestedDaxClient({ store })
    expect(await client.execute({ queryName: 'capacitySummary', query: '', parameters: {} })).toHaveLength(2)
    for (const [capacityId, cu] of [['cap-1', 12], ['cap-2', 34]] as const) {
      expect(await client.execute({
        queryName: 'capacitySummary', query: '', parameters: { CapacityId: capacityId, RegionName: 'West US' },
      })).toEqual([{ CapacityId: capacityId, TotalCuSeconds: cu }])
    }
    expect(store.queries).toHaveLength(1)
    expect(store.queries[0]).toMatchObject({ runId: 'run-1', capacityId: TENANT_WIDE_CAPACITY_ID })
  })

  it('retries a failed summary snapshot instead of pinning a rejection', async () => {
    let attempts = 0
    const store: IngestStore = {
      async latestCompleteRun() { return run() },
      async readRows() {
        if (++attempts === 1) throw new Error('transient summary read')
        return [row('{"CapacityId":"cap-1"}')]
      },
    }
    const client = createIngestedDaxClient({ store })
    const request = { queryName: 'capacitySummary', query: '', parameters: {} } as const
    await expect(client.execute(request)).rejects.toThrow('transient summary read')
    await expect(client.execute(request)).resolves.toEqual([{ CapacityId: 'cap-1' }])
    expect(attempts).toBe(2)
  })

  it('reports NotConfigured when the notebook has never completed a run', async () => {
    const client = createIngestedDaxClient({ store: new FakeStore(null) })

    await expect(
      client.execute({ queryName: 'cityItems', query: '', parameters: {} }),
    ).rejects.toMatchObject({ failure: 'NotConfigured' })
  })

  it('retries the run lookup after a failure instead of caching the rejection', async () => {
    // A held rejected promise would turn one transient network error into a permanently broken
    // client for the life of the page, with a reload the only way out.
    let attempts = 0
    const store: IngestStore = {
      async latestCompleteRun() {
        attempts += 1
        if (attempts === 1) throw new Error('transient')
        return run()
      },
      async readRows() {
        return []
      },
    }
    const client = createIngestedDaxClient({ store })

    await expect(client.execute({ queryName: 'cityItems', query: '', parameters: {} })).rejects.toThrow()
    await expect(client.execute({ queryName: 'cityItems', query: '', parameters: {} })).resolves.toEqual([])
    expect(attempts).toBe(2)
  })

  it('honours an already-aborted signal without touching the store', async () => {
    const store = new FakeStore(run(), [])
    const client = createIngestedDaxClient({ store })

    await expect(
      client.execute({
        queryName: 'cityItems',
        query: '',
        parameters: {},
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow()
    expect(store.runCalls).toBe(0)
  })
})

describe('ingestedCapabilities', () => {
  it('adds the schedule interval to the model lag rather than reporting the model lag alone', () => {
    const capabilities = ingestedCapabilities(60, 3)
    expect(capabilities.latencySeconds).toBe(SEMANTIC_MODEL_CAPABILITIES.latencySeconds + 3600)
    expect(capabilities.latencySeconds).toBeGreaterThan(SEMANTIC_MODEL_CAPABILITIES.latencySeconds)
  })

  it('reports the ingested window as retention, not the semantic model retention', () => {
    expect(ingestedCapabilities(60, 3).retentionDays).toBe(3)
  })

  it('keeps every other capability of the semantic model it replays', () => {
    const capabilities = ingestedCapabilities(60, 3)
    expect(capabilities.perItemBreakdown).toBe(SEMANTIC_MODEL_CAPABILITIES.perItemBreakdown)
    expect(capabilities.operationFamilies).toBe(SEMANTIC_MODEL_CAPABILITIES.operationFamilies)
    expect(capabilities.timepoints).toBe(SEMANTIC_MODEL_CAPABILITIES.timepoints)
    expect(capabilities.operationSamples).toBe(SEMANTIC_MODEL_CAPABILITIES.operationSamples)
  })

  it('clamps a nonsensical negative interval instead of reporting negative latency', () => {
    expect(ingestedCapabilities(-30, -1).latencySeconds).toBe(SEMANTIC_MODEL_CAPABILITIES.latencySeconds)
    expect(ingestedCapabilities(-30, -1).retentionDays).toBe(0)
  })
})

describe('createIngestedCapacitySource', () => {
  const tenant = { tenantId: 'tenant', displayName: 'Tenant' }

  it('presents itself as the semantic model, because that is where the rows came from', () => {
    const source = createIngestedCapacitySource({ store: new FakeStore(run()), tenant })
    expect(source.kind).toBe('SemanticModel')
  })

  it('applies the defaults the notebook is scheduled with', () => {
    const source = createIngestedCapacitySource({ store: new FakeStore(run()), tenant })
    expect(source.capabilities).toEqual(
      ingestedCapabilities(DEFAULT_INGEST_INTERVAL_MINUTES, DEFAULT_INGEST_WINDOW_DAYS),
    )
  })

  it('surfaces the missing-ingest case as a source error rather than an empty city', async () => {
    const source = createIngestedCapacitySource({ store: new FakeStore(null), tenant })
    await expect(source.readAtlas()).rejects.toBeInstanceOf(CapacitySourceError)
  })
})

/*
 * The round trip is the claim this whole design rests on: rows stored verbatim and replayed must
 * build the same city as rows read live. Everything above tests one half of that; this tests that
 * the halves meet. Without it a plausible-looking storage change could pass every other test here
 * and still produce a city that differs from the live one in ways nobody would look for.
 */
describe('a stored run replays into the same city the live transport builds', () => {
  const tenant = { tenantId: 'tenant', displayName: 'Tenant' }
  const NOW = new Date(Date.UTC(2026, 0, 8, 12, 20, 0))
  const OBSERVED = new Date(Date.UTC(2026, 0, 8, 12, 5, 0)).toISOString()
  const generation = SEMANTIC_MODEL_SCHEMA_GENERATIONS[1]

  const rowsByQuery: Partial<Record<SemanticModelQueryName, SemanticModelRow[]>> = {
    schemaProbe: Object.values(generation.columns).map((column) => ({
      TableName: generation.metricsByItemOperationAndDayTable,
      ColumnName: column,
    })),
    capacitySummary: [
      {
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
      },
    ],
    cityItems: [
      {
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
      },
    ],
    operationFamilies: [
      {
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
      },
    ],
  }

  /** Reads live, the way `npm run dev` does. */
  const liveClient = {
    async execute<T extends SemanticModelRow = SemanticModelRow>(request: {
      queryName: SemanticModelQueryName
    }): Promise<readonly T[]> {
      return (rowsByQuery[request.queryName] ?? []) as readonly T[]
    },
  }

  /**
   * Reads what the notebook would have written: the same rows, key-bracketed the way a DAX
   * transport hands them over, serialized to JSON, and stored against a run.
   */
  const storedRows: IngestRowRecord[] = Object.entries(rowsByQuery).flatMap(([queryName, rows]) =>
    rows.map((value, rowIndex) => ({
      queryName: queryName as SemanticModelQueryName,
      capacityId: queryName === 'cityItems' || queryName === 'operationFamilies' || queryName === 'timepoints'
        ? 'cap-1'
        : TENANT_WIDE_CAPACITY_ID,
      rowIndex,
      rowTimestamp: null,
      rowJson: JSON.stringify(
        Object.fromEntries(Object.entries(value).map(([key, cell]) => [`[${key}]`, cell])),
      ),
    })),
  )

  const replayStore: IngestStore = {
    async latestCompleteRun() {
      return run()
    },
    async readRows(query) {
      return storedRows.filter(
        (record) => record.queryName === query.queryName && record.capacityId === query.capacityId,
      )
    },
  }

  /**
   * `durationMilliseconds` is real wall clock on both sides, so it is the one field that cannot
   * match. Everything else must, including every derived number in the atlas and the city.
   */
  const settled = <T>(value: T): T =>
    JSON.parse(
      JSON.stringify(value, (key, cell: unknown) => (key === 'durationMilliseconds' ? 0 : cell)),
    ) as T

  it('produces an identical atlas', async () => {
    const live = createSemanticModelSource({ client: liveClient, tenant, now: () => NOW })
    const replayed = createIngestedCapacitySource({ store: replayStore, tenant, now: () => NOW })

    const replayedAtlas = await replayed.readAtlas()
    const liveAtlas = await live.readAtlas()

    expect(liveAtlas.capacities.length).toBeGreaterThan(0)
    expect(settled(replayedAtlas)).toEqual(settled(liveAtlas))
  })

  it('produces an identical city page, buildings and all', async () => {
    const live = createSemanticModelSource({ client: liveClient, tenant, now: () => NOW })
    const replayed = createIngestedCapacitySource({ store: replayStore, tenant, now: () => NOW })
    const request: CityPageRequest = {
      capacityId: 'cap-1',
      metric: 'Cu',
      pageSize: 50,
    }

    const replayedPage = await replayed.readCityPage(request)
    const livePage = await live.readCityPage(request)

    // Guards the comparison below against passing on two empty pages.
    expect(livePage.items.length).toBeGreaterThan(0)
    expect(livePage.topOperationFamilies.length).toBeGreaterThan(0)
    expect(settled(replayedPage)).toEqual(settled(livePage))
  })

  it('differs from the live source only in the freshness it declares', async () => {
    const live = createSemanticModelSource({ client: liveClient, tenant, now: () => NOW })
    const replayed = createIngestedCapacitySource({ store: replayStore, tenant, now: () => NOW })

    expect(replayed.capabilities.latencySeconds).toBeGreaterThan(live.capabilities.latencySeconds)
    expect({ ...replayed.capabilities, latencySeconds: 0, retentionDays: 0 }).toEqual({
      ...live.capabilities,
      latencySeconds: 0,
      retentionDays: 0,
    })
  })
})
