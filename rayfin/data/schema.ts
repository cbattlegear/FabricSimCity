import {
  authenticated,
  boolean,
  date,
  entity,
  email,
  int,
  set,
  text,
  uuid,
  type RoleDeclarationOptions,
} from '@microsoft/rayfin-core'

type IngestQueryName = 'schemaProbe' | 'capacitySummary' | 'cityItems' | 'operationFamilies' | 'timepoints'
type IngestRunStatus = 'Running' | 'Complete' | 'Failed'

interface OwnedRow {
  ownerSub: string
  ownerEmail: string
}

const ownedBySignedInUser = {
  policy: (claims, row) =>
    claims.sub.eq(row.ownerSub).and(claims.email.eq(row.ownerEmail)),
} satisfies RoleDeclarationOptions<OwnedRow>

type CapacitySourceKind = 'SemanticModel' | 'Eventhouse' | 'Fixture'
type SnapshotKind =
  | 'Atlas'
  | 'CitySummaries'
  | 'CityPage'
  | 'Timepoints'
  | 'OperationSamples'
  | 'Topology'
type CapacityMetric = 'Cu' | 'Duration' | 'Operations' | 'Storage'
type MapViewMode = 'map' | 'city'
type SidebarRegion = 'directory' | 'activity' | 'plans' | 'legend'
type SidebarModePreference = 'AddressBook' | 'Route'
type TimeOfDay = 'morning' | 'day' | 'evening' | 'night'
type SavedViewLevel = 'Atlas' | 'CapacityCity'

@entity()
@authenticated('*', ownedBySignedInUser)
export class CachedSnapshot {
  @uuid()
  id!: string

  @text({ max: 256 })
  ownerSub!: string

  @email({ max: 320 })
  ownerEmail!: string

  @text({ max: 128 })
  tenantId!: string

  @set('SemanticModel', 'Eventhouse', 'Fixture')
  sourceKind!: CapacitySourceKind

  @set('Atlas', 'CitySummaries', 'CityPage', 'Timepoints', 'OperationSamples', 'Topology')
  snapshotKind!: SnapshotKind

  @text({ max: 48 })
  cacheSchemaVersion!: string

  @text({ max: 48 })
  payloadSchemaVersion!: string

  @text({ max: 768 })
  cacheKey!: string

  @text({ max: 512 })
  requestFingerprint!: string

  @date({ optional: true })
  observedAt?: Date

  @date({ optional: true })
  freshUntil?: Date

  @date()
  cachedAt!: Date

  @date()
  updatedAt!: Date

  @int({ min: 0 })
  payloadLength!: number

  @int({ min: 0 })
  chunkCount!: number

  @text({ max: 64 })
  payloadHash!: string
}

@entity()
@authenticated('*', ownedBySignedInUser)
export class CachedSnapshotChunk {
  @uuid()
  id!: string

  @text({ max: 256 })
  ownerSub!: string

  @email({ max: 320 })
  ownerEmail!: string

  @text({ max: 128 })
  tenantId!: string

  @uuid()
  snapshotId!: string

  @int({ min: 0 })
  chunkIndex!: number

  @text({ max: 3500 })
  chunkText!: string
}

@entity()
@authenticated('*', ownedBySignedInUser)
export class SavedView {
  @uuid()
  id!: string

  @text({ max: 256 })
  ownerSub!: string

  @email({ max: 320 })
  ownerEmail!: string

  @text({ max: 128 })
  tenantId!: string

  @text({ max: 48 })
  schemaVersion!: string

  @text({ max: 120 })
  name!: string

  @set('Atlas', 'CapacityCity')
  level!: SavedViewLevel

  @set('map', 'city')
  viewMode!: MapViewMode

  @text({ max: 2048 })
  cameraJson!: string

  @text({ optional: true, max: 128 })
  capacityId?: string

  @text({ optional: true, max: 128 })
  selectedItemId?: string

  @set({ optional: true }, 'Cu', 'Duration', 'Operations', 'Storage')
  metric?: CapacityMetric

  @set({ optional: true }, 'SemanticModel', 'Eventhouse', 'Fixture')
  sourceKind?: CapacitySourceKind

  @date({ optional: true })
  windowStart?: Date

  @date({ optional: true })
  windowEnd?: Date

  @set({ optional: true }, 'directory', 'activity', 'plans', 'legend')
  sidebarRegion?: SidebarRegion

  @date()
  createdAt!: Date

  @date()
  updatedAt!: Date
}

@entity()
@authenticated('*', ownedBySignedInUser)
export class UserPreference {
  @uuid()
  id!: string

