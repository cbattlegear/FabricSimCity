export type MeasurementStatus = 'Known' | 'Unknown'
export type EvidenceSource = 'Fixture' | 'LiveDmvSample' | 'QueryStoreAggregate' | 'InferredTopology' | 'LiveDmvCumulative' | 'NotProbed'
export type DataStatus = 'Available' | 'Stale' | 'Disconnected' | 'PermissionDenied' | 'Disabled' | 'Unsupported' | 'Unknown'
export type QueryStoreCapability = 'Available' | 'Disabled' | 'PermissionDenied' | 'Unsupported' | 'Unknown'
export type QueryStoreHealth = 'Healthy' | 'ReadOnly' | 'ReadableSecondary' | 'Error' | 'Stale' | 'Unavailable' | 'Unknown'
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
  totalDurationMicroseconds?: string | null
  totalCpuMicroseconds?: string | null
  desiredState?: string | null
  captureMode?: string | null
  currentStorageBytes?: string | null
  maxStorageBytes?: string | null
  abortedExecutionCount?: string | null
  exceptionExecutionCount?: string | null
}

export interface FileIo {
  bytesRead: string | null
  bytesWritten: string | null
  readBytesPerSecond: string | null
  writeBytesPerSecond: string | null
  sampleMilliseconds: string | null
  resetEpochToken: string | null
  evidence: Evidence
}

export interface DatabaseAtlasItem {
  databaseId: string
  name: string
  allocated: ByteMeasurement
  used: ByteMeasurement
  liveActivity: LiveActivity
  queryStore: QueryStoreHistory
  state?: string | null
  compatibilityLevel?: number | null
  logAllocated?: ByteMeasurement | null
  logUsed?: ByteMeasurement | null
  fileIo?: FileIo | null
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
  collection?: {
    mode: 'Fixture' | 'Connected'
    state: 'Ready' | 'Collecting' | 'Paused' | 'BackingOff' | 'Degraded' | 'Disconnected'
    sequence: number
    collectedAt: string | null
    sourceTimestamp: string | null
    staleAfter: string | null
    isStale: boolean
    databaseCount: number
    failureCount: number
    skipCount: number
    durationMilliseconds: number
    rowCount: number
    reason: string
  } | null
}
