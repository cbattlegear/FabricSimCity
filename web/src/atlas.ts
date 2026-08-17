import type { AtlasSnapshot, ByteMeasurement, DatabaseAtlasItem, Evidence } from './contracts'

export function sizeToSide(allocatedKiB: number): number {
  if (!Number.isFinite(allocatedKiB) || allocatedKiB < 0) {
    throw new RangeError('Allocated KiB must be a finite, non-negative number')
  }
  const t = Math.min(1, Math.log2(1 + allocatedKiB) / 50)
  return Math.sqrt(144 + 9072 * t)
}

export function databaseSide(database: DatabaseAtlasItem): number | null {
  const { allocated } = database
  if (allocated.status !== 'Known' || allocated.bytes === null) return null
  return sizeToSide(allocated.bytes / 1024)
}

export function formatBytes(measurement: ByteMeasurement): string {
  if (measurement.status !== 'Known' || measurement.bytes === null) {
    return `Unknown — ${measurement.reason ?? measurement.evidence.reason}`
  }
  const exact = new Intl.NumberFormat('en-US').format(measurement.bytes)
  if (measurement.bytes === 0) return `${exact} bytes`
  const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB']
  const exponent = Math.min(Math.floor(Math.log(measurement.bytes) / Math.log(1024)), units.length - 1)
  const scaled = measurement.bytes / 1024 ** exponent
  return `${exact} bytes (${scaled.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${units[exponent]})`
}

export function evidenceText(evidence: Evidence): string {
  const source: Record<Evidence['source'], string> = {
    Fixture: 'Fixture value',
    LiveDmvSample: 'Live DMV sample',
    QueryStoreAggregate: 'Query Store aggregate history',
    InferredTopology: 'Inferred topology',
  }
  const observed = evidence.observedAt ? ` Observed ${new Date(evidence.observedAt).toLocaleString()}.` : ''
  return `${source[evidence.source]} — ${splitPascal(evidence.status)}.${observed} ${evidence.reason}`
}

export function isFreshLive(database: DatabaseAtlasItem, generatedAt: string): boolean {
  const evidence = database.liveActivity.evidence
  return evidence.source === 'LiveDmvSample' && evidence.status === 'Available' &&
    evidence.freshUntil !== null && Date.parse(evidence.freshUntil) >= Date.parse(generatedAt)
}

export function accessibleDatabaseLabel(database: DatabaseAtlasItem): string {
  return `${database.name}. Allocated: ${formatBytes(database.allocated)}. Used: ${formatBytes(database.used)}. ` +
    `Live activity: ${evidenceText(database.liveActivity.evidence)} Query Store: ` +
    `${splitPascal(database.queryStore.capability)}, ${splitPascal(database.queryStore.health)}. ${database.queryStore.reason}`
}

export function metric(value: number | null, suffix = ''): string {
  return value === null ? 'Unavailable' : `${value.toLocaleString('en-US')}${suffix}`
}

export function assertAtlasSnapshot(value: unknown): AtlasSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Atlas response is not an object')
  const candidate = value as Partial<AtlasSnapshot>
  if (candidate.schemaVersion !== '1.0' || !Array.isArray(candidate.databases) || !Array.isArray(candidate.edges)) {
    throw new Error('Atlas response does not match schema version 1.0')
  }
  return candidate as AtlasSnapshot
}

function splitPascal(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
}
