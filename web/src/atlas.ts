import type { AtlasSnapshot, ByteMeasurement, DatabaseAtlasItem, Evidence } from './contracts'

export function sizeToSide(allocatedKiB: number): number {
  if (!Number.isFinite(allocatedKiB) || allocatedKiB < 0) {
    throw new RangeError('Allocated KiB must be a finite, non-negative number')
  }
  const t = Math.min(1, Math.log2(1 + allocatedKiB) / 50)
  return Math.sqrt(144 + 9072 * t)
}

export function parseExactBytes(measurement: ByteMeasurement): bigint | null {
  if (measurement.status !== 'Known' || measurement.bytes === null || !/^\d+$/.test(measurement.bytes)) return null
  return BigInt(measurement.bytes)
}

export function databaseSide(database: DatabaseAtlasItem): number | null {
  const exactBytes = parseExactBytes(database.allocated)
  if (exactBytes === null) return null
  const allocatedKiB = Number(exactBytes) / 1024
  return Number.isFinite(allocatedKiB) ? sizeToSide(allocatedKiB) : 96
}

export function formatBytes(measurement: ByteMeasurement): string {
  if (measurement.status !== 'Known' || measurement.bytes === null) {
    return `Unknown — ${measurement.reason ?? measurement.evidence.reason}`
  }
  const value = parseExactBytes(measurement)
  if (value === null) return `Invalid exact byte value — ${measurement.evidence.reason}`
  const exact = new Intl.NumberFormat('en-US').format(value)
  if (value === 0n) return `${exact} bytes`
  return `${exact} bytes (${formatBinary(value)})`
}

export function formatDecimalCount(value: string | null): string {
  if (value === null) return 'Unavailable'
  if (!/^\d+$/.test(value)) return 'Invalid count'
  return new Intl.NumberFormat('en-US').format(BigInt(value))
}

export function formatFill(used: ByteMeasurement, allocated: ByteMeasurement): string {
  const usedBytes = parseExactBytes(used)
  const allocatedBytes = parseExactBytes(allocated)
  if (usedBytes === null || allocatedBytes === null) return 'Unavailable'
  if (allocatedBytes === 0n) return usedBytes === 0n ? '0%' : 'Invalid'
  const tenths = (usedBytes * 1000n) / allocatedBytes
  return `${tenths / 10n}.${tenths % 10n}%`
}

export function evidenceText(evidence: Evidence): string {
  const source: Record<Evidence['source'], string> = {
    Fixture: 'Fixture value',
    LiveDmvSample: 'Live DMV sample',
    QueryStoreAggregate: 'Query Store aggregate history',
    InferredTopology: 'Inferred topology',
    LiveDmvCumulative: 'Cumulative file I/O DMV sample',
    CatalogSnapshot: 'Catalog snapshot',
    NotProbed: 'Not probed',
    ImportedArchive: 'ImportedArchive',
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

export function collectorSummary(collection: NonNullable<AtlasSnapshot['collection']>): string {
  const details = [
    `sequence ${collection.sequence}`,
    `${collection.databaseCount} databases`,
    `${collection.rowCount} rows`,
    `${collection.durationMilliseconds} ms`,
  ]
  if (collection.isStale) details.push('stale')
  if (collection.failureCount > 0) details.push(`${collection.failureCount} partial failure(s)`)
  return details.join(' · ')
}

export function collectorDisplayState(
  collection: AtlasSnapshot['collection'],
  refreshFailed: boolean,
): { state: string; degraded: boolean } {
  if (refreshFailed) return { state: 'Refresh failed', degraded: true }
  return {
    state: collection?.state ?? 'Ready',
    degraded: collection?.isStale === true || (collection?.failureCount ?? 0) > 0,
  }
}

export function assertAtlasSnapshot(value: unknown): AtlasSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Atlas response is not an object')
  const candidate = value as Partial<AtlasSnapshot>
  if (candidate.schemaVersion !== '1.0' || !Array.isArray(candidate.databases) || !Array.isArray(candidate.edges)) {
    throw new Error('Atlas response does not match schema version 1.0')
  }
  return candidate as AtlasSnapshot
}

function formatBinary(value: bigint): string {
  const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB']
  let unitIndex = 0
  let divisor = 1n
  while (unitIndex < units.length - 1 && value >= divisor * 1024n) {
    divisor *= 1024n
    unitIndex += 1
  }
  const hundredths = (value * 100n) / divisor
  const whole = hundredths / 100n
  const fraction = hundredths % 100n
  const fractionText = fraction === 0n ? '' : `.${fraction.toString().padStart(2, '0').replace(/0$/, '')}`
  return `${new Intl.NumberFormat('en-US').format(whole)}${fractionText} ${units[unitIndex]}`
}

export function splitPascal(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
}
