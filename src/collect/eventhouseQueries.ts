/*
 * KQL text for the Eventhouse capacity source.
 *
 * Real-Time Hub capacity events are the supported live feed, but this repository has no Fabric
 * tenant to verify the exact Eventhouse table and column names against. Keep every schema
 * assumption in this file so correcting a deployed tenant's shape is a small, reviewable change.
 */

export const EVENTHOUSE_DEFAULT_CAPACITY_EVENTS_TABLE = 'FabricCapacityEvents'

export const EVENTHOUSE_SCHEMA_ASSUMPTIONS = Object.freeze({
  capacityEventsTable: EVENTHOUSE_DEFAULT_CAPACITY_EVENTS_TABLE,
  optionalTopologyTable:
    'If an operator lands Fabric REST topology in KQL, it must expose the columns used by cityTopology.',
  columns: Object.freeze({
    timepoint: 'Timepoint',
    capacityId: 'CapacityId',
    capacityName: 'CapacityName',
    sku: 'Sku',
    capacityUnits: 'CapacityUnits',
    region: 'Region',
    capacityState: 'CapacityState',
    stateReason: 'StateReason',
    cuSeconds: 'CuSeconds',
    utilizationPercent: 'UtilizationPercent',
    interactiveBillablePercent: 'InteractiveBillablePercent',
    backgroundBillablePercent: 'BackgroundBillablePercent',
    interactiveNonBillablePercent: 'InteractiveNonBillablePercent',
    backgroundNonBillablePercent: 'BackgroundNonBillablePercent',
    interactiveDelayPercent: 'InteractiveDelayPercent',
    interactiveRejectionPercent: 'InteractiveRejectionPercent',
    backgroundRejectionPercent: 'BackgroundRejectionPercent',
    carryOverAddPercent: 'CarryOverAddPercent',
    carryOverBurndownPercent: 'CarryOverBurndownPercent',
    cumulativeCarryOverPercent: 'CumulativeCarryOverPercent',
    expectedBurndownMinutes: 'ExpectedBurndownMinutes',
    surgeProtectionActive: 'SurgeProtectionActive',
    topologyObservedAt: 'ObservedAt',
    workspaceId: 'WorkspaceId',
    workspaceName: 'WorkspaceName',
    itemId: 'ItemId',
    itemName: 'ItemName',
    itemType: 'ItemType',
  }),
})

export interface EventhouseQueryOptions {
  capacityEventsTable?: string
  capacityTopologyTable?: string | null
}

export interface EventhouseQueries {
  capacitySummary: string
  timepoints: string
  cityTopology: string | null
}

export function buildEventhouseQueries(options: EventhouseQueryOptions = {}): EventhouseQueries {
  const events = kqlIdentifier(
    options.capacityEventsTable ?? EVENTHOUSE_DEFAULT_CAPACITY_EVENTS_TABLE,
    'capacity events table',
  )
  const topology =
    options.capacityTopologyTable === undefined || options.capacityTopologyTable === null
      ? null
      : kqlIdentifier(options.capacityTopologyTable, 'capacity topology table')

  return {
    capacitySummary: capacitySummaryQuery(events),
    timepoints: timepointsQuery(events),
    cityTopology: topology ? cityTopologyQuery(topology) : null,
  }
}

function kqlIdentifier(raw: string, description: string): string {
  const trimmed = raw.trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new RangeError(`Invalid ${description}: ${raw}`)
  }
  return trimmed
}

function capacitySummaryQuery(table: string): string {
  return `declare query_parameters(_start:datetime, _end:datetime);
${table}
| where Timepoint >= _start and Timepoint < _end
| extend CapacityId = tostring(CapacityId)
| summarize
    WindowStart = min(Timepoint),
    WindowEnd = max(Timepoint),
    TotalCuSeconds = sum(todouble(CuSeconds)),
    MeanUtilizationPercent = avg(todouble(UtilizationPercent)),
    PeakUtilizationPercent = max(todouble(UtilizationPercent)),
    arg_max(
      Timepoint,
      CapacityName,
      Sku,
      CapacityUnits,
      Region,
      CapacityState,
      StateReason,
      InteractiveDelayPercent,
      InteractiveRejectionPercent,
      BackgroundRejectionPercent,
      CumulativeCarryOverPercent,
      ExpectedBurndownMinutes,
      SurgeProtectionActive
    )
  by CapacityId
| project
    CapacityId,
    CapacityName = tostring(CapacityName),
    Sku = tostring(Sku),
    CapacityUnits = todouble(CapacityUnits),
    Region = tostring(Region),
    CapacityState = tostring(CapacityState),
    StateReason = tostring(StateReason),
    ObservedAt = Timepoint,
    WindowStart,
    WindowEnd,
    TotalCuSeconds,
    MeanUtilizationPercent,
    PeakUtilizationPercent,
    InteractiveDelayPercent = todouble(InteractiveDelayPercent),
    InteractiveRejectionPercent = todouble(InteractiveRejectionPercent),
    BackgroundRejectionPercent = todouble(BackgroundRejectionPercent),
    CumulativeCarryOverPercent = todouble(CumulativeCarryOverPercent),
    ExpectedBurndownMinutes = todouble(ExpectedBurndownMinutes),
    SurgeProtectionActive = tobool(SurgeProtectionActive)
| order by CapacityName asc, CapacityId asc`
}

function timepointsQuery(table: string): string {
  return `declare query_parameters(_capacityId:string, _start:datetime, _end:datetime);
${table}
| where tostring(CapacityId) == _capacityId
| where Timepoint >= _start and Timepoint < _end
| project
    Timepoint,
    Sku = tostring(Sku),
    CapacityUnits = todouble(CapacityUnits),
    InteractiveBillablePercent = todouble(InteractiveBillablePercent),
    BackgroundBillablePercent = todouble(BackgroundBillablePercent),
    InteractiveNonBillablePercent = todouble(InteractiveNonBillablePercent),
    BackgroundNonBillablePercent = todouble(BackgroundNonBillablePercent),
    InteractiveDelayPercent = todouble(InteractiveDelayPercent),
    InteractiveRejectionPercent = todouble(InteractiveRejectionPercent),
    BackgroundRejectionPercent = todouble(BackgroundRejectionPercent),
    CarryOverAddPercent = todouble(CarryOverAddPercent),
    CarryOverBurndownPercent = todouble(CarryOverBurndownPercent),
    CumulativeCarryOverPercent = todouble(CumulativeCarryOverPercent),
    ExpectedBurndownMinutes = todouble(ExpectedBurndownMinutes)
| order by Timepoint asc`
}

function cityTopologyQuery(table: string): string {
  return `declare query_parameters(_capacityId:string);
${table}
| where tostring(CapacityId) == _capacityId
| summarize arg_max(ObservedAt, *) by ItemId = tostring(ItemId)
| project
    ObservedAt,
    CapacityId = tostring(CapacityId),
    WorkspaceId = tostring(WorkspaceId),
    WorkspaceName = tostring(WorkspaceName),
    ItemId,
    ItemName = tostring(ItemName),
    ItemType = tostring(ItemType)
| order by WorkspaceName asc, ItemName asc, ItemId asc`
}
