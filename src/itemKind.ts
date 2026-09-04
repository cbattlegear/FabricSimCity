import type { FabricItemKind, ItemArchetype } from './capacityCityContracts'

/*
 * Two sources name the same item differently.
 *
 * The platform REST API reports `ItemType` — `DataPipeline`, `SemanticModel`, `UserDataFunction`.
 * The Capacity Metrics semantic model reports `Item Kind` — `Pipeline`, `Dataflow Gen2`,
 * `LlmPlugin`, `User Data Functions`. Topology comes from the first and telemetry from the second,
 * so an item arrives under two names and, left alone, becomes two buildings in two neighbourhoods
 * with half its evidence each.
 *
 * Both vocabularies are normalised here, and nowhere else, onto `FabricItemKind`.
 */

/** REST `ItemType` values, lowercased. */
const REST_ITEM_TYPES: Readonly<Record<string, FabricItemKind>> = Object.freeze({
  lakehouse: 'Lakehouse',
  warehouse: 'Warehouse',
  warehousesnapshot: 'WarehouseSnapshot',
  sqlendpoint: 'SqlEndpoint',
  sqldatabase: 'SqlDatabase',
  mirroreddatabase: 'MirroredDatabase',
  mirroredwarehouse: 'MirroredDatabase',
  mirroredcatalog: 'MirroredDatabase',
  mirroredazuredatabrickscatalog: 'MirroredDatabase',
  snowflakedatabase: 'MirroredDatabase',
  cosmosdbdatabase: 'SqlDatabase',
  eventhouse: 'Eventhouse',
  kqldatabase: 'KqlDatabase',
  kqlqueryset: 'KqlQueryset',
  kqldashboard: 'KqlDashboard',
  eventstream: 'Eventstream',
  semanticmodel: 'SemanticModel',
  report: 'Report',
  paginatedreport: 'PaginatedReport',
  dashboard: 'Dashboard',
  datamart: 'Datamart',
  notebook: 'Notebook',
  sparkjobdefinition: 'SparkJobDefinition',
  environment: 'Environment',
  datapipeline: 'DataPipeline',
  copyjob: 'CopyJob',
  apacheairflowjob: 'ApacheAirflowJob',
  databuildtooljob: 'ApacheAirflowJob',
  mounteddatafactory: 'DataPipeline',
  dataflow: 'Dataflow',
  mlmodel: 'MlModel',
  mlexperiment: 'MlExperiment',
  anomalydetector: 'MlModel',
  dataagent: 'DataAgent',
  operationsagent: 'DataAgent',
  graphqlapi: 'GraphQlApi',
  userdatafunction: 'UserDataFunction',
  reflex: 'Reflex',
  variablelibrary: 'VariableLibrary',
  digitaltwinbuilder: 'DigitalTwinBuilder',
  digitaltwinbuilderflow: 'DigitalTwinBuilder',
  graphmodel: 'GraphModel',
  graphqueryset: 'GraphModel',
  ontology: 'Ontology',
  eventschemaset: 'Eventstream',
  appbackend: 'AppBackend',
  orgapp: 'OrgApp',
  orgappaudience: 'OrgApp',
  azuredatabricksstorage: 'Lakehouse',
  map: 'Unknown',
  plan: 'Unknown',
})

/**
 * Capacity Metrics `Item Kind` values, lowercased and stripped of spaces.
 *
 * Only the entries that differ from the REST spelling need to be here; anything already matching a
 * REST name falls through to the table above. `llmplugin` is the metrics model's name for a Data
 * agent and is the least guessable of them.
 */
