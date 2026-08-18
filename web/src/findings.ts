import type {
  DataStatus,
  Finding,
  FindingConfidence,
  FindingImpactDimension,
  FindingSeverity,
  FindingsEngineStatus,
  FindingsPage,
  MeasuredImpact,
} from './findingsContracts'

/**
 * Persistent disclosure shown wherever findings are presented: findings are evidence-backed leads to
 * reproduce and judge, never an automated tuning verdict, and low-confidence or stale evidence is never
 * a diagnosis.
 */
export const FINDINGS_DISCLOSURE =
  'Every finding is a reproducible, evidence-backed observation, not an automated tuning verdict. ' +
  'Open its evidence to confirm it yourself. Insufficient, stale, or unsupported data is never a diagnosis.'

/** Trusted-network / no-login disclosure surfaced on the Operate surface (requirement 7). */
export const TRUSTED_NETWORK_DISCLOSURE =
  'SQLSimCity has no login and is intended for a trusted network. Acknowledging or suppressing a finding ' +
  'only changes your local view in this browser; it never changes the engine\u2019s truth or the server.'

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  Serious: 3, Notable: 2, Advisory: 1, Informational: 0,
}
const CONFIDENCE_RANK: Record<FindingConfidence, number> = { High: 2, Medium: 1, Low: 0 }

export function severityRank(severity: FindingSeverity): number {
  return SEVERITY_RANK[severity]
}

export function confidenceRank(confidence: FindingConfidence): number {
  return CONFIDENCE_RANK[confidence]
}

/**
 * A color-independent severity badge: a shape/character sequence plus text, so severity is never
 * communicated by color alone (requirement 7). Screen readers read the accessible label.
 */
export function severityGlyph(severity: FindingSeverity): string {
  switch (severity) {
    case 'Serious': return '\u25B0\u25B0\u25B0'
    case 'Notable': return '\u25B0\u25B0\u25B1'
    case 'Advisory': return '\u25B0\u25B1\u25B1'
    default: return '\u25B1\u25B1\u25B1'
  }
}

export function confidenceGlyph(confidence: FindingConfidence): string {
  switch (confidence) {
    case 'High': return '\u25CF\u25CF\u25CF'
    case 'Medium': return '\u25CF\u25CF\u25CB'
    default: return '\u25CF\u25CB\u25CB'
  }
}

export function severityLabel(severity: FindingSeverity): string {
  return `${severity} severity`
}

export function confidenceLabel(confidence: FindingConfidence): string {
  return `${confidence} confidence`
}

const DIMENSION_UNITS: Record<FindingImpactDimension, string> = {
  None: '',
  DurationMicroseconds: 'µs',
  CpuMicroseconds: 'µs CPU',
  LogicalReads8KiBPages: '8-KiB pages',
  WaitMilliseconds: 'ms wait',
  BlockedSessions: 'blocked sessions',
  MemoryGrantKb: 'KB requested',
  AbortedExecutionShare: 'aborted/exception share',
  PlanCount: 'distinct plans',
  LogSpacePercent: '% log used',
  IoStallMilliseconds: 'ms stall/s',
}

/** Formats a measured impact for display. A null magnitude is shown as an explicit non-numeric label, never as zero. */
export function formatImpact(impact: MeasuredImpact): string {
  if (impact.dimension === 'None' || impact.magnitude === null) {
    return 'Qualitative (no numeric magnitude)'
  }
  const unit = DIMENSION_UNITS[impact.dimension] || impact.unit
  const magnitude = formatMagnitude(impact.dimension, impact.magnitude)
  return unit ? `${magnitude} ${unit}` : magnitude
}

function formatMagnitude(dimension: FindingImpactDimension, magnitude: string): string {
  if (dimension === 'AbortedExecutionShare') {
    const share = Number(magnitude)
    return Number.isFinite(share) ? `${(share * 100).toFixed(1)}%` : magnitude
  }
  // Large counts are decimal strings; format the integer part with grouping without precision loss for typical sizes.
  const [whole, fraction] = magnitude.split('.')
  if (!/^-?\d+$/.test(whole)) return magnitude
  const grouped = BigInt(whole).toLocaleString('en-US')
  return fraction ? `${grouped}.${fraction}` : grouped
}

