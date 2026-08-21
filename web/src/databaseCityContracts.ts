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
