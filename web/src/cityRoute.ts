import type { NormalizedShowplan, ShowplanNode, ShowplanObjectReference } from './contracts'
import type { DatabaseCityObject } from './databaseCityContracts'
import type { CityPlan } from './cityPlan'
import { streetPolyline } from './cityPlan'
import { FACILITY_LABELS, type FacilityKind, type FacilitySite } from './cityInfrastructure'

/**
 * Turns a compiled query plan into a driving route through the city.
 *
 * Every operator in the plan becomes exactly one stop -- nothing is silently dropped, including
 * operators whose object reference cannot be matched to a loaded building. The traversal is
 * **post-order** (children before parents) because that is the direction data flows through a
 * showplan tree: the leaves fetch rows and the root returns them.
 *
 * This describes the plan's *compiled shape*, never live operator progress. Callers must surface
 * {@link NormalizedShowplan.runtimeOverlayCaveat} verbatim next to the route.
 */

export type StopKind = 'building' | 'facility' | 'offmap'

/** Physical operators that request a memory grant. They stop at the Memory Grant Office. */
export const MEMORY_GRANT_OPERATORS: ReadonlySet<string> = new Set([
  'Sort',
  'Hash Match',
  'Adaptive Join',
  'Window Aggregate',
])

/** Spools materialize into tempdb rather than a query memory grant, so they stop at tempdb Works. */
export const TEMPDB_OPERATORS: ReadonlySet<string> = new Set([
  'Table Spool',
  'Index Spool',
  'Row Count Spool',
  'Window Spool',
])

export interface RouteStop {
  /** 1-based position along the route, matching the numbered map pins. */
  readonly ordinal: number
  readonly nodeId: number
  readonly kind: StopKind
  readonly label: string
  /** Set for `building` stops. */
  readonly objectId: string | null
  /** Set when the operator named a specific index; the matching annex is highlighted. */
  readonly indexName: string | null
  /** Set for `facility` stops. */
  readonly facility: FacilityKind | null
  readonly x: number | null
  readonly z: number | null
  readonly physicalOperation: string
  readonly logicalOperation: string
  readonly estimatedRows: number | null
  readonly estimatedCpuCost: number | null
  readonly estimatedIoCost: number | null
  /** Turn-by-turn line shown in the route panel. */
  readonly instruction: string
  /** Present on `offmap` stops: why this operator has no place on the map. */
  readonly unresolvedReason: string | null
  readonly warnings: readonly string[]
}

export interface CityRoute {
  readonly planId: string
  readonly stops: readonly RouteStop[]
  /** World-space polyline following the street graph. Empty when no stop could be placed. */
  readonly polyline: ReadonlyArray<{ x: number; z: number }>
  /** Stops that could not be placed on the map, surfaced rather than hidden. */
  readonly offMapStops: readonly RouteStop[]
  /** Copied verbatim from the plan; never paraphrased. */
  readonly runtimeOverlayCaveat: string
}

export interface RouteContext {
  readonly plan: CityPlan
  readonly objects: readonly DatabaseCityObject[]
  readonly facilities: ReadonlyMap<FacilityKind, FacilitySite>
  /** Name of the database this city page was loaded for, used to detect cross-database references. */
  readonly databaseName: string
}

/** Post-order operator sequence: children in ascending node id, then the parent. */
export function operatorSequence(nodes: readonly ShowplanNode[]): ShowplanNode[] {
  if (nodes.length === 0) return []
  const byId = new Map<number, ShowplanNode>()
  for (const node of nodes) byId.set(node.nodeId, node)

  const children = new Map<number, number[]>()
  const roots: number[] = []
  for (const node of nodes) {
    if (node.parentNodeId === null || !byId.has(node.parentNodeId)) {
      roots.push(node.nodeId)
      continue
    }
    const bucket = children.get(node.parentNodeId)
    if (bucket) bucket.push(node.nodeId)
    else children.set(node.parentNodeId, [node.nodeId])
  }
  for (const bucket of children.values()) bucket.sort((a, b) => a - b)
  roots.sort((a, b) => a - b)

  const ordered: ShowplanNode[] = []
  const seen = new Set<number>()
  const walk = (nodeId: number): void => {
    if (seen.has(nodeId)) return
    seen.add(nodeId)
    for (const child of children.get(nodeId) ?? []) walk(child)
    const node = byId.get(nodeId)
    if (node) ordered.push(node)
  }
  for (const root of roots) walk(root)
  // A malformed tree (a cycle among parent links) must not lose operators.
  for (const node of nodes) if (!seen.has(node.nodeId)) ordered.push(node)
  return ordered
}

