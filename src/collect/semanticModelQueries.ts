/*
 * DAX text for the Microsoft Fabric Capacity Metrics semantic-model source.
 *
 * This access path is explicitly unsupported by Microsoft and the model schema has already moved.
 * Keep every table and column assumption here so a real-tenant correction is a small reviewable
 * change, and so the source can probe the schema before it asks for numbers.
 */

export type SemanticModelQueryName =
  | 'schemaProbe'
  | 'capacitySummary'
  | 'cityItems'
  | 'operationFamilies'
  | 'timepoints'

export type SemanticModelSchemaGenerationName = 'metricsByItemOperationAndDay' | 'metricsByItemandOperationandDay'

export interface SemanticModelColumnMap {
  capacityId: string
  capacityName: string
  sku: string
  capacityUnits: string
  region: string
  capacityState: string
  stateReason: string
  observedAt: string
  workspaceId: string
  workspaceName: string
  itemId: string
  itemName: string
  itemKind: string
  operationName: string
  operationClass: string
  billingType: string
  cuSeconds: string
  storageBytes: string
  durationSeconds: string
  operationCount: string
  successfulOperationCount: string
  rejectedOperationCount: string
  failedOperationCount: string
  invalidOperationCount: string
  cancelledOperationCount: string
  distinctUsers: string
  throttlingSeconds: string
  performanceDeltaPercent: string
  interactiveBillablePercent: string
  backgroundBillablePercent: string
  interactiveNonBillablePercent: string
  backgroundNonBillablePercent: string
  interactiveDelayPercent: string
  interactiveRejectionPercent: string
  backgroundRejectionPercent: string
  cumulativeCarryOverPercent: string
  expectedBurndownMinutes: string
  surgeProtectionActive: string
}

export interface SemanticModelSchemaGeneration {
  name: SemanticModelSchemaGenerationName
  metricsByItemOperationAndDayTable: string
  columns: SemanticModelColumnMap
  requiredColumns: readonly (keyof SemanticModelColumnMap)[]
}

const LEGACY_COLUMNS: SemanticModelColumnMap = Object.freeze({
  capacityId: 'Capacity Id',
  capacityName: 'Capacity Name',
  sku: 'SKU',
  capacityUnits: 'Capacity Units',
  region: 'Region',
  capacityState: 'Capacity State',
  stateReason: 'State Reason',
  observedAt: 'Timepoint',
  workspaceId: 'Workspace Id',
  workspaceName: 'Workspace Name',
  itemId: 'Item Id',
  itemName: 'Item Name',
  itemKind: 'Item Kind',
  operationName: 'Operation Name',
  operationClass: 'Operation Type',
  billingType: 'Billing Type',
  cuSeconds: 'CU (s)',
  storageBytes: 'Storage Bytes',
  durationSeconds: 'Duration (s)',
  operationCount: 'Operation Count',
  successfulOperationCount: 'Succeeded Operation Count',
  rejectedOperationCount: 'Rejected Operation Count',
  failedOperationCount: 'Failed Operation Count',
  invalidOperationCount: 'Invalid Operation Count',
  cancelledOperationCount: 'Cancelled Operation Count',
  distinctUsers: 'Distinct Users',
  throttlingSeconds: 'Throttling (s)',
  performanceDeltaPercent: 'Performance Delta %',
  interactiveBillablePercent: 'Interactive Billable %',
  backgroundBillablePercent: 'Background Billable %',
  interactiveNonBillablePercent: 'Interactive Non-billable %',
  backgroundNonBillablePercent: 'Background Non-billable %',
  interactiveDelayPercent: 'Interactive Delay %',
  interactiveRejectionPercent: 'Interactive Rejection %',
  backgroundRejectionPercent: 'Background Rejection %',
  cumulativeCarryOverPercent: 'Cumulative Carryover %',
  expectedBurndownMinutes: 'Expected Burndown (min)',
  surgeProtectionActive: 'Surge Protection Active',
})

