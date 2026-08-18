import type { DatabaseCityObject, DatabaseCityRoute } from './databaseCityContracts'
import type { EvidenceSource } from './contracts'

export function accessibleObjectLabel(object: DatabaseCityObject): string {
  const size = object.reservedBytes === null
    ? `unknown nonquantitative size, ${object.sizeReason ?? 'size evidence unavailable'}`
    : `${formatKiB(object.reservedBytes)} reserved`
  const indexCount = `${object.indexes.length} attached ${object.indexes.length === 1 ? 'index' : 'indexes'}`
  const direct = object.directActivity.totalOperations === null
    ? `direct DMV activity ${object.directActivity.evidence.status.toLowerCase()}: ${object.directActivity.evidence.reason}`
    : `direct DMV activity ${object.directActivity.totalOperations} operations`
  const exposure = object.attributedExposure.totalCpuMicroseconds === null
    ? `attributed Query Store exposure ${object.attributedExposure.evidence.status.toLowerCase()}`
    : `attributed Query Store exposure ${object.attributedExposure.totalCpuMicroseconds} CPU microseconds`
  return `${object.schemaName}.${object.name}, ${object.kind}, ${size}, ${indexCount}, ${direct}, ${exposure}. ${object.attributedExposure.rationale}`
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
  route: DatabaseCityRoute,
  visibleObjectIds: ReadonlySet<string>,
): boolean {
  return visibleObjectIds.has(route.fromObjectId) &&
    (visibleObjectIds.has(route.toId) || route.kind === 'CrossDatabaseReference')
}

export function formatKiB(bytes: string): string {
  return `${(BigInt(bytes) / 1024n).toLocaleString()} KiB`
}

export function databaseCityMetricValue(
  object: DatabaseCityObject,
  metric: 'cpu' | 'duration' | 'reads' | 'executions',
): string | null {
  switch (metric) {
    case 'cpu': return object.attributedExposure.totalCpuMicroseconds
    case 'duration': return object.attributedExposure.totalDurationMicroseconds
    case 'reads': return object.attributedExposure.totalLogicalReads8KiBPages
    case 'executions': return object.attributedExposure.executionCount
  }
}