/** Strips showplan bracket quoting: `[dbo]` -> `dbo`. */
export function unquote(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
}

/**
 * Matches a showplan object reference to a loaded city object by `schema.table`, case-insensitively
 * and ignoring bracket quoting. Returns null when the reference names another database or an object
 * outside the loaded page -- both of which become explicit off-map stops.
 */
export function matchObject(
  reference: ShowplanObjectReference,
  objects: readonly DatabaseCityObject[],
  databaseName: string,
): DatabaseCityObject | null {
  const database = unquote(reference.database)
  if (database !== null && database.toLowerCase() !== databaseName.toLowerCase()) return null
  const schema = unquote(reference.schema)
  const table = unquote(reference.table)
  if (table === null) return null
  const wanted = `${schema ?? ''}.${table}`.toLowerCase()
  return (
    objects.find(object => `${object.schemaName}.${object.name}`.toLowerCase() === wanted) ??
    (schema === null
      ? objects.find(object => object.name.toLowerCase() === table.toLowerCase()) ?? null
      : null)
  )
}

/** Selects the facility a non-object operator visits, or null when it is pure compute. */
export function facilityForOperator(node: ShowplanNode): FacilityKind {
  if (MEMORY_GRANT_OPERATORS.has(node.physicalOperation)) return 'memory'
  if (TEMPDB_OPERATORS.has(node.physicalOperation)) return 'tempdb'
  if ((node.estimatedIoCost ?? 0) > 0) return 'storage'
  return 'cpu'
}

/**
 * Builds the ordered stop list. Precedence per operator: a resolvable object reference wins (the work
 * happens at that building), then memory/tempdb/storage facilities, then the CPU Scheduler Yard.
 */
export function planStops(showplan: NormalizedShowplan, context: RouteContext): RouteStop[] {
  const stops: RouteStop[] = []
  let ordinal = 0
  for (const node of operatorSequence(showplan.nodes)) {
    ordinal += 1
    stops.push(stopFor(node, ordinal, showplan, context))
  }
  return stops
}

function stopFor(
  node: ShowplanNode,
  ordinal: number,
  showplan: NormalizedShowplan,
  context: RouteContext,
): RouteStop {
  const warnings = node.warnings.map(warning =>
    warning.detail === null ? warning.kind : `${warning.kind}: ${warning.detail}`,
  )
  const base = {
    ordinal,
    nodeId: node.nodeId,
    physicalOperation: node.physicalOperation,
    logicalOperation: node.logicalOperation,
    estimatedRows: node.estimatedRows,
    estimatedCpuCost: node.estimatedCpuCost,
    estimatedIoCost: node.estimatedIoCost,
    warnings,
  }

  if (node.objectReference !== null) {
    const matched = matchObject(node.objectReference, context.objects, context.databaseName)
    if (matched) {
      const lot = context.plan.lots.get(matched.objectId)
      const indexName = unquote(node.objectReference.index)
      const label = `${matched.schemaName}.${matched.name}`
      return {
        ...base,
        kind: 'building',
        label,
        objectId: matched.objectId,
        indexName,
        facility: null,
        x: lot?.accessX ?? null,
        z: lot?.accessZ ?? null,
        instruction:
          `${node.physicalOperation} at ${label}` +
          (indexName === null ? '' : ` using ${indexName}`) +
          (node.estimatedRows === null ? '' : `, estimating ${formatRows(node.estimatedRows)} row(s)`),
        unresolvedReason: null,
      }
    }
    return {
      ...base,
      kind: 'offmap',
      label: describeReference(node.objectReference),
      objectId: null,
      indexName: unquote(node.objectReference.index),
      facility: null,
      x: null,
      z: null,
      instruction: `${node.physicalOperation} at ${describeReference(node.objectReference)} (off this map)`,
      unresolvedReason: unresolvedReason(node.objectReference, context.databaseName),
    }
  }

  const kind = facilityForOperator(node)
  const site = context.facilities.get(kind)
  return {
    ...base,
    kind: 'facility',
    label: FACILITY_LABELS[kind],
    objectId: null,
    indexName: null,
    facility: kind,
    x: site?.x ?? null,
    z: site?.z ?? null,
    instruction: facilityInstruction(node, kind, showplan),
    unresolvedReason:
      site === undefined ? `The ${FACILITY_LABELS[kind]} is not present on this map.` : null,
  }
}