const METRICS_ITEM_KINDS: Readonly<Record<string, FabricItemKind>> = Object.freeze({
  pipeline: 'DataPipeline',
  dataflowgen1: 'Dataflow',
  dataflowgen2: 'Dataflow',
  llmplugin: 'DataAgent',
  userdatafunctions: 'UserDataFunction',
  graphql: 'GraphQlApi',
  database: 'SqlDatabase',
  sqlanalyticsendpoint: 'SqlEndpoint',
  datasciencemodel: 'MlModel',
  datascienceexperiment: 'MlExperiment',
  synapsenotebook: 'Notebook',
  sparkjob: 'SparkJobDefinition',
  onelake: 'Lakehouse',
  ai: 'DataAgent',
  aiskill: 'AiSkill',
  copilot: 'DataAgent',
})

/**
 * Normalise an item kind reported by either source.
 *
 * Returns `Unknown` rather than throwing. Fabric ships new item types continuously and the metrics
 * model invents virtual kinds for Copilot, so an unrecognised name is expected traffic, not a bug —
 * and an item dropped from the city because nobody taught this table its name would be a building
 * missing with no evidence that it ever existed.
 */
export function normalizeItemKind(raw: string | null | undefined): FabricItemKind {
  if (!raw) return 'Unknown'
  const key = raw.toLowerCase().replace(/[\s_-]/g, '')
  return METRICS_ITEM_KINDS[key] ?? REST_ITEM_TYPES[key] ?? 'Unknown'
}

/**
 * Which archetype an item's building is drawn as.
 *
 * `Storage` kinds hold OneLake bytes and get a real footprint. `Compute` kinds hold none and sit on
 * a minimum lot — a Notebook that has never stored a byte is correctly a tower on a small plot, not
 * a building whose footprint failed to measure. `Analytics` covers the read-side items that carry a
 * model but little storage, and `Streaming` the ones whose load is continuous rather than bursty.
 */
const ARCHETYPES: Readonly<Record<FabricItemKind, ItemArchetype>> = Object.freeze({
  Lakehouse: 'Storage',
  Warehouse: 'Storage',
  WarehouseSnapshot: 'Storage',
  SqlEndpoint: 'Storage',
  SqlDatabase: 'Storage',
  MirroredDatabase: 'Storage',
  Eventhouse: 'Storage',
  KqlDatabase: 'Storage',
  Datamart: 'Storage',

  Notebook: 'Compute',
  SparkJobDefinition: 'Compute',
  Environment: 'Compute',
  DataPipeline: 'Compute',
  Dataflow: 'Compute',
  CopyJob: 'Compute',
  ApacheAirflowJob: 'Compute',
  UserDataFunction: 'Compute',
  AppBackend: 'Compute',

  SemanticModel: 'Analytics',
  Report: 'Analytics',
  PaginatedReport: 'Analytics',
  Dashboard: 'Analytics',
  KqlQueryset: 'Analytics',
  KqlDashboard: 'Analytics',
  MlModel: 'Analytics',
  MlExperiment: 'Analytics',
  AiSkill: 'Analytics',
  DataAgent: 'Analytics',
  GraphModel: 'Analytics',
  Ontology: 'Analytics',
  GraphQlApi: 'Analytics',
  OrgApp: 'Analytics',

  Eventstream: 'Streaming',
  Reflex: 'Streaming',

  VariableLibrary: 'Compute',
  DigitalTwinBuilder: 'Compute',
  Unknown: 'Compute',
})

export function itemArchetype(kind: FabricItemKind): ItemArchetype {
  return ARCHETYPES[kind] ?? 'Compute'
}

/**
 * Whether this kind can hold OneLake storage at all.
 *
 * The city needs this to tell "no storage measured" from "no storage possible". A Notebook
 * reporting null bytes is a complete measurement of an item that stores nothing; a Lakehouse
 * reporting null bytes is missing evidence and draws as wireframe. Collapsing the two either
 * fills the city with false wireframes or hides real gaps.
 */
export function canHoldStorage(kind: FabricItemKind): boolean {
  return itemArchetype(kind) === 'Storage'
}

/** Every canonical kind, for fixtures and exhaustiveness tests. */
export const ALL_ITEM_KINDS = Object.freeze(Object.keys(ARCHETYPES) as FabricItemKind[])