  @text({ max: 256 })
  ownerSub!: string

  @email({ max: 320 })
  ownerEmail!: string

  @text({ max: 128 })
  tenantId!: string

  @text({ max: 48 })
  schemaVersion!: string

  @boolean()
  kioskMode!: boolean

  @set('AddressBook', 'Route')
  sidebarMode!: SidebarModePreference

  @set({ optional: true }, 'directory', 'activity', 'plans', 'legend')
  sidebarRegion?: SidebarRegion

  @set('morning', 'day', 'evening', 'night')
  timeOfDay!: TimeOfDay

  @set('map', 'city')
  viewMode!: MapViewMode

  @set('Cu', 'Duration', 'Operations', 'Storage')
  chosenMetric!: CapacityMetric

  @set('SemanticModel', 'Eventhouse', 'Fixture')
  chosenSource!: CapacitySourceKind

  @date()
  updatedAt!: Date
}

/**
 * One run of the Fabric ingest notebook.
 *
 * The row table below is written a few thousand rows at a time, so a reader that simply took "the
 * newest rows" would draw a half-ingested city while the notebook is still running. Readers select
 * the newest run whose status is `Complete` and read only rows carrying that `runId`, which makes
 * the swap atomic without the database needing a transaction that spans the whole notebook.
 *
 * Read-only from the app: the notebook writes over a direct SQL connection, not through the data
 * API, so no create/update/delete permission is granted here. Nothing a signed-in user can do
 * through the app can forge telemetry.
 */
@entity()
@authenticated('read')
export class IngestRun {
  @uuid()
  id!: string

  @text({ max: 128 })
  tenantId!: string

  /**
   * Which capacity metrics semantic model this run read, so a tenant with more than one does not
   * silently interleave them into a single city.
   */
  @text({ max: 128 })
  datasetId!: string

  @text({ max: 64 })
  schemaGeneration!: string

  @set('Running', 'Complete', 'Failed')
  status!: IngestRunStatus

  @date()
  startedAt!: Date

  @date({ optional: true })
  completedAt?: Date

  /** Inclusive ISO start of the DAX window this run asked for. */
  @date()
  windowStart!: Date

  /** Exclusive ISO end of the DAX window this run asked for. */
  @date()
  windowEnd!: Date

  @int({ min: 0 })
  rowCount!: number

  /** Populated when `status` is `Failed`, so the app can say why rather than just showing stale data. */
  @text({ optional: true, max: 1024 })
  failureMessage?: string
}

/**
 * One row of one DAX result, stored verbatim.
 *
 * Deliberately untransformed. The 40 KB of parsing in `semanticModelSource.ts` already turns these
 * rows into the app's contracts, and it is the only place that knows how the Capacity Metrics
 * schema maps onto them. Storing shaped output instead would mean porting all of that to Python and
 * then keeping two copies correct, so the notebook stays dumb and the transform stays in one place.
 */
@entity()
@authenticated('read')
export class IngestRow {
  @uuid()
  id!: string

  @uuid()
  runId!: string

  @text({ max: 128 })
  tenantId!: string

  @set('schemaProbe', 'capacitySummary', 'cityItems', 'operationFamilies', 'timepoints')
  queryName!: IngestQueryName

  /**
   * The capacity this row belongs to, or empty for the tenant-wide queries.
   *
   * Stored as its own column rather than being read back out of `rowJson` because it is the only
   * parameter the app filters on, and filtering in SQL is what keeps a city page from pulling every
   * capacity's rows across the wire.
   */
  @text({ max: 128 })
  capacityId!: string

  /** Preserves DAX result order, which `ORDER BY` in the query text is there to establish. */
  @int({ min: 0 })
  rowIndex!: number

  /**
   * The row's own timepoint, when it has one.
   *
   * `readTimepoints` asks for a window narrower than the one ingested, and the source trusts its
   * query to have filtered. Lifting the timestamp into a column lets the reader apply that window
   * in SQL without teaching it which Capacity Metrics column holds the timestamp.
   */
  @date({ optional: true })
  rowTimestamp?: Date

  @text({ max: 3500 })
  rowJson!: string
}

export type AppSchema = {
  CachedSnapshot: CachedSnapshot
  CachedSnapshotChunk: CachedSnapshotChunk
  IngestRun: IngestRun
  IngestRow: IngestRow
  SavedView: SavedView
  UserPreference: UserPreference
}

export const schema = [
  CachedSnapshot,
  CachedSnapshotChunk,
  IngestRun,
  IngestRow,
  SavedView,
  UserPreference,
]
