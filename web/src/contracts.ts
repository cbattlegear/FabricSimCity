export type MeasurementStatus = 'Known' | 'Unknown'
export type EvidenceSource = 'Fixture' | 'LiveDmvSample' | 'QueryStoreAggregate' | 'InferredTopology' | 'LiveDmvCumulative' | 'CatalogSnapshot' | 'NotProbed' | 'ImportedArchive'
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
    mode: 'Fixture' | 'Connected' | 'Archive'
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

export type QueryTextAvailability = 'Available' | 'Restricted' | 'Encrypted' | 'Missing'
export type QueryStoreExecutionType = 'Regular' | 'Aborted' | 'Exception'

export interface QueryStoreEvidence {
  source: 'Fixture' | 'QueryStore' | 'ImportedArchive'
  status: DataStatus
  observedAt: string | null
  freshUntil: string | null
  reason: string
  caveat: string
}

export interface QueryFamilySummary {
  familyId: string
  databaseId: string
  queryHash: string
  normalizedTextFingerprint: string | null
  text: { availability: QueryTextAvailability; normalizedText: string | null; reason: string }
  physicalQueries: Array<{
    queryId: string
    queryTextId: string
    context: { contextSettingsId: string; language: string | null; dateFormat: string | null; setOptions: string | null }
  }>
  executionCount: string
  totalCpuMicroseconds: string
  totalDurationMicroseconds: string
  totalLogicalReads8KiBPages: string
  totalWaitMilliseconds: string
  firstObservedAt: string
  lastObservedAt: string
  evidence: QueryStoreEvidence
}

export interface RuntimeBucket {
  planId: string
  intervalId: string
  epochId: string
  intervalStart: string
  intervalEnd: string
  executionType: QueryStoreExecutionType
  replicaGroupId: string
  executionCount: string
  averageDurationMicroseconds: number
  averageCpuMicroseconds: number
  averageLogicalReads8KiBPages: number
  waitMilliseconds: Record<string, string>
}

export interface QueryPlanSummary {
  planId: string
  planType: 'Compiled' | 'Dispatcher' | 'Variant' | 'Unknown'
  optimization: 'None' | 'ParameterSensitivePlan' | 'OptionalParameterPlanOptimization'
  dispatcherPlanId: string | null
  runtimeCounted: boolean
  isForced: boolean
  forceFailureCount: string
  lastForceFailureReason: string | null
  lastExecutionAt: string
}

export interface QueryFamilyDetail {
  schemaVersion: string
  family: QueryFamilySummary
  plans: QueryPlanSummary[]
  runtime: RuntimeBucket[]
}

export interface QueryFamilyPage {
  schemaVersion: string
  items: QueryFamilySummary[]
  nextPageToken: string | null
  pageSize: number
  totalCount: string | null
  evidence: QueryStoreEvidence | null
}

export interface ShowplanWarning {
  kind: string
  detail: string | null
}

export interface ShowplanObjectReference {
  database: string | null
  schema: string | null
  table: string | null
  index: string | null
}

export interface ShowplanNode {
  nodeId: number
  parentNodeId: number | null
  logicalOperation: string
  physicalOperation: string
  estimatedRows: number | null
  estimatedCpuCost: number | null
  estimatedIoCost: number | null
  estimatedTotalSubtreeCost: number | null
  parallel: boolean
  objectReference: ShowplanObjectReference | null
  predicate: string | null
  warnings: ShowplanWarning[]
}

export interface NormalizedShowplan {
  planId: string
  showplanVersion: string
  cardinalityEstimatorVersion: string | null
  serialDesiredMemoryKiB: number | null
  serialRequiredMemoryKiB: number | null
  optimization: 'None' | 'ParameterSensitivePlan' | 'OptionalParameterPlanOptimization'
  dispatcherExpression: string | null
  structuralFingerprint: string
  runtimeOverlayCaveat: string
  nodes: ShowplanNode[]
}

export interface PlanComparison {
  structurallyEqual: boolean
  changes: Array<{ path: string; changeKind: string; before: string | null; after: string | null }>
  source: string
  caveat: string
}

export interface ArchiveInfo {
  source: 'ImportedArchive'
  schemaVersion: string
  producerVersion: string
  createdAt: string
  target: { opaqueIdentity: string; displayAlias: string }
  includedSections: string[]
  redaction: {
    policyVersion: string
    protectedIdentifiersIncluded: boolean
    rawSqlIncluded: boolean
    rawShowplanXmlIncluded: boolean
    excludedFields: string[]
  }

  features: string[]
  capabilities: string[]
  archiveBytes: number
  entryCount: number
  archivedFindings?: {
    mode: string
    engineVersion: string
    ruleVersions: Record<string, string>
  } | null
}

export interface EdgeSourceInfo {
  source: 'EdgeConnector'
  targetId: string
  connectorId: string | null
  sequence: number | null
  publicationGeneration: number | null
  state: 'Available' | 'Stale' | 'Disconnected'
  capturedAt: string | null
  freshUntil: string | null
  sections: string[]
  qualification: string
}

export interface QueryStoreCollectorStatus {
  schemaVersion: string
  state: 'Disabled' | 'Starting' | 'Collecting' | 'Ready' | 'Partial' | 'Stale' | 'BackingOff' | 'Failed'
  sequence: number
  lastStartedAt: string | null
  lastPublishedAt: string | null
  nextAttemptAt: string | null
  databases: Array<{
    databaseId: string
    state: 'ReadWrite' | 'ReadOnly' | 'ReadCaptureSecondary' | 'Off' | 'Error' | 'PermissionDenied' | 'Unsupported' | 'Unknown'
    reason: string
  }>
  reason: string
}
