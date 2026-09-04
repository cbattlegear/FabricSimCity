import type { CapacityCityMetric } from './capacityCityContracts'
import type { CapacitySourceKind } from './collect/source'
import type { AuthUser } from './services/IAuthService'
import type { MapViewMode } from './mapStyle'
import type { SidebarRegion } from './sidebarAccordion'
import { resolveTimeOfDay, type TimeOfDay } from './timeOfDay'

export const SNAPSHOT_CACHE_SCHEMA_VERSION = 'snapshot-cache:v1'
export const SAVED_VIEW_SCHEMA_VERSION = 'saved-view:v1'
export const USER_PREFERENCES_SCHEMA_VERSION = 'user-preferences:v1'

export type SnapshotKind =
  | 'Atlas'
  | 'CitySummaries'
  | 'CityPage'
  | 'Timepoints'
  | 'OperationSamples'
  | 'Topology'

export type SidebarModePreference = 'AddressBook' | 'Route'
export type SavedViewLevel = 'Atlas' | 'CapacityCity'

export type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface SnapshotCacheScope {
  tenantId: string
  sourceKind: CapacitySourceKind
  snapshotKind: SnapshotKind
  request?: JsonValue
}

export interface SnapshotEvidenceSummary {
  observedAt: string | null
  freshUntil: string | null
}

export interface CachedSnapshotMiss {
  status: 'miss'
  cacheKey: string
  reason: 'NotFound' | 'Incomplete' | 'HashMismatch'
}

export interface CachedSnapshotHit<TSnapshot> extends SnapshotEvidenceSummary {
  status: 'hit'
  cacheKey: string
  snapshot: TSnapshot
  cachedAt: string
  stale: boolean
}

export type CachedSnapshotResult<TSnapshot> =
  | CachedSnapshotHit<TSnapshot>
  | CachedSnapshotMiss

export interface AppPreferences {
  schemaVersion: typeof USER_PREFERENCES_SCHEMA_VERSION
  tenantId: string
  kioskMode: boolean
  sidebarMode: SidebarModePreference
  sidebarRegion: SidebarRegion | null
  timeOfDay: TimeOfDay
  viewMode: MapViewMode
  chosenMetric: CapacityCityMetric
  chosenSource: CapacitySourceKind
  updatedAt: string
}

export interface SavedViewCamera {
  position: readonly [number, number, number]
  target: readonly [number, number, number]
  zoom?: number | null
  headingDegrees?: number | null
  pitchDegrees?: number | null
}

export interface SavedViewState {
  id: string
  schemaVersion: typeof SAVED_VIEW_SCHEMA_VERSION
  tenantId: string
  name: string
  level: SavedViewLevel
  viewMode: MapViewMode
  camera: SavedViewCamera
  capacityId: string | null
  selectedItemId: string | null
  metric: CapacityCityMetric | null
  sourceKind: CapacitySourceKind | null
  windowStart: string | null
  windowEnd: string | null
  sidebarRegion: SidebarRegion | null
  createdAt: string
  updatedAt: string
}

export interface SavedViewDraft {
  id?: string
  name: string
  level: SavedViewLevel
  viewMode: MapViewMode
  camera: SavedViewCamera
  capacityId?: string | null
  selectedItemId?: string | null
  metric?: CapacityCityMetric | null
  sourceKind?: CapacitySourceKind | null
  windowStart?: string | null
  windowEnd?: string | null
  sidebarRegion?: SidebarRegion | null
}

function stableStringifyValue(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringifyValue).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringifyValue(value[key])}`)
    .join(',')}}`
}

export function snapshotRequestFingerprint(request: JsonValue | undefined): string {
  return stableStringifyValue(request ?? {})
}

export function snapshotCacheKey(
  scope: SnapshotCacheScope,
  cacheSchemaVersion = SNAPSHOT_CACHE_SCHEMA_VERSION,
): string {
  return [
    cacheSchemaVersion,
    `tenant=${scope.tenantId}`,
    `source=${scope.sourceKind}`,
    `kind=${scope.snapshotKind}`,
    `request=${snapshotRequestFingerprint(scope.request)}`,
  ].join('|')
}

function mix32(seed: number, text: string): number {
  let hash = seed
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 2654435761)
    hash = (hash ^ (hash >>> 16)) >>> 0
  }
  return hash >>> 0
}

function wordHex(word: number): string {
  return word.toString(16).padStart(8, '0')
}