function facilityInstruction(
  node: ShowplanNode,
  kind: FacilityKind,
  showplan: NormalizedShowplan,
): string {
  const rows = node.estimatedRows === null ? '' : `, estimating ${formatRows(node.estimatedRows)} row(s)`
  switch (kind) {
    case 'memory': {
      const requested =
        showplan.serialDesiredMemoryKiB === null
          ? 'an unreported grant'
          : `${formatRows(showplan.serialDesiredMemoryKiB)} KiB (plan-level serial desired memory)`
      return `${node.physicalOperation} stops at the ${FACILITY_LABELS.memory}, requesting ${requested}${rows}`
    }
    case 'tempdb':
      return `${node.physicalOperation} materializes at ${FACILITY_LABELS.tempdb}${rows}`
    case 'storage':
      return (
        `${node.physicalOperation} pulls from the ${FACILITY_LABELS.storage}` +
        (node.estimatedIoCost === null ? '' : `, estimated I/O cost ${node.estimatedIoCost}`) +
        rows
      )
    default:
      return (
        `${node.physicalOperation} runs at the ${FACILITY_LABELS.cpu}` +
        (node.estimatedCpuCost === null ? '' : `, estimated CPU cost ${node.estimatedCpuCost}`) +
        rows
      )
  }
}

function describeReference(reference: ShowplanObjectReference): string {
  const parts = [unquote(reference.database), unquote(reference.schema), unquote(reference.table)]
    .filter((part): part is string => part !== null)
  return parts.length === 0 ? 'an unnamed object' : parts.join('.')
}

function unresolvedReason(reference: ShowplanObjectReference, databaseName: string): string {
  const database = unquote(reference.database)
  if (database !== null && database.toLowerCase() !== databaseName.toLowerCase()) {
    return `This operator reads ${describeReference(reference)}, which is in database "${database}" rather than "${databaseName}". Load that database's city to see the building.`
  }
  return `${describeReference(reference)} is not in the currently loaded page of objects, so it has no building yet. Load more objects to place it.`
}

/** Route polyline following the street graph between consecutive placed stops. */
export function routeThroughStreets(
  stops: readonly RouteStop[],
  plan: CityPlan,
): Array<{ x: number; z: number }> {
  const placed = stops.filter(
    (stop): stop is RouteStop & { x: number; z: number } => stop.x !== null && stop.z !== null,
  )
  if (placed.length === 0) return []
  const points: Array<{ x: number; z: number }> = [{ x: placed[0].x, z: placed[0].z }]
  for (let index = 1; index < placed.length; index += 1) {
    const from = placed[index - 1]
    const to = placed[index]
    if (from.x === to.x && from.z === to.z) continue
    const leg = streetPolyline(plan, from, to)
    for (const point of leg.slice(1)) points.push(point)
  }
  return points
}

export function buildCityRoute(showplan: NormalizedShowplan, context: RouteContext): CityRoute {
  const stops = planStops(showplan, context)
  return {
    planId: showplan.planId,
    stops,
    polyline: routeThroughStreets(stops, context.plan),
    offMapStops: stops.filter(stop => stop.kind === 'offmap'),
    runtimeOverlayCaveat: showplan.runtimeOverlayCaveat,
  }
}

function formatRows(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}