const CURRENT_COLUMNS: SemanticModelColumnMap = Object.freeze({
  capacityId: 'CapacityId',
  capacityName: 'CapacityName',
  sku: 'Sku',
  capacityUnits: 'CapacityUnits',
  region: 'Region',
  capacityState: 'CapacityState',
  stateReason: 'StateReason',
  observedAt: 'Timepoint',
  workspaceId: 'WorkspaceId',
  workspaceName: 'WorkspaceName',
  itemId: 'ItemId',
  itemName: 'ItemName',
  itemKind: 'ItemKind',
  operationName: 'OperationName',
  operationClass: 'OperationClass',
  billingType: 'BillingType',
  cuSeconds: 'CuSeconds',
  storageBytes: 'StorageBytes',
  durationSeconds: 'DurationSeconds',
  operationCount: 'OperationCount',
  successfulOperationCount: 'SuccessfulOperationCount',
  rejectedOperationCount: 'RejectedOperationCount',
  failedOperationCount: 'FailedOperationCount',
  invalidOperationCount: 'InvalidOperationCount',
  cancelledOperationCount: 'CancelledOperationCount',
  distinctUsers: 'DistinctUsers',
  throttlingSeconds: 'ThrottlingSeconds',
  performanceDeltaPercent: 'PerformanceDeltaPercent',
  interactiveBillablePercent: 'InteractiveBillablePercent',
  backgroundBillablePercent: 'BackgroundBillablePercent',
  interactiveNonBillablePercent: 'InteractiveNonBillablePercent',
  backgroundNonBillablePercent: 'BackgroundNonBillablePercent',
  interactiveDelayPercent: 'InteractiveDelayPercent',
  interactiveRejectionPercent: 'InteractiveRejectionPercent',
  backgroundRejectionPercent: 'BackgroundRejectionPercent',
  cumulativeCarryOverPercent: 'CumulativeCarryOverPercent',
  expectedBurndownMinutes: 'ExpectedBurndownMinutes',
  surgeProtectionActive: 'SurgeProtectionActive',
})

const REQUIRED_COLUMNS = Object.freeze([
  'capacityId',
  'observedAt',
  'workspaceId',
  'itemId',
  'itemKind',
  'operationName',
  'cuSeconds',
] as const satisfies readonly (keyof SemanticModelColumnMap)[])

export const SEMANTIC_MODEL_SCHEMA_GENERATIONS: readonly SemanticModelSchemaGeneration[] = Object.freeze([
  Object.freeze({
    name: 'metricsByItemOperationAndDay',
    metricsByItemOperationAndDayTable: 'Metrics By Item Operation And Day',
    columns: LEGACY_COLUMNS,
    requiredColumns: REQUIRED_COLUMNS,
  }),
  Object.freeze({
    name: 'metricsByItemandOperationandDay',
    metricsByItemOperationAndDayTable: 'MetricsByItemandOperationandDay',
    columns: CURRENT_COLUMNS,
    requiredColumns: REQUIRED_COLUMNS,
  }),
])

export const SEMANTIC_MODEL_SCHEMA_ASSUMPTIONS = Object.freeze({
  schemaProbe:
    'INFO.COLUMNS() is available to the transport and returns table/column names for the Capacity Metrics model.',
  generations: SEMANTIC_MODEL_SCHEMA_GENERATIONS,
  parameters:
    'The transport binds @Start, @End and @CapacityId values, or rewrites them safely before sending DAX.',
})

export interface SemanticModelQueries {
  schemaProbe: string
  capacitySummary: string
  cityItems: string
  operationFamilies: string
  timepoints: string
}

export function buildSemanticModelQueries(
  generation: SemanticModelSchemaGeneration,
  availableColumns: ReadonlySet<string>,
): SemanticModelQueries {
  const table = tableRef(generation.metricsByItemOperationAndDayTable)

  return {
    schemaProbe: SEMANTIC_MODEL_SCHEMA_PROBE_QUERY,
    capacitySummary: capacitySummaryQuery(table, generation.columns, availableColumns),
    cityItems: cityItemsQuery(table, generation.columns, availableColumns),
    operationFamilies: operationFamiliesQuery(table, generation.columns, availableColumns),
    timepoints: timepointsQuery(table, generation.columns, availableColumns),
  }
}

export const SEMANTIC_MODEL_SCHEMA_PROBE_QUERY = `EVALUATE
SELECTCOLUMNS(
  INFO.COLUMNS(),
  "TableName", [Table],
  "ColumnName", [Name]
)`

