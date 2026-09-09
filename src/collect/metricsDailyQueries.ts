import type { SemanticModelQueries } from './semanticModelQueries.ts'

// The exported model is a fact table plus dimensions, not a flattened telemetry table.
export const METRICS_DAILY_TABLE = 'Metrics By Item Operation And Day'
export const METRICS_DAILY_REQUIRED_TABLES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [METRICS_DAILY_TABLE]: [
    'Capacity Id', 'Workspace Id', 'Item Id', 'Operation name', 'Datetime', 'CU (s)',
    'Duration (s)', 'Operations', 'Successful operations', 'Rejected operations',
    'Failed operations', 'Invalid operations', 'Cancelled operations', 'Throttling (min)',
  ],
  Capacities: ['Capacity Id', 'Capacity name', 'SKU', 'Region without default', 'State'],
  Items: ['Capacity Id', 'Workspace Id', 'Item Id', 'Item name', 'Item kind', 'Workspace name'],
})

const FACT = `'${METRICS_DAILY_TABLE}'`
const fact = (column: string) => `${FACT}[${column}]`

const CAPACITY_GROUP = `SUMMARIZE('Capacities', 'Capacities'[Capacity Id], 'Capacities'[Capacity name],
    'Capacities'[SKU], 'Capacities'[Region without default], 'Capacities'[State])`
const CAPACITY_FIELDS = `"CapacityId", 'Capacities'[Capacity Id],
  "CapacityName", 'Capacities'[Capacity name],
  "Sku", 'Capacities'[SKU],
  "Region", 'Capacities'[Region without default],
  "CapacityState", 'Capacities'[State]`

function windowDefinition(): string {
  // DirectQuery needs source routing as well as DAX filters; an unbound source returns no facts.
  return `DEFINE
  MPARAMETER 'CapacitiesList' = { @CapacityId }
  MPARAMETER 'RegionName' = @RegionName
  VAR __Window = FILTER(
    ${FACT},
    ${fact('Capacity Id')} = @CapacityId &&
    ${fact('Datetime')} >= @Start &&
    ${fact('Datetime')} < @End
  )`
}

function capacityMetric(expression: string): string {
  // Explicitly filter the fact key: the metadata export does not describe relationships.
  return `VAR __Capacity = 'Capacities'[Capacity Id]
    RETURN CALCULATE(IF(COUNTROWS(${FACT}) > 0, ${expression}, BLANK()),
      __Window, ${fact('Capacity Id')} = __Capacity)`
}

function utcTimestamp(expression: string): string {
  return `VAR __Timestamp = ${expression}
    RETURN IF(ISBLANK(__Timestamp), BLANK(),
      FORMAT(__Timestamp, "yyyy-mm-dd", "en-US") & "T" & FORMAT(__Timestamp, "hh:nn:ss", "en-US") & "Z")`
}

function itemLookup(column: string): string {
  // Multiple historical names/kinds are ambiguous, not a reason to pick MAX or the first row.
  return `LOOKUPVALUE('Items'[${column}],
    'Items'[Capacity Id], ${fact('Capacity Id')},
    'Items'[Workspace Id], ${fact('Workspace Id')},
    'Items'[Item Id], ${fact('Item Id')}, BLANK())`
}

const TOTALS: Readonly<Record<string, string>> = {
  CuSeconds: `SUM(${fact('CU (s)')})`,
  DurationSeconds: `SUM(${fact('Duration (s)')})`,
  OperationCount: `SUM(${fact('Operations')})`,
  SuccessfulOperationCount: `SUM(${fact('Successful operations')})`,
  RejectedOperationCount: `SUM(${fact('Rejected operations')})`,
  FailedOperationCount: `SUM(${fact('Failed operations')})`,
  InvalidOperationCount: `SUM(${fact('Invalid operations')})`,
  CancelledOperationCount: `SUM(${fact('Cancelled operations')})`,
  ThrottlingSeconds: `60 * SUM(${fact('Throttling (min)')})`,
  ObservedAt: `MAX(${fact('Datetime')})`,
}

function itemsQuery(operations: boolean): string {
  const keys: Record<string, string> = {
    CapacityId: 'Capacity Id',
    WorkspaceId: 'Workspace Id',
    ItemId: 'Item Id',
    ...(operations ? { OperationName: 'Operation name' } : {}),
  }
  const fields = [
    ...Object.entries(keys).map(([alias, column]) => `"${alias}", ${fact(column)}`),
    ...Object.keys(TOTALS).map((alias) =>
      `"${alias}", ${alias === 'ObservedAt' ? utcTimestamp('[__ObservedAt]') : `[__${alias}]`}`),
    '"DistinctUsers", BLANK()',
    ...(operations
      ? ['"OperationClass", BLANK()', '"BillingType", BLANK()']
      : [
          `"WorkspaceName", ${itemLookup('Workspace name')}`,
          `"ItemName", ${itemLookup('Item name')}`,
          `"ItemKind", ${itemLookup('Item kind')}`,
          '"StorageBytes", BLANK()',
          '"PerformanceDeltaPercent", BLANK()',
        ]),
  ]
  return `${windowDefinition()}
  VAR __Totals = SUMMARIZECOLUMNS(
    ${Object.values(keys).map(fact).join(',\n    ')},
    __Window,
    ${Object.entries(TOTALS).map(([alias, expression]) => `"__${alias}", ${expression}`).join(',\n    ')}
  )
EVALUATE
SELECTCOLUMNS(
  __Totals,
  ${fields.join(',\n  ')}
)
ORDER BY [WorkspaceId], [ItemId]${operations ? ', [OperationName]' : ''}`
}

export function buildMetricsDailyQueries(schemaProbe: string): SemanticModelQueries {
  return {
    schemaProbe,
    capacityInventory: `EVALUATE
SELECTCOLUMNS(
  ${CAPACITY_GROUP},
  ${CAPACITY_FIELDS}
)
ORDER BY [CapacityId]`,
    capacitySummary: `${windowDefinition()}
EVALUATE
SELECTCOLUMNS(
  FILTER(${CAPACITY_GROUP}, 'Capacities'[Capacity Id] = @CapacityId),
  ${CAPACITY_FIELDS},
  "TotalCuSeconds", ${capacityMetric(`SUM(${fact('CU (s)')})`)},
  "ObservedAt", ${capacityMetric(utcTimestamp(`MAX(${fact('Datetime')})`))},
  "WorkspaceCount", ${capacityMetric(`DISTINCTCOUNT(${fact('Workspace Id')})`)},
  "ItemCount", ${capacityMetric(`DISTINCTCOUNT(${fact('Item Id')})`)},
  "WindowStart", FORMAT(CEILING(@Start, 1), "yyyy-mm-dd", "en-US") & "T00:00:00Z",
  "WindowEnd", FORMAT(@End, "yyyy-mm-dd", "en-US") & "T" & FORMAT(@End, "hh:nn:ss", "en-US") & "Z",
  "StorageBytes", BLANK(),
  "MeanUtilizationPercent", BLANK(),
  "PeakUtilizationPercent", BLANK()
)
ORDER BY [CapacityId]`,
    cityItems: itemsQuery(false),
    operationFamilies: itemsQuery(true),
    // CU Detail has no capacity key in the export. Daily aggregates are not 30-second samples.
    timepoints: 'EVALUATE FILTER(ROW("Timepoint", BLANK()), FALSE())',
  }
}
