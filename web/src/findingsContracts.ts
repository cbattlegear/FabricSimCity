export type FindingStatus = 'Firing' | 'NotEvaluated' | 'InsufficientEvidence'
export type FindingSeverity = 'Informational' | 'Advisory' | 'Notable' | 'Serious'
export type FindingConfidence = 'Low' | 'Medium' | 'High'
export type RuleSupportStatus = 'Supported' | 'Unsupported'
export type FindingImpactDimension =
  | 'None' | 'DurationMicroseconds' | 'CpuMicroseconds' | 'LogicalReads8KiBPages' | 'WaitMilliseconds'
  | 'BlockedSessions' | 'MemoryGrantKb' | 'AbortedExecutionShare' | 'PlanCount' | 'LogSpacePercent' | 'IoStallMilliseconds'
export type FindingEvidenceKind =
  | 'QueryStoreFamily' | 'QueryStorePlan' | 'QueryStoreRuntimeBucket' | 'QueryStoreStatus'
  | 'LiveRequest' | 'LiveBlockingNode' | 'LiveMemoryGrant' | 'LiveLogSpace' | 'LiveFileIo' | 'AtlasDatabase' | 'Capability'
export type EvidenceSource =
  | 'Fixture' | 'LiveDmvSample' | 'QueryStoreAggregate' | 'InferredTopology' | 'LiveDmvCumulative' | 'NotProbed'
export type DataStatus = 'Available' | 'Stale' | 'Disconnected' | 'PermissionDenied' | 'Disabled' | 'Unsupported' | 'Unknown'

export interface FindingEvidenceRef {
  kind: FindingEvidenceKind
  ref: string
  label: string
  observation: string
}

export interface MeasuredImpact {
  dimension: FindingImpactDimension
  magnitude: string | null
  unit: string
  basis: string
}

export interface ObservedWindow {
  start: string | null
  end: string | null
  kind: string
  caveat: string
}

export interface FindingScope {
  targetId: string
  databaseId: string | null
  queryFamilyId: string | null
  planId: string | null
  displayName: string
  resourceId?: string | null
}

export interface FindingSourceFreshness {
  source: EvidenceSource
  status: DataStatus
  observedAt: string | null
  freshUntil: string | null
  reason: string
}

export interface Finding {
  schemaVersion: string
  findingId: string
  ruleId: string
  ruleVersion: string
  title: string
  scope: FindingScope
  observedWindow: ObservedWindow
  status: FindingStatus
  severity: FindingSeverity
  impact: MeasuredImpact
  confidence: FindingConfidence
  evidence: FindingEvidenceRef[]
  caveats: string[]
  alternateExplanations: string[]
  recommendedNextChecks: string[]
  readOnlyRecommendation: string
  sourceFreshness: FindingSourceFreshness
}

export interface FindingsPage {
  schemaVersion: string
  items: Finding[]
  nextPageToken: string | null
  pageSize: number
  totalCount: number
  generatedAt: string
}

export interface RuleEvaluation {
  ruleId: string
  ruleVersion: string
  title: string
  description: string
  support: RuleSupportStatus
  outcome: FindingStatus
  findingCount: number
  reason: string
}

export interface FindingsEngineStatus {
  schemaVersion: string
  generatedAt: string
  engineVersion: string
  ruleCount: number
  supportedRuleCount: number
  firingRuleCount: number
  findingCount: number
  rules: RuleEvaluation[]
  sources: FindingSourceFreshness[]
  reason: string
}
