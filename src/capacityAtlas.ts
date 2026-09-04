import type {
  AtlasSnapshot,
  ByteMeasurement,
  CapacityAtlasItem,
  CuMeasurement,
  Evidence,
  FabricSku,
} from './fabricContracts'
import { SKU_CAPACITY_UNITS } from './fabricContracts'

/*
 * Atlas geometry.
 *
 * One capacity is one city. The plot it stands on is sized by its SKU — the CU budget is the real
 * contention boundary, and it is the thing an operator provisions — while the skyline is raised by
 * the CU actually consumed. That pair says what the SQL build's allocated/used pair said: how much
 * ground was reserved, and how much of it got built on.
 *
 * Every mapping below is strictly monotonic in its measured value and deliberately uncapped, so
 * two capacities can never read as the same size unless their measurements really are equal.
 */

/** Largest SKU, used to normalise the plot scale. `log2(1 + 8192)` is 13 to three decimals. */
const MAX_SKU_LOG = Math.log2(1 + SKU_CAPACITY_UNITS.F8192)

/**
 * Plot side length in world units, from a capacity's CU budget.
 *
 * Logarithmic because the SKU range spans 4,096× from F2 to F8192, and a linear plot would make
 * every small capacity an invisible speck beside one large one. The result runs from 12 units at
 * zero CU to 96 at the largest SKU.
 */
export function skuToSide(capacityUnits: number): number {
  if (!Number.isFinite(capacityUnits) || capacityUnits < 0) {
    throw new RangeError('Capacity units must be a finite, non-negative number')
  }
  const t = Math.min(1, Math.log2(1 + capacityUnits) / MAX_SKU_LOG)
  return Math.sqrt(144 + 9072 * t)
}

/**
 * Height of a capacity city's tallest tower, in world units, from CU-seconds consumed.
 *
 * Every doubling of consumed CU adds 2.6 units, and a capacity that consumed nothing has no
 * skyline at all — which is the correct rendering for an idle capacity and, crucially, *not* what
 * a paused one gets, because a paused capacity has no measurement and therefore no height claim.
 */
export const HEIGHT_UNITS_PER_DOUBLING = 2.6

export function cuToHeight(cuSeconds: number): number {
  if (!Number.isFinite(cuSeconds) || cuSeconds < 0) {
    throw new RangeError('CU seconds must be a finite, non-negative number')
  }
  return Math.log2(1 + cuSeconds) * HEIGHT_UNITS_PER_DOUBLING
}

export function parseExactBytes(measurement: ByteMeasurement): bigint | null {
  if (measurement.status !== 'Known' || measurement.bytes === null || !/^\d+$/.test(measurement.bytes)) {
    return null
  }
  return BigInt(measurement.bytes)
}

export function parseExactCu(measurement: CuMeasurement): bigint | null {
  if (
    measurement.status !== 'Known' ||
    measurement.cuSeconds === null ||
    !/^\d+$/.test(measurement.cuSeconds)
  ) {
    return null
  }
  return BigInt(measurement.cuSeconds)
}

/**
 * Plot side for a capacity, or null when the SKU is unrecognised.
 *
 * Null rather than a default, because an unknown SKU means the CU budget is unknown, and a plot
 * drawn at a guessed size would claim a contention boundary nobody measured.
 */
export function capacitySide(capacity: CapacityAtlasItem): number | null {
  if (capacity.capacityUnits === null || !Number.isFinite(capacity.capacityUnits)) return null
  return skuToSide(capacity.capacityUnits)
}

/** Tallest-tower height, or null when consumption is unknown and no height is claimed. */
export function capacityHeight(capacity: CapacityAtlasItem): number | null {
  const exact = parseExactCu(capacity.cuConsumed)
  if (exact === null) return null
  const value = Number(exact)
  return Number.isFinite(value) ? cuToHeight(value) : cuToHeight(Number.MAX_SAFE_INTEGER)
}

/* ------------------------------------------------------------------ *
 * Formatting
 *
 * Numbers and units, without the sentences around them. The SQL build put a `reason` paragraph on
 * every measurement and printed it in the sidebar; the state is carried visually now, so these
 * return the shortest true string rather than an explanation.
 * ------------------------------------------------------------------ */

export function formatBytes(measurement: ByteMeasurement): string {
  if (measurement.status !== 'Known' || measurement.bytes === null) return 'Unknown'
  const value = parseExactBytes(measurement)
  if (value === null) return 'Invalid'
  return formatBinary(value)
}

/**
 * CU-seconds, rendered in the unit an operator actually reads.
 *
 * The Capacity Metrics app reports CU (s) and the numbers get large fast: a fortnight on an F64 is
 * 77 million CU-seconds. Thousands separators alone leave an unreadable wall of digits.
 */
export function formatCu(measurement: CuMeasurement): string {
  if (measurement.status !== 'Known' || measurement.cuSeconds === null) return 'Unknown'
  const value = parseExactCu(measurement)
  if (value === null) return 'Invalid'
  return `${formatCompact(value)} CU-s`
}

export function formatDecimalCount(value: string | null): string {
  if (value === null) return 'Unavailable'
  if (!/^\d+$/.test(value)) return 'Invalid'
  return new Intl.NumberFormat('en-US').format(BigInt(value))
}

