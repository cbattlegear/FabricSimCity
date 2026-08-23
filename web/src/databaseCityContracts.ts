import type { DataStatus, EdgeConfidence, Evidence, EvidenceSource, MeasurementStatus } from './contracts'

export type DatabaseCityMetric = 'Cpu' | 'Duration' | 'Reads' | 'Executions'
export type DatabaseObjectKind = 'Table' | 'IndexedView'
export type DatabaseIndexKind = 'Heap' | 'Clustered' | 'Nonclustered' | 'Columnstore' | 'Other'
export type QueryAttributionConfidence = 'Confirmed' | 'Probable' | 'Unknown'
export type DatabaseCityRouteKind = 'ObjectReference' | 'CrossDatabaseReference'

export interface DatabaseCityDirectActivity {
  totalOperations: string | null
  resetEpochToken: string | null
  evidence: Evidence
}

/**
 * Query Store totals from ranked families that named this object *alongside others*, carried whole
 * and never divided: Query Store measures one total per query, never a per-object share. The same
 * figures repeat on every other object those queries named, so these values are **not additive
 * across buildings** — summing them over a city counts one query once per table it touched.
 */
export interface DatabaseCitySharedExposure {
  familyCount: string
  executionCount: string
  totalCpuMicroseconds: string
  totalDurationMicroseconds: string
  totalLogicalReads8KiBPages: string
  rationale: string
}

export interface DatabaseCityAttributedExposure {
  executionCount: string | null
  totalCpuMicroseconds: string | null
  totalDurationMicroseconds: string | null
  totalLogicalReads8KiBPages: string | null
  confidence: QueryAttributionConfidence
  rationale: string
  evidence: Evidence
  /**
   * Non-additive query-level totals from families that named this object alongside others, or null
   * when no ranked family did. Present even when the scalars above are null, which is the normal
   * case for a normalized schema where every ranked query joins several tables.
   */
  shared?: DatabaseCitySharedExposure | null
}

export interface DatabaseCityIndex {
  indexId: string
  name: string
  kind: DatabaseIndexKind
  directActivity: DatabaseCityDirectActivity
}

export interface DatabaseCityObject {
  objectId: string
  schemaId: string
  schemaName: string
  name: string
  kind: DatabaseObjectKind
  reservedPages8KiB: string | null
  usedPages8KiB: string | null
  reservedBytes: string | null
  usedBytes: string | null
  sizeStatus: MeasurementStatus
  sizeReason: string | null
  /**
   * Where the collector put this object in its stable ordering.
   *
   * `neighborhoodOrdinal` is the schema's position among the database's schemas. `objectOrdinal` is
   * the object's position among **every object in the database**, not within its own schema — the one
   * meaning both collectors can honour (#49). Both state an order and nothing else: nothing that
   * sizes the city may be derived from an ordinal, because an ordinal is not a count. `x`/`z` are
   * legacy lattice coordinates the city no longer reads.
   */
  layout: { neighborhoodOrdinal: number; objectOrdinal: number; x: number; z: number }
  indexes: DatabaseCityIndex[]
  directActivity: DatabaseCityDirectActivity
  attributedExposure: DatabaseCityAttributedExposure
}

export interface DatabaseCitySchema {
  schemaId: string
  name: string
  neighborhoodOrdinal: number
  objectCount: string
  evidence: Evidence
}

/**
 * One object's modelled share of a query family's measured wait time.
 *
 * `waitMilliseconds` is **not** a measurement of how long this object waited. Query Store measures
 * one wait total per query and never says which table caused it. The split is `estimatedCostShare`:
 * the fraction of the compiled plan's *estimated* cost the optimizer placed on operators reading
 * this object. Anything drawn from it has to say so.
 */
export interface DatabaseCityObjectWaitShare {
  objectId: string
  estimatedCostShare: number
  waitMilliseconds: string
}

/**
 * A family's measured wait time apportioned across the objects its compiled plans read.
 *
 * The parts and `unattributedWaitMilliseconds` sum to exactly `totalWaitMilliseconds`, so the split
 * can always be added back up and checked against the measurement it came from. The unattributed
 * part covers cost the plan spent on no object at all, plus every object the plan named that this
 * page does not draw. An empty `objects` list means no apportionment was possible, never that
 * nothing waited.
 */
export interface DatabaseCityWaitAttribution {
  objects: DatabaseCityObjectWaitShare[]
  unattributedWaitMilliseconds: string
  plansRead: number
  rationale: string
}

export interface DatabaseCityQueryFamily {
  familyId: string
  queryHash: string
  executionCount: string
  totalCpuMicroseconds: string
  totalDurationMicroseconds: string
  totalLogicalReads8KiBPages: string
  totalWaitMilliseconds: string
  /**
   * Captured wait milliseconds keyed by verbatim Query Store `wait_category_desc`. An empty object
   * means the breakdown was not captured — `sys.query_store_wait_stats` does not exist before
   * SQL Server 2017 (14.x) — and never that the family waited for nothing.
   */
  waitMillisecondsByCategory: Record<string, string>
  objectIds: string[]
  confidence: QueryAttributionConfidence
  rationale: string
  evidence: Evidence
  /**
   * The same wait total spread over the objects the family's plans read, in proportion to estimated
   * plan cost. Optional because a page collected before the split existed carries no attribution;
   * absent means "not apportioned", never "nothing waited".
   */
  waitAttribution?: DatabaseCityWaitAttribution | null
}

export interface DatabaseCityWorkloadAggregate {
  familyCount: string | null
  executionCount: string | null
  totalCpuMicroseconds: string | null
  totalDurationMicroseconds: string | null
  totalLogicalReads8KiBPages: string | null
  totalWaitMilliseconds: string | null
  evidence: Evidence
}

export interface DatabaseCityRoute {
  routeId: string
  fromObjectId: string
  toId: string
  kind: DatabaseCityRouteKind
  confidence: EdgeConfidence
  rationale: string
  evidence: Evidence
}

export interface DatabaseCitySummary {
  databaseId: string
  name: string
  schemaCount: string | null
  objectCount: string | null
  reservedBytes: string | null
  sizeStatus: MeasurementStatus
  evidence: Evidence
}

export interface DatabaseCitySummarySnapshot {
  schemaVersion: string
  generatedAt: string
  databases: DatabaseCitySummary[]
}

export interface DatabaseCityPage {
  schemaVersion: string
  databaseId: string
  databaseName: string
  metric: DatabaseCityMetric
  pageSize: number
  nextPageToken: string | null
  totalObjects: string | null
  schemas: DatabaseCitySchema[]
  objects: DatabaseCityObject[]
  topQueryFamilies: DatabaseCityQueryFamily[]
  otherWorkload: DatabaseCityWorkloadAggregate
  routes: DatabaseCityRoute[]
  evidence: Evidence
}

export type { DataStatus, EvidenceSource }
