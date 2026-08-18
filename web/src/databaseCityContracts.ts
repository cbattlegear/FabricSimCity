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

export interface DatabaseCityAttributedExposure {
  executionCount: string | null
  totalCpuMicroseconds: string | null
  totalDurationMicroseconds: string | null
  totalLogicalReads8KiBPages: string | null
  confidence: QueryAttributionConfidence
  rationale: string
  evidence: Evidence
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