function capacitySummaryQuery(
  table: string,
  columns: SemanticModelColumnMap,
  availableColumns: ReadonlySet<string>,
): string {
  const groups = [
    columnRef(table, columns.capacityId),
    optionalGroup(table, columns.capacityName, availableColumns),
    optionalGroup(table, columns.sku, availableColumns),
    optionalGroup(table, columns.capacityUnits, availableColumns),
    optionalGroup(table, columns.region, availableColumns),
    optionalGroup(table, columns.capacityState, availableColumns),
    optionalGroup(table, columns.stateReason, availableColumns),
  ].filter((value): value is string => value !== null)

  return withWindowFilter(table, columns, `EVALUATE
SUMMARIZECOLUMNS(
${indent(groups.join(',\n'), 2)},
  "__TotalCuSeconds", SUM(${columnRef(table, columns.cuSeconds)}),
  "__StorageBytes", ${optionalSum(table, columns.storageBytes, availableColumns)},
  "__ObservedAt", MAX(${columnRef(table, columns.observedAt)}),
  "__MeanUtilizationPercent", AVERAGE(${columnRef(table, columns.interactiveBillablePercent)}),
  "__PeakUtilizationPercent", MAX(${columnRef(table, columns.interactiveBillablePercent)}),
  "__WorkspaceCount", DISTINCTCOUNT(${columnRef(table, columns.workspaceId)}),
  "__ItemCount", DISTINCTCOUNT(${columnRef(table, columns.itemId)}),
  "__InteractiveDelayPercent", ${optionalMax(table, columns.interactiveDelayPercent, availableColumns)},
  "__InteractiveRejectionPercent", ${optionalMax(table, columns.interactiveRejectionPercent, availableColumns)},
  "__BackgroundRejectionPercent", ${optionalMax(table, columns.backgroundRejectionPercent, availableColumns)},
  "__CumulativeCarryOverPercent", ${optionalMax(table, columns.cumulativeCarryOverPercent, availableColumns)},
  "__ExpectedBurndownMinutes", ${optionalMax(table, columns.expectedBurndownMinutes, availableColumns)},
  "__SurgeProtectionActive", ${optionalMax(table, columns.surgeProtectionActive, availableColumns)}
)
ORDER BY ${columnRef(table, columns.capacityId)}`)
}

function cityItemsQuery(
  table: string,
  columns: SemanticModelColumnMap,
  availableColumns: ReadonlySet<string>,
): string {
  const groups = [
    columnRef(table, columns.capacityId),
    columnRef(table, columns.workspaceId),
    optionalGroup(table, columns.workspaceName, availableColumns),
    columnRef(table, columns.itemId),
    optionalGroup(table, columns.itemName, availableColumns),
    columnRef(table, columns.itemKind),
  ].filter((value): value is string => value !== null)

  return withCapacityAndWindowFilter(table, columns, `EVALUATE
SUMMARIZECOLUMNS(
${indent(groups.join(',\n'), 2)},
  "__CuSeconds", SUM(${columnRef(table, columns.cuSeconds)}),
  "__StorageBytes", ${optionalSum(table, columns.storageBytes, availableColumns)},
  "__DurationSeconds", ${optionalSum(table, columns.durationSeconds, availableColumns)},
  "__OperationCount", ${optionalSum(table, columns.operationCount, availableColumns)},
  "__SuccessfulOperationCount", ${optionalSum(table, columns.successfulOperationCount, availableColumns)},
  "__RejectedOperationCount", ${optionalSum(table, columns.rejectedOperationCount, availableColumns)},
  "__FailedOperationCount", ${optionalSum(table, columns.failedOperationCount, availableColumns)},
  "__InvalidOperationCount", ${optionalSum(table, columns.invalidOperationCount, availableColumns)},
  "__CancelledOperationCount", ${optionalSum(table, columns.cancelledOperationCount, availableColumns)},
  "__DistinctUsers", ${optionalMax(table, columns.distinctUsers, availableColumns)},
  "__ThrottlingSeconds", ${optionalSum(table, columns.throttlingSeconds, availableColumns)},
  "__PerformanceDeltaPercent", ${optionalMax(table, columns.performanceDeltaPercent, availableColumns)},
  "__ObservedAt", MAX(${columnRef(table, columns.observedAt)})
)
ORDER BY ${columnRef(table, columns.workspaceId)}, ${columnRef(table, columns.itemId)}`)
}

