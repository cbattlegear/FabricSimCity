import type { CapacityCityItem, CapacityCityRoute } from '../capacityCityContracts'
import type { EvidenceSource } from '../fabricContracts'

export function accessibleObjectLabel(object: CapacityCityItem): string {
  const size = object.reservedBytes === null
    ? `unknown nonquantitative size, ${object.sizeReason ?? 'size evidence unavailable'}`
    : `${formatKiB(object.reservedBytes)} reserved`
  const indexCount = `${object.indexes.length} attached ${object.indexes.length === 1 ? 'index' : 'indexes'}`
  const direct = object.directActivity.totalOperations === null
    ? `direct DMV activity ${object.directActivity.evidence.status.toLowerCase()}: ${object.directActivity.evidence.reason}`
    : `direct DMV activity ${object.directActivity.totalOperations} operations`
  const exposure = object.attributedExposure.totalCpuMicroseconds === null
    ? `attributed Query Store exposure ${attributedAbsenceLabel(object).toLowerCase()}`
    : `attributed Query Store exposure ${object.attributedExposure.totalCpuMicroseconds} CPU microseconds`
  // Spoken separately from the attributed figure, because it is a query total that repeats on every
  // object the query named and must not be heard as this object's own measurement.
  const shared = object.attributedExposure.shared === null || object.attributedExposure.shared === undefined
    ? ''
    : ` Shared with other objects: ${object.attributedExposure.shared.totalCpuMicroseconds} CPU microseconds across ${object.attributedExposure.shared.familyCount} joined query families, not additive across buildings.`
  return `${object.workspaceName}.${object.name}, ${object.kind}, ${size}, ${indexCount}, ${direct}, ${exposure}. ${object.attributedExposure.rationale}${shared}`
}

/**
 * What to say in place of an attributed figure that isn't there.
 *
 * Two different absences used to collapse into one word. Before shared exposure existed, a null
 * total could only mean the Query Store probe failed, so echoing the evidence status read correctly.
 * Now a probe that succeeded perfectly can still attribute nothing to an object, because every
 * ranked query that named it also named other tables. Reporting that as "Available" — or as
 * "Unavailable" — would describe the wrong thing.
 */
export function attributedAbsenceLabel(object: CapacityCityItem): string {
  return object.attributedExposure.evidence.status === 'Available'
    ? 'Not attributed'
    : object.attributedExposure.evidence.status
}

export function shouldAnimateCurrentMarkers(
  source: EvidenceSource,
  fresh: boolean,
  reducedMotion: boolean,
): boolean {
  return source === 'LiveDmvSample' && fresh && !reducedMotion
}

export function directActivityWidth(totalOperations: string | null): number | null {
  if (totalOperations === null) return null
  return 3 + Math.log2(1 + Math.max(0, Number(BigInt(totalOperations)))) * 0.32
}

export function shouldRenderRoute(
  route: CapacityCityRoute,
  visibleObjectIds: ReadonlySet<string>,
): boolean {
  return visibleObjectIds.has(route.fromItemId) &&
    (visibleObjectIds.has(route.toId) || route.kind === 'CrossDatabaseReference')
}

export function formatKiB(bytes: string): string {
  return `${(BigInt(bytes) / 1024n).toLocaleString()} KiB`
}

export function databaseCityMetricValue(
  object: CapacityCityItem,
  metric: 'cpu' | 'duration' | 'reads' | 'executions',
): string | null {
  switch (metric) {
    case 'cpu': return object.attributedExposure.totalCpuMicroseconds
    case 'duration': return object.attributedExposure.totalDurationMicroseconds
    case 'reads': return object.attributedExposure.totalLogicalReads8KiBPages
    case 'executions': return object.attributedExposure.executionCount
  }
}

/**
 * The same metric taken from families that named this object *alongside others*. Deliberately a
 * separate call rather than a fallback inside {@link databaseCityMetricValue}: these totals belong
 * to the queries, repeat on every object those queries touched, and must never be silently
 * substituted for a measured per-object figure.
 */
export function databaseCitySharedMetricValue(
  object: CapacityCityItem,
  metric: 'cpu' | 'duration' | 'reads' | 'executions',
): string | null {
  const shared = object.attributedExposure.shared
  if (!shared) return null
  switch (metric) {
    case 'cpu': return shared.totalCpuMicroseconds
    case 'duration': return shared.totalDurationMicroseconds
    case 'reads': return shared.totalLogicalReads8KiBPages
    case 'executions': return shared.executionCount
  }
}
