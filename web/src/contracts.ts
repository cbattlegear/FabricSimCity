export type MeasurementStatus = 'Known' | 'Unknown'
export type EvidenceSource = 'Fixture' | 'LiveDmvSample' | 'QueryStoreAggregate' | 'InferredTopology'
export type DataStatus = 'Available' | 'Stale' | 'Disconnected' | 'PermissionDenied' | 'Disabled' | 'Unsupported' | 'Unknown'
export type QueryStoreCapability = 'Available' | 'Disabled' | 'PermissionDenied' | 'Unsupported' | 'Unknown'
export type QueryStoreHealth = 'Healthy' | 'ReadOnly' | 'Error' | 'Stale' | 'Unavailable' | 'Unknown'
export type EdgeConfidence = 'Confirmed' | 'Probable' | 'Unknown'

export interface Evidence {
  source: EvidenceSource
  status: DataStatus
  observedAt: string | null
  freshUntil: string | null
  reason: string
}

export interface ByteMeasurement {
  bytes: string | null
  status: MeasurementStatus
  reason: string | null
  evidence: Evidence
}

export interface LiveActivity {
  activeSessions: number | null
  runningRequests: number | null
  blockedSessions: number | null
  batchRequestsPerSecond: number | null
  evidence: Evidence
}

export interface QueryStoreHistory {
  executionCount: string | null
  logicalReads8KiBPages: string | null
  averageDurationMicroseconds: number | null
  windowStart: string | null
  windowEnd: string | null
  capability: QueryStoreCapability
  health: QueryStoreHealth
  reason: string
  evidence: Evidence
}

export interface DatabaseAtlasItem {
  databaseId: string
  name: string
  allocated: ByteMeasurement
  used: ByteMeasurement
  liveActivity: LiveActivity
  queryStore: QueryStoreHistory
}

export interface AtlasEdge {
  edgeId: string
  fromDatabaseId: string
  toDatabaseId: string
  confidence: EdgeConfidence
  rationale: string
  evidence: Evidence
}

export interface AtlasSnapshot {
  schemaVersion: string
  snapshotId: string
  target: { targetId: string; displayName: string; platform: string }
  generatedAt: string
  databases: DatabaseAtlasItem[]
  edges: AtlasEdge[]
}