export function hashText(text: string): string {
  return [
    wordHex(mix32(0x243f6a88, text)),
    wordHex(mix32(0x85a308d3, text)),
    wordHex(mix32(0x13198a2e, text)),
    wordHex(mix32(0x03707344, text)),
  ].join('')
}

export function deterministicUuid(text: string): string {
  const hex = hashText(text).slice(0, 32).split('')
  hex[12] = '5'
  const variant = Number.parseInt(hex[16], 16)
  hex[16] = ((variant & 0x3) | 0x8).toString(16)
  const joined = hex.join('')
  return [
    joined.slice(0, 8),
    joined.slice(8, 12),
    joined.slice(12, 16),
    joined.slice(16, 20),
    joined.slice(20),
  ].join('-')
}

function ownerKey(owner: AuthUser): string {
  return `${owner.id}|${owner.email.toLocaleLowerCase()}`
}

export function snapshotRecordId(owner: AuthUser, cacheKey: string): string {
  return deterministicUuid(`cached-snapshot|${ownerKey(owner)}|${cacheKey}`)
}

export function snapshotChunkRecordId(snapshotId: string, chunkIndex: number): string {
  return deterministicUuid(`cached-snapshot-chunk|${snapshotId}|${chunkIndex}`)
}

export function preferencesRecordId(owner: AuthUser, tenantId: string): string {
  return deterministicUuid(
    `${USER_PREFERENCES_SCHEMA_VERSION}|${ownerKey(owner)}|tenant=${tenantId}`,
  )
}

export function savedViewRecordId(owner: AuthUser, tenantId: string, seed: string): string {
  return deterministicUuid(`${SAVED_VIEW_SCHEMA_VERSION}|${ownerKey(owner)}|tenant=${tenantId}|${seed}`)
}

export function serializeSnapshot(snapshot: unknown): string {
  return JSON.stringify(snapshot)
}

export function deserializeSnapshot<TSnapshot>(payload: string): TSnapshot {
  return JSON.parse(payload) as TSnapshot
}

function isEvidenceLike(value: unknown): value is SnapshotEvidenceSummary {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return 'observedAt' in record && 'freshUntil' in record
}

function pushIso(values: string[], value: unknown): void {
  if (typeof value === 'string' && value.length > 0) values.push(value)
}

export function extractSnapshotEvidence(snapshot: unknown): SnapshotEvidenceSummary {
  const observed: string[] = []
  const fresh: string[] = []
  const seen = new Set<unknown>()
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (isEvidenceLike(value)) {
      pushIso(observed, value.observedAt)
      pushIso(fresh, value.freshUntil)
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    for (const item of Object.values(value)) visit(item)
  }
  visit(snapshot)
  observed.sort()
  fresh.sort()
  return {
    observedAt: observed[0] ?? null,
    freshUntil: fresh[0] ?? null,
  }
}

export function isSnapshotStale(freshUntil: string | null, now: Date): boolean {
  return freshUntil !== null && Date.parse(freshUntil) <= now.getTime()
}

export function splitPayloadChunks(payload: string, chunkSize = 3500): string[] {
  if (payload.length === 0) return ['']
  const chunks: string[] = []
  for (let index = 0; index < payload.length; index += chunkSize) {
    chunks.push(payload.slice(index, index + chunkSize))
  }
  return chunks
}

export function joinPayloadChunks(chunks: readonly string[]): string {
  return chunks.join('')
}

export function defaultAppPreferences(
  tenantId: string,
  now: Date,
  chosenSource: CapacitySourceKind = 'Fixture',
): AppPreferences {
  return {
    schemaVersion: USER_PREFERENCES_SCHEMA_VERSION,
    tenantId,
    kioskMode: false,
    sidebarMode: 'AddressBook',
    sidebarRegion: null,
    timeOfDay: resolveTimeOfDay(now),
    viewMode: 'city',
    chosenMetric: 'Cu',
    chosenSource,
    updatedAt: now.toISOString(),
  }
}

export function serializePreferences(preferences: AppPreferences): string {
  return JSON.stringify(preferences)
}

export function deserializePreferences(payload: string): AppPreferences {
  const parsed = JSON.parse(payload) as AppPreferences
  if (parsed.schemaVersion !== USER_PREFERENCES_SCHEMA_VERSION) {
    throw new Error(`Unsupported preferences schema version: ${parsed.schemaVersion}`)
  }
  return parsed
}

export function serializeCamera(camera: SavedViewCamera): string {
  return JSON.stringify(camera)
}

export function deserializeCamera(payload: string): SavedViewCamera {
  return JSON.parse(payload) as SavedViewCamera
}
