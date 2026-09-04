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

export type AppSchema = {
  CachedSnapshot: CachedSnapshot
  CachedSnapshotChunk: CachedSnapshotChunk
  SavedView: SavedView
  UserPreference: UserPreference
}

export const schema = [CachedSnapshot, CachedSnapshotChunk, SavedView, UserPreference]
