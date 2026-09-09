import { describe, expect, it } from 'vitest'
import { buildDaxManifest } from './daxManifest'
import { exportedMetricsProbe, exportedMetricsSchema } from './metricsDailySchema.testkit'
import {
  buildSemanticModelQueries, matchesSemanticModelSchema, SEMANTIC_MODEL_SCHEMA_GENERATIONS,
  type SemanticModelQueryName,
} from './semanticModelQueries'
import {
  createSemanticModelSource, type SemanticModelDaxClient, type SemanticModelDaxRequest, type SemanticModelRow,
} from './semanticModelSource'
import { createIngestedCapacitySource, type IngestStore } from './ingestedDax'
import { bindDaxParameters } from './semanticModelDaxClient'

const tables = new Map(Object.entries(exportedMetricsSchema).map(([name, columns]) => [name, new Set(columns)]))
const generation = SEMANTIC_MODEL_SCHEMA_GENERATIONS.find((entry) => entry.name === 'metricsDailyWithDimensions')!
const queries = buildSemanticModelQueries(generation, tables.get(generation.metricsByItemOperationAndDayTable)!)

describe('the exported daily Capacity Metrics schema', () => {
  it('binds the capacity list and region at the DirectQuery source, not just as row filters', () => {
    for (const query of [queries.capacitySummary, queries.cityItems, queries.operationFamilies]) {
      expect(query).toContain("MPARAMETER 'CapacitiesList' = { @CapacityId }")
      expect(query).toContain("MPARAMETER 'RegionName' = @RegionName")
      expect(query.match(/\bDEFINE\b/g)).toHaveLength(1)
    }
  })

  it('discovers capacity routing from imported metadata without querying unbound facts', () => {
    expect(queries.capacityInventory).toContain("'Capacities'[Region without default]")
    expect(queries.capacityInventory).not.toContain("'Metrics By Item Operation And Day'")
    expect(queries.capacityInventory).not.toContain('MPARAMETER')
    expect(queries.capacityInventory).not.toContain('@')
  })

  it('does not interpret a DirectQuery empty-table SUM of zero as measured usage', () => {
    expect(queries.capacitySummary).toContain("IF(COUNTROWS('Metrics By Item Operation And Day') > 0,")
    expect(queries.capacitySummary).toContain("SUM('Metrics By Item Operation And Day'[CU (s)]), BLANK())")
  })

  it('returns explicit UTC observations rather than transport-dependent naive datetimes', () => {
    for (const query of [queries.capacitySummary, queries.cityItems, queries.operationFamilies]) {
      expect(query).toContain('IF(ISBLANK(__Timestamp), BLANK(),')
      expect(query).toContain('FORMAT(__Timestamp, "hh:nn:ss", "en-US") & "Z"')
    }
  })

  it('matches the real fact plus dimensions rather than either assumed flat shape', () => {
    expect(SEMANTIC_MODEL_SCHEMA_GENERATIONS.filter((entry) => matchesSemanticModelSchema(entry, tables))
      .map((entry) => entry.name)).toEqual(['metricsDailyWithDimensions'])
  })

  it('requires dimension fields instead of accepting only a familiar fact table name', () => {
    for (const [table, required] of Object.entries(generation.requiredTables!)) {
      for (const column of required) {
        const incomplete = new Map(tables)
        incomplete.set(table, new Set([...tables.get(table)!].filter((entry) => entry !== column)))
        expect(matchesSemanticModelSchema(generation, incomplete), `${table}[${column}]`).toBe(false)
      }
    }
  })

  it('references only physical fields present in the supplied export', () => {
    for (const query of Object.values(queries).filter((value) => value !== queries.schemaProbe)) {
      const refs = [...query.matchAll(/'([^']+)'\[([^\]]+)\]/g)]
      if (query !== queries.timepoints) expect(refs.length).toBeGreaterThan(0)
      for (const [, table, column] of refs) {
        expect(exportedMetricsSchema[table], table).toBeDefined()
        expect(exportedMetricsSchema[table], `${table}[${column}]`).toContain(column)
      }
    }
  })

  it('filters physical fact columns without treating a table variable as a model table', () => {
    for (const entry of SEMANTIC_MODEL_SCHEMA_GENERATIONS) {
      const built = buildSemanticModelQueries(entry, new Set(Object.values(entry.columns)))
      for (const name of ['capacitySummary', 'cityItems', 'operationFamilies', 'timepoints'] as const) {
        if (entry.unavailableQueries?.includes(name)) continue
        expect(built[name]).not.toMatch(/__Window\s*\[/)
        expect(built[name]).toContain('>= @Start')
        expect(built[name]).toContain('< @End')
        expect(built[name]).toMatch(/__Window\s*[,)]/)
        if (name !== 'capacitySummary') expect(built[name]).toContain('= @CapacityId')
      }
    }
  })

  it('converts measured throttling minutes to the parser seconds contract exactly once', () => {
    for (const query of [queries.cityItems, queries.operationFamilies]) {
      expect(query).toContain('"__ThrottlingSeconds", 60 * SUM(')
      expect(query).toContain('[Throttling (min)]')
      expect(query).toContain('"ThrottlingSeconds", [__ThrottlingSeconds]')
    }
  })

  it('keeps totals at the fact grain and uses capacity/workspace/item keys for metadata only', () => {
    expect(queries.cityItems).toMatch(/SUMMARIZECOLUMNS\([\s\S]*__Window,[\s\S]*SUM\(/)
    expect(queries.cityItems).toContain("'Items'[Capacity Id], 'Metrics By Item Operation And Day'[Capacity Id]")
    expect(queries.cityItems).toContain("'Items'[Workspace Id], 'Metrics By Item Operation And Day'[Workspace Id]")
    expect(queries.cityItems).toContain("'Items'[Item Id], 'Metrics By Item Operation And Day'[Item Id], BLANK())")
    expect(queries.operationFamilies).toContain('"OperationName",')
    expect(queries.operationFamilies).toContain('[Operation name]')
    expect(queries.capacitySummary).toContain('RETURN CALCULATE(')
    expect(queries.capacitySummary).toContain('[Capacity Id] = __Capacity)')
  })

  it('preserves absent evidence and does not turn daily totals into live utilization', () => {
    expect(queries.capacitySummary).toContain('SUMMARIZE(\'Capacities\'')
    expect(queries.capacitySummary).toContain('"TotalCuSeconds",')
    expect(queries.capacitySummary).not.toContain('COALESCE(')
    expect(queries.capacitySummary).toContain('"MeanUtilizationPercent", BLANK()')
    expect(queries.capacitySummary).toContain('"PeakUtilizationPercent", BLANK()')
    expect(queries.cityItems).toContain('"StorageBytes", BLANK()')
    expect(queries.cityItems).toContain('"DistinctUsers", BLANK()')
    expect(queries.operationFamilies).toContain('"OperationClass", BLANK()')
    expect(queries.timepoints).toBe('EVALUATE FILTER(ROW("Timepoint", BLANK()), FALSE())')
    expect(queries.capacitySummary).toContain('"WindowStart", FORMAT(CEILING(@Start, 1), "yyyy-mm-dd", "en-US") & "T00:00:00Z"')
    expect(queries.capacitySummary).toContain('"WindowEnd", FORMAT(@End, "yyyy-mm-dd", "en-US") & "T" & FORMAT(@End, "hh:nn:ss", "en-US") & "Z"')
  })

  it('publishes the multi-table contract and output aliases to the notebook', () => {
    const entry = buildDaxManifest().generations.find((item) => item.name === generation.name)!
    expect(entry.requiredTables).toEqual(generation.requiredTables)
    expect(entry.capacityIdColumn).toBe('CapacityId')
    expect(entry.timestampColumn).toBe('Timepoint')
    expect(entry.unavailableQueries).toEqual(['timepoints'])
  })
})

const observed = '2026-09-09T00:00:00Z'
const samples: Record<SemanticModelQueryName, SemanticModelRow[]> = {
  schemaProbe: exportedMetricsProbe,
  capacitySummary: [{
    CapacityId: 'cap', CapacityName: 'Capacity', Sku: 'F64', Region: 'westus', CapacityState: 'Active',
    TotalCuSeconds: 750, ObservedAt: observed, WindowStart: '2026-09-07T00:00:00Z',
    WindowEnd: '2026-09-09T15:00:00Z', StorageBytes: null, MeanUtilizationPercent: null,
    PeakUtilizationPercent: null,
  }, {
    CapacityId: 'paused', CapacityName: 'Paused', Sku: 'F2', Region: 'eastus', CapacityState: 'Suspended',
    TotalCuSeconds: null, ObservedAt: null,
  }],
  cityItems: [{
    CapacityId: 'cap', WorkspaceId: 'workspace', WorkspaceName: 'Workspace', ItemId: 'item',
    ItemName: 'Notebook', ItemKind: 'Notebook', CuSeconds: 750, DurationSeconds: 30,
    OperationCount: 4, SuccessfulOperationCount: 3, RejectedOperationCount: 1,
    ThrottlingSeconds: 150, ObservedAt: observed, StorageBytes: null, DistinctUsers: null,
  }],
  operationFamilies: [{
    WorkspaceId: 'workspace', ItemId: 'item', OperationName: 'Execute', CuSeconds: 750,
    DurationSeconds: 30, OperationCount: 4, ThrottlingSeconds: 150, ObservedAt: observed,
    OperationClass: null, BillingType: null,
  }],
  timepoints: [],
}

describe('daily metrics through the existing parser and SQL replay', () => {
  it('rejects absent routing metadata instead of sending an unbound query', async () => {
    const client: SemanticModelDaxClient = {
      async execute<T extends SemanticModelRow>(request: SemanticModelDaxRequest) {
        bindDaxParameters(request.query, request.parameters)
        if (request.queryName === 'schemaProbe') return samples.schemaProbe as T[]
        expect(request.query).toBe(queries.capacityInventory)
        const inventory: SemanticModelRow[] = [{ CapacityId: 'cap' }]
        return inventory as T[]
      },
    }
    const source = createSemanticModelSource({ client, tenant: { tenantId: 'tenant', displayName: 'Tenant' } })
    await expect(source.readAtlas()).rejects.toThrow('@RegionName')
  })

  it('rejects a summary for the wrong capacity rather than relabeling its measurements', async () => {
    const client: SemanticModelDaxClient = {
      async execute<T extends SemanticModelRow>(request: SemanticModelDaxRequest) {
        if (request.queryName === 'schemaProbe') return samples.schemaProbe as T[]
        const rows: SemanticModelRow[] = request.query === queries.capacityInventory
          ? [{ CapacityId: 'cap', Region: 'West US' }]
          : [{ CapacityId: 'another-capacity', Region: 'West US', TotalCuSeconds: 100 }]
        return rows as T[]
      },
    }
    const source = createSemanticModelSource({ client, tenant: { tenantId: 'tenant', displayName: 'Tenant' } })
    await expect(source.readAtlas()).rejects.toThrow('did not return exactly capacity cap')
  })

  function sources() {
    const calls: SemanticModelQueryName[] = []
    const client: SemanticModelDaxClient = {
      async execute<T extends SemanticModelRow>(request: SemanticModelDaxRequest) {
        calls.push(request.queryName)
        if (request.query === queries.capacityInventory) {
          return samples.capacitySummary.map<SemanticModelRow>(({ CapacityId, CapacityName, Sku, Region, CapacityState }) =>
            ({ CapacityId, CapacityName, Sku, Region, CapacityState })) as T[]
        }
        if (request.queryName === 'capacitySummary') {
          expect(request.parameters.RegionName).toBe(request.parameters.CapacityId === 'cap' ? 'westus' : 'eastus')
          return samples.capacitySummary.filter((row) => row.CapacityId === request.parameters.CapacityId) as T[]
        }
        if (request.queryName === 'cityItems' || request.queryName === 'operationFamilies') {
          expect(request.parameters.RegionName).toBe('westus')
        }
        return samples[request.queryName] as T[]
      },
    }
    const store: IngestStore = {
      async latestCompleteRun() {
        return {
          id: 'run', tenantId: 'tenant', datasetId: 'model', schemaGeneration: generation.name,
          status: 'Complete', startedAt: observed, windowStart: observed, windowEnd: observed, rowCount: 1,
        }
      },
      async readRows(query) {
        calls.push(query.queryName)
        return samples[query.queryName].map((row, rowIndex) => ({
          queryName: query.queryName, capacityId: query.capacityId, rowIndex,
          rowJson: JSON.stringify(Object.fromEntries(Object.entries(row).map(([key, value]) => [`[${key}]`, value]))),
        }))
      },
    }
    const common = { tenant: { tenantId: 'tenant', displayName: 'Tenant' }, now: () => new Date('2026-09-09T15:00:00Z') }
    return {
      live: createSemanticModelSource({ client, ...common }),
      replay: createIngestedCapacitySource({ store, ...common }),
      calls,
    }
  }

  it('replays populated cities with matching identities, CU and throttling units', async () => {
    const { live, replay } = sources()
    const request = { capacityId: 'cap', metric: 'Cu', pageSize: 50 } as const
    const page = await replay.readCityPage(request)
    expect(page).toEqual(await live.readCityPage(request))
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      itemId: 'item', workspaceId: 'workspace', kind: 'Notebook',
      throttlingMinutes: 2.5, cuConsumed: { cuSeconds: '750', status: 'Known' },
      storage: { bytes: null, status: 'Unknown' },
    })
    expect(page.topOperationFamilies).toHaveLength(1)
    expect(page.topOperationFamilies[0]).toMatchObject({ throttlingSeconds: 150, operationClass: 'Unknown' })
    expect(page.window).toEqual({ start: '2026-09-07T00:00:00.000Z', end: '2026-09-09T15:00:00.000Z' })
  })

  it('keeps capacity metadata with missing consumption and disables the unsupported clock', async () => {
    const { live, replay, calls } = sources()
    for (const source of [live, replay]) {
      const atlas = await source.readAtlas()
      expect(atlas.capacities.find((capacity) => capacity.capacityId === 'paused')).toMatchObject({
        state: 'Suspended', cuConsumed: { cuSeconds: null, status: 'Unknown' },
      })
      expect(source.capabilities.timepoints).toBe(false)
      expect(await source.readTimepoints({ capacityId: 'cap', start: observed, end: observed })).toEqual([])
      await expect(source.readTimepoints({
        capacityId: 'cap', start: observed, end: observed, signal: AbortSignal.abort(),
      })).rejects.toMatchObject({ name: 'AbortError' })
    }
    expect(calls).not.toContain('timepoints')
    expect(replay.capabilities.latencySeconds).toBe(4500)
  })
})