export function formatPercent(value: number | null, fractionDigits = 1): string {
  if (value === null || !Number.isFinite(value)) return 'Unavailable'
  return `${value.toFixed(fractionDigits)}%`
}

/** Minutes as a short duration. Null is a real answer here and must not read as zero. */
export function formatMinutes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'Unavailable'
  if (value < 1) return '<1 min'
  if (value < 60) return `${Math.round(value)} min`
  const hours = value / 60
  if (hours < 24) return `${hours.toFixed(1)} h`
  return `${(hours / 24).toFixed(1)} d`
}

const SOURCE_LABELS: Readonly<Record<Evidence['source'], string>> = Object.freeze({
  Fixture: 'Fixture',
  FabricRest: 'Fabric REST',
  SemanticModel: 'Capacity Metrics',
  CapacityEvent: 'Capacity events',
  NotProbed: 'Not probed',
})

/** Short provenance, for a tooltip rather than a paragraph. */
export function evidenceText(evidence: Evidence): string {
  const parts = [SOURCE_LABELS[evidence.source], splitPascal(evidence.status)]
  if (evidence.observedAt) parts.push(new Date(evidence.observedAt).toLocaleString())
  return parts.join(' · ')
}

/**
 * Whether a measurement is still inside its own freshness window.
 *
 * The Capacity Metrics model runs 10–15 minutes behind and its dimension tables only refresh at
 * midnight, so a city drawn from it is always slightly historical. Anything past `freshUntil` dims
 * rather than clearing — the evidence is still true, it is just older than it claims to be.
 */
export function isFresh(evidence: Evidence, asOf: string): boolean {
  if (evidence.status !== 'Available' || evidence.freshUntil === null) return false
  const until = Date.parse(evidence.freshUntil)
  const now = Date.parse(asOf)
  return Number.isFinite(until) && Number.isFinite(now) && until >= now
}

/**
 * Whether the capacity is turning work away right now.
 *
 * `Overloaded` alone is not enough: the first stage merely delays interactive requests by 20
 * seconds, which is a busy city rather than a broken one. Only the rejection stages actually
 * refuse work, and only those should draw as a blackout.
 */
export function isRejecting(capacity: CapacityAtlasItem): boolean {
  return (
    capacity.throttle.stage === 'InteractiveRejection' ||
    capacity.throttle.stage === 'BackgroundRejection'
  )
}

/**
 * Whether the capacity is emitting telemetry at all.
 *
 * A paused capacity emits nothing — not zeroes — so it draws as wireframe. Collapsing this with
 * "idle" would render an unknown city as a healthy empty one.
 */
export function isReporting(capacity: CapacityAtlasItem): boolean {
  return capacity.state !== 'Suspended' && capacity.state !== 'Deleted'
}

export function accessibleCapacityLabel(capacity: CapacityAtlasItem): string {
  const sku = capacity.sku ?? 'unknown SKU'
  const parts = [
    `${capacity.displayName}, ${sku}`,
    `${splitPascal(capacity.state)}`,
    `CU ${formatCu(capacity.cuConsumed)}`,
    `storage ${formatBytes(capacity.storage)}`,
  ]
  if (capacity.meanUtilizationPercent !== null) {
    parts.push(`mean ${formatPercent(capacity.meanUtilizationPercent)} of budget`)
  }
  if (capacity.throttle.stage !== 'None') parts.push(splitPascal(capacity.throttle.stage))
  return `${parts.join('. ')}.`
}

export function metric(value: number | null, suffix = ''): string {
  return value === null ? 'Unavailable' : `${value.toLocaleString('en-US')}${suffix}`
}

export function collectorSummary(collection: NonNullable<AtlasSnapshot['collection']>): string {
  const details = [
    `${collection.capacityCount} capacities`,
    `${collection.durationMilliseconds} ms`,
  ]
  if (collection.isStale) details.push('stale')
  if (collection.failureCount > 0) details.push(`${collection.failureCount} failed`)
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
  if (
    candidate.schemaVersion !== '1.0' ||
    !Array.isArray(candidate.capacities) ||
    !Array.isArray(candidate.links)
  ) {
    throw new Error('Atlas response does not match schema version 1.0')
  }
  return candidate as AtlasSnapshot
}

/** Parse a SKU name into its CU budget. Returns null for anything unrecognised. */
export function skuUnits(sku: string | null): number | null {
  if (!sku) return null
  return SKU_CAPACITY_UNITS[sku as FabricSku] ?? null
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
  const fractionText =
    fraction === 0n ? '' : `.${fraction.toString().padStart(2, '0').replace(/0$/, '')}`
  return `${new Intl.NumberFormat('en-US').format(whole)}${fractionText} ${units[unitIndex]}`
}

/** Decimal SI compaction on a bigint, so precision survives values past `Number.MAX_SAFE_INTEGER`. */
function formatCompact(value: bigint): string {
  const units = ['', 'K', 'M', 'B', 'T']
  let unitIndex = 0
  let divisor = 1n
  while (unitIndex < units.length - 1 && value >= divisor * 1000n) {
    divisor *= 1000n
    unitIndex += 1
  }
  if (unitIndex === 0) return new Intl.NumberFormat('en-US').format(value)
  const tenths = (value * 10n) / divisor
  return `${tenths / 10n}.${tenths % 10n}${units[unitIndex]}`
}

export function splitPascal(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
}
