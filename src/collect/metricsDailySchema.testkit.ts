// Table/column names from the operator's 2026-09-09 INFO.VIEW.COLUMNS export.
// Only the three tables queried by this adapter are retained; there are no tenant data rows.
export const exportedMetricsSchema: Readonly<Record<string, readonly string[]>> = {
  'Metrics By Item Operation And Day': [
    'Avg duration (ms)', 'CU (s)', 'Cancelled operations', 'Capacity Id', 'Date', 'Datetime',
    'Duration (s)', 'Failed operations', 'Inprogress operations', 'Invalid operations',
    'Item Id', 'Operation name', 'Operations', 'Percentile duration (ms) 50',
    'Percentile duration (ms) 90', 'Rejected operations', 'Stopped operations',
    'Successful operations', 'Throttling (min)', 'Unique key', 'Users', 'Workspace Id',
  ],
  Capacities: [
    'Capacity Id', 'Capacity name', 'Owners', 'Region', 'Region without default',
    'SKU', 'Source', 'State', 'Uppercase capacity Id',
  ],
  Items: [
    'Billable type', 'Capacity Id', 'Is virtual  item status', 'Is virtual workspace status',
    'Item Id', 'Item key', 'Item kind', 'Item name', 'Timestamp', 'Unique key', 'Users',
    'Virtualised item', 'Virtualised workspace', 'Workspace Id', 'Workspace name',
  ],
}

export const exportedMetricsProbe = Object.entries(exportedMetricsSchema).flatMap(([table, columns]) =>
  columns.map((column) => ({ TableName: table, ColumnName: column })),
)