export function dataStatusLabel(status: DataStatus): string {
  return status.replace(/([a-z])([A-Z])/g, '$1 $2')
}

export function freshnessGlyph(status: DataStatus): string {
  return status === 'Available' ? '\u25C9' : '\u25CE'
}

/** Counts firing findings by severity for the inbox summary. */
export function countBySeverity(findings: readonly Finding[]): Record<FindingSeverity, number> {
  const counts: Record<FindingSeverity, number> = { Serious: 0, Notable: 0, Advisory: 0, Informational: 0 }
  for (const finding of findings) counts[finding.severity] += 1
  return counts
}

export function assertFindingsPage(value: unknown): FindingsPage {
  if (!value || typeof value !== 'object') throw new Error('Findings page is not an object')
  const candidate = value as Partial<FindingsPage>
  if (candidate.schemaVersion !== '1.0') throw new Error('Findings page does not match schema version 1.0')
  if (!Array.isArray(candidate.items)) throw new Error('Findings page is missing items')
  return candidate as FindingsPage
}

export function assertFindingsEngineStatus(value: unknown): FindingsEngineStatus {
  if (!value || typeof value !== 'object') throw new Error('Findings status is not an object')
  const candidate = value as Partial<FindingsEngineStatus>
  if (candidate.schemaVersion !== '1.0') throw new Error('Findings status does not match schema version 1.0')
  if (!Array.isArray(candidate.rules)) throw new Error('Findings status is missing rules')
  return candidate as FindingsEngineStatus
}

// --- Local presentation state (acknowledge / suppress) ---------------------------------------------

const PRESENTATION_STORAGE_KEY = 'sqlsimcity.findings.presentation.v1'

export interface FindingsPresentation {
  acknowledged: ReadonlySet<string>
  suppressed: ReadonlySet<string>
}

interface StoredPresentation {
  version: 1
  acknowledged: string[]
  suppressed: string[]
}

/**
 * A minimal Storage-like seam so presentation state is testable without a DOM. `localStorage`
 * satisfies this interface directly.
 */
export interface PresentationStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function loadPresentation(store: PresentationStore): FindingsPresentation {
  try {
    const raw = store.getItem(PRESENTATION_STORAGE_KEY)
    if (!raw) return emptyPresentation()
    const parsed = JSON.parse(raw) as Partial<StoredPresentation>
    if (parsed.version !== 1) return emptyPresentation()
    return {
      acknowledged: new Set(Array.isArray(parsed.acknowledged) ? parsed.acknowledged : []),
      suppressed: new Set(Array.isArray(parsed.suppressed) ? parsed.suppressed : []),
    }
  } catch {
    // A corrupt or foreign value must never break the inbox; fall back to an empty, clean state.
    return emptyPresentation()
  }
}

export function savePresentation(store: PresentationStore, presentation: FindingsPresentation): void {
  const payload: StoredPresentation = {
    version: 1,
    acknowledged: [...presentation.acknowledged],
    suppressed: [...presentation.suppressed],
  }
  store.setItem(PRESENTATION_STORAGE_KEY, JSON.stringify(payload))
}

export function togglePresentation(
  presentation: FindingsPresentation,
  which: 'acknowledged' | 'suppressed',
  findingId: string,
): FindingsPresentation {
  const acknowledged = new Set(presentation.acknowledged)
  const suppressed = new Set(presentation.suppressed)
  const target = which === 'acknowledged' ? acknowledged : suppressed
  if (target.has(findingId)) target.delete(findingId)
  else target.add(findingId)
  return { acknowledged, suppressed }
}

function emptyPresentation(): FindingsPresentation {
  return { acknowledged: new Set<string>(), suppressed: new Set<string>() }
}