function operationFamiliesQuery(
  table: string,
  columns: SemanticModelColumnMap,
  availableColumns: ReadonlySet<string>,
): string {
  const groups = [
    columnRef(table, columns.workspaceId),
    columnRef(table, columns.itemId),
    columnRef(table, columns.operationName),
    optionalGroup(table, columns.operationClass, availableColumns),
    optionalGroup(table, columns.billingType, availableColumns),
  ].filter((value): value is string => value !== null)

  return withCapacityAndWindowFilter(table, columns, `EVALUATE
SUMMARIZECOLUMNS(
${indent(groups.join(',\n'), 2)},
  "__CuSeconds", SUM(${columnRef(table, columns.cuSeconds)}),
  "__DurationSeconds", ${optionalSum(table, columns.durationSeconds, availableColumns)},
  "__OperationCount", ${optionalSum(table, columns.operationCount, availableColumns)},
  "__SuccessfulOperationCount", ${optionalSum(table, columns.successfulOperationCount, availableColumns)},
  "__RejectedOperationCount", ${optionalSum(table, columns.rejectedOperationCount, availableColumns)},
  "__FailedOperationCount", ${optionalSum(table, columns.failedOperationCount, availableColumns)},
  "__InvalidOperationCount", ${optionalSum(table, columns.invalidOperationCount, availableColumns)},
  "__CancelledOperationCount", ${optionalSum(table, columns.cancelledOperationCount, availableColumns)},
  "__DistinctUsers", ${optionalMax(table, columns.distinctUsers, availableColumns)},
  "__ThrottlingSeconds", ${optionalSum(table, columns.throttlingSeconds, availableColumns)},
  "__ObservedAt", MAX(${columnRef(table, columns.observedAt)})
)
ORDER BY ${columnRef(table, columns.itemId)}, ${columnRef(table, columns.operationName)}`)
}

function timepointsQuery(
  table: string,
  columns: SemanticModelColumnMap,
  availableColumns: ReadonlySet<string>,
): string {
  const groups = [
    columnRef(table, columns.observedAt),
    optionalGroup(table, columns.sku, availableColumns),
    optionalGroup(table, columns.capacityUnits, availableColumns),
  ].filter((value): value is string => value !== null)

  return withCapacityAndWindowFilter(table, columns, `EVALUATE
SUMMARIZECOLUMNS(
${indent(groups.join(',\n'), 2)},
  "__InteractiveBillablePercent", ${optionalMax(table, columns.interactiveBillablePercent, availableColumns)},
  "__BackgroundBillablePercent", ${optionalMax(table, columns.backgroundBillablePercent, availableColumns)},
  "__InteractiveNonBillablePercent", ${optionalMax(table, columns.interactiveNonBillablePercent, availableColumns)},
  "__BackgroundNonBillablePercent", ${optionalMax(table, columns.backgroundNonBillablePercent, availableColumns)},
  "__InteractiveDelayPercent", ${optionalMax(table, columns.interactiveDelayPercent, availableColumns)},
  "__InteractiveRejectionPercent", ${optionalMax(table, columns.interactiveRejectionPercent, availableColumns)},
  "__BackgroundRejectionPercent", ${optionalMax(table, columns.backgroundRejectionPercent, availableColumns)},
  "__CumulativeCarryOverPercent", ${optionalMax(table, columns.cumulativeCarryOverPercent, availableColumns)},
  "__ExpectedBurndownMinutes", ${optionalMax(table, columns.expectedBurndownMinutes, availableColumns)}
)
ORDER BY ${columnRef(table, columns.observedAt)}`)
}

function withWindowFilter(table: string, columns: SemanticModelColumnMap, body: string): string {
  return `DEFINE
  VAR __Window = FILTER(${table}, ${columnRef(table, columns.observedAt)} >= @Start && ${columnRef(table, columns.observedAt)} < @End)
${body.replaceAll(table, '__Window')}`
}

function withCapacityAndWindowFilter(table: string, columns: SemanticModelColumnMap, body: string): string {
  return `DEFINE
  VAR __Window = FILTER(
    ${table},
    ${columnRef(table, columns.capacityId)} = @CapacityId &&
    ${columnRef(table, columns.observedAt)} >= @Start &&
    ${columnRef(table, columns.observedAt)} < @End
  )
${body.replaceAll(table, '__Window')}`
}

function optionalGroup(table: string, column: string, availableColumns: ReadonlySet<string>): string | null {
  return availableColumns.has(column) ? columnRef(table, column) : null
}

function optionalSum(table: string, column: string, availableColumns: ReadonlySet<string>): string {
  return availableColumns.has(column) ? `SUM(${columnRef(table, column)})` : 'BLANK()'
}

function optionalMax(table: string, column: string, availableColumns: ReadonlySet<string>): string {
  return availableColumns.has(column) ? `MAX(${columnRef(table, column)})` : 'BLANK()'
}

function tableRef(table: string): string {
  return `'${table.replaceAll("'", "''")}'`
}

function columnRef(table: string, column: string): string {
  return `${table}[${column.replaceAll(']', ']]')}]`
}

function indent(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces)
  return value.split('\n').map((line) => `${prefix}${line}`).join('\n')
}
