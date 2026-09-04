import type { RayfinClient } from '@microsoft/rayfin-client'

import type {
  CachedSnapshot,
  CachedSnapshotChunk,
  SavedView,
  UserPreference,
  AppSchema,
} from '../../rayfin/data/schema'
import {
  SNAPSHOT_CACHE_SCHEMA_VERSION,
  SAVED_VIEW_SCHEMA_VERSION,
  USER_PREFERENCES_SCHEMA_VERSION,
  defaultAppPreferences,
  deserializeCamera,
  deserializeSnapshot,
  extractSnapshotEvidence,
  hashText,
  isSnapshotStale,
  joinPayloadChunks,
  preferencesRecordId,
  savedViewRecordId,
  serializeCamera,
  serializeSnapshot,
  snapshotCacheKey,
  snapshotChunkRecordId,
  snapshotRecordId,
  snapshotRequestFingerprint,
  splitPayloadChunks,
  type AppPreferences,
  type CachedSnapshotResult,
  type SavedViewDraft,
  type SavedViewState,
  type SnapshotCacheScope,
} from '../appState'
import { isFixtureMode } from './bootstrap'
import type { AuthUser } from './IAuthService'
import { getRayfinClient } from './rayfinClient'

export interface AppStateStore {
  readCachedSnapshot<TSnapshot>(
    scope: SnapshotCacheScope,
    now?: Date,
  ): Promise<CachedSnapshotResult<TSnapshot>>
  writeCachedSnapshot<TSnapshot>(
    scope: SnapshotCacheScope,
    snapshot: TSnapshot,
    now?: Date,
  ): Promise<CachedSnapshotResult<TSnapshot>>
  readPreferences(now?: Date): Promise<AppPreferences>
  savePreferences(preferences: AppPreferences, now?: Date): Promise<AppPreferences>
  listSavedViews(): Promise<SavedViewState[]>
  saveSavedView(view: SavedViewDraft, now?: Date): Promise<SavedViewState>
  deleteSavedView(id: string): Promise<void>
}

export interface AppStateStoreOptions {
  cacheSchemaVersion?: string
}

export interface MemoryBacking {
  cache: Map<string, MemorySnapshotRecord>
  preferences: Map<string, AppPreferences>
  savedViews: Map<string, SavedViewState>
}

export interface MemorySnapshotRecord {
  payload: string
  cachedAt: string
  observedAt: string | null
  freshUntil: string | null
}

export function createMemoryAppStateBacking(): MemoryBacking {
  return {
    cache: new Map<string, MemorySnapshotRecord>(),
    preferences: new Map<string, AppPreferences>(),
    savedViews: new Map<string, SavedViewState>(),
  }
}

const DEFAULT_MEMORY_BACKING = {
  cache: new Map<string, MemorySnapshotRecord>(),
  preferences: new Map<string, AppPreferences>(),
  savedViews: new Map<string, SavedViewState>(),
}

function optionalDate(value: string | null): Date | undefined {
  return value === null ? undefined : new Date(value)
}

function iso(value: Date | string | undefined | null): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : value
}

function defined<T>(value: T | null | undefined): T | undefined {
  return value == null ? undefined : value
}

function memoryKey(owner: AuthUser, tenantId: string, suffix: string): string {
  return `${owner.id}|${owner.email.toLocaleLowerCase()}|${tenantId}|${suffix}`
}

function savedViewFromDraft(
  owner: AuthUser,
  tenantId: string,
  draft: SavedViewDraft,
  now: Date,
): SavedViewState {
  const timestamp = now.toISOString()
  return {
    id: draft.id ?? savedViewRecordId(owner, tenantId, `${draft.name}|${timestamp}`),
    schemaVersion: SAVED_VIEW_SCHEMA_VERSION,
    tenantId,
    name: draft.name,
    level: draft.level,
    viewMode: draft.viewMode,
    camera: draft.camera,
    capacityId: draft.capacityId ?? null,
    selectedItemId: draft.selectedItemId ?? null,
    metric: draft.metric ?? null,
    sourceKind: draft.sourceKind ?? null,
    windowStart: draft.windowStart ?? null,
    windowEnd: draft.windowEnd ?? null,
    sidebarRegion: draft.sidebarRegion ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

export class MemoryAppStateStore implements AppStateStore {
  constructor(
    private readonly owner: AuthUser,
    private readonly tenantId: string,
    private readonly backing: MemoryBacking = DEFAULT_MEMORY_BACKING,
    private readonly options: AppStateStoreOptions = {},
  ) {}

  async readCachedSnapshot<TSnapshot>(
    scope: SnapshotCacheScope,
    now = new Date(),
  ): Promise<CachedSnapshotResult<TSnapshot>> {
    const cacheKey = snapshotCacheKey(scope, this.options.cacheSchemaVersion)
    const record = this.backing.cache.get(memoryKey(this.owner, scope.tenantId, cacheKey))
    if (!record) return { status: 'miss', cacheKey, reason: 'NotFound' }
    return {
      status: 'hit',
      cacheKey,
      snapshot: deserializeSnapshot<TSnapshot>(record.payload),
      cachedAt: record.cachedAt,
      observedAt: record.observedAt,
      freshUntil: record.freshUntil,
      stale: isSnapshotStale(record.freshUntil, now),
    }
  }

  async writeCachedSnapshot<TSnapshot>(
    scope: SnapshotCacheScope,
    snapshot: TSnapshot,
    now = new Date(),
  ): Promise<CachedSnapshotResult<TSnapshot>> {
    const cacheKey = snapshotCacheKey(scope, this.options.cacheSchemaVersion)
    const payload = serializeSnapshot(snapshot)
    const evidence = extractSnapshotEvidence(snapshot)
    const record = {
      payload,
      cachedAt: now.toISOString(),
      observedAt: evidence.observedAt,
      freshUntil: evidence.freshUntil,
    }
    this.backing.cache.set(memoryKey(this.owner, scope.tenantId, cacheKey), record)
    return this.readCachedSnapshot<TSnapshot>(scope, now)
  }

  async readPreferences(now = new Date()): Promise<AppPreferences> {
    const key = preferencesRecordId(this.owner, this.tenantId)
    return this.backing.preferences.get(key)
      ?? defaultAppPreferences(this.tenantId, now)
  }

  async savePreferences(preferences: AppPreferences, now = new Date()): Promise<AppPreferences> {
    const key = preferencesRecordId(this.owner, this.tenantId)
    const next: AppPreferences = {
      ...preferences,
      schemaVersion: USER_PREFERENCES_SCHEMA_VERSION,
      tenantId: this.tenantId,
      updatedAt: now.toISOString(),
    }
    this.backing.preferences.set(key, next)
    return next
  }

  async listSavedViews(): Promise<SavedViewState[]> {
    const prefix = memoryKey(this.owner, this.tenantId, '')
    return [...this.backing.savedViews.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, view]) => view)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async saveSavedView(view: SavedViewDraft, now = new Date()): Promise<SavedViewState> {
    const key = view.id ? memoryKey(this.owner, this.tenantId, view.id) : null
    const existing = key ? this.backing.savedViews.get(key) : undefined
    const next = {
      ...savedViewFromDraft(this.owner, this.tenantId, view, now),
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    }
    this.backing.savedViews.set(memoryKey(this.owner, this.tenantId, next.id), next)
    return next
  }

  async deleteSavedView(id: string): Promise<void> {
    this.backing.savedViews.delete(memoryKey(this.owner, this.tenantId, id))
  }
}

export class RayfinAppStateStore implements AppStateStore {
  private readonly cacheSchemaVersion: string

  constructor(
    private readonly client: RayfinClient<AppSchema>,
    private readonly owner: AuthUser,
    private readonly tenantId: string,
    options: AppStateStoreOptions = {},
  ) {
    this.cacheSchemaVersion = options.cacheSchemaVersion ?? SNAPSHOT_CACHE_SCHEMA_VERSION
  }

  async readCachedSnapshot<TSnapshot>(
    scope: SnapshotCacheScope,
    now = new Date(),
  ): Promise<CachedSnapshotResult<TSnapshot>> {
    const cacheKey = snapshotCacheKey(scope, this.cacheSchemaVersion)
    const snapshotId = snapshotRecordId(this.owner, cacheKey)
    const record = await this.client.data.CachedSnapshot.findById(snapshotId)
    if (!record) return { status: 'miss', cacheKey, reason: 'NotFound' }

    const chunks: CachedSnapshotChunk[] = []
    let cursor: string | undefined
    do {
      let query = this.client.data.CachedSnapshotChunk
        .select(['id', 'snapshotId', 'chunkIndex', 'chunkText'])
        .where({ snapshotId: { eq: snapshotId } })
        .orderBy({ chunkIndex: 'asc' })
        .first(100)
      if (cursor) query = query.after(cursor)
      const page = await query.executePaginated()
      chunks.push(...page.items)
      cursor = page.hasNextPage ? page.endCursor : undefined
    } while (cursor)

    if (chunks.length !== record.chunkCount) {
      return { status: 'miss', cacheKey, reason: 'Incomplete' }
    }

    const payload = joinPayloadChunks(chunks.map((chunk) => chunk.chunkText))
    if (payload.length !== record.payloadLength || hashText(payload) !== record.payloadHash) {
      return { status: 'miss', cacheKey, reason: 'HashMismatch' }
    }

    const freshUntil = iso(record.freshUntil)
    return {
      status: 'hit',
      cacheKey,
      snapshot: deserializeSnapshot<TSnapshot>(payload),
      cachedAt: iso(record.cachedAt) ?? now.toISOString(),
      observedAt: iso(record.observedAt),
      freshUntil,
      stale: isSnapshotStale(freshUntil, now),
    }
  }

  async writeCachedSnapshot<TSnapshot>(
    scope: SnapshotCacheScope,
    snapshot: TSnapshot,
    now = new Date(),
  ): Promise<CachedSnapshotResult<TSnapshot>> {
    const cacheKey = snapshotCacheKey(scope, this.cacheSchemaVersion)
    const snapshotId = snapshotRecordId(this.owner, cacheKey)
    const payload = serializeSnapshot(snapshot)
    const chunks = splitPayloadChunks(payload)
    const evidence = extractSnapshotEvidence(snapshot)
    const timestamp = now

    const existingChunks: CachedSnapshotChunk[] = []
    let cursor: string | undefined
    do {
      let query = this.client.data.CachedSnapshotChunk
        .select(['id', 'snapshotId', 'chunkIndex', 'chunkText'])
        .where({ snapshotId: { eq: snapshotId } })
        .orderBy({ chunkIndex: 'asc' })
        .first(100)
      if (cursor) query = query.after(cursor)
      const page = await query.executePaginated()
      existingChunks.push(...page.items)
      cursor = page.hasNextPage ? page.endCursor : undefined
    } while (cursor)

    const record = {
      id: snapshotId,
      ownerSub: this.owner.id,
      ownerEmail: this.owner.email,
      tenantId: scope.tenantId,
      sourceKind: scope.sourceKind,
      snapshotKind: scope.snapshotKind,
      cacheSchemaVersion: this.cacheSchemaVersion,
      payloadSchemaVersion: payloadSchemaVersion(snapshot),
      cacheKey,
      requestFingerprint: snapshotRequestFingerprint(scope.request),
      observedAt: optionalDate(evidence.observedAt),
      freshUntil: optionalDate(evidence.freshUntil),
      cachedAt: timestamp,
      updatedAt: timestamp,
      payloadLength: payload.length,
      chunkCount: chunks.length,
      payloadHash: hashText(payload),
    } satisfies CachedSnapshot

    await this.client.data.CachedSnapshot.upsert({ id: snapshotId }, record, record)

    await Promise.all(chunks.map((chunkText, chunkIndex) => {
      const chunk = {
        id: snapshotChunkRecordId(snapshotId, chunkIndex),
        ownerSub: this.owner.id,
        ownerEmail: this.owner.email,
        tenantId: scope.tenantId,
        snapshotId,
        chunkIndex,
        chunkText,
      } satisfies CachedSnapshotChunk
      return this.client.data.CachedSnapshotChunk.upsert({ id: chunk.id }, chunk, chunk)
    }))

    await Promise.all(
      existingChunks
        .filter((chunk) => chunk.chunkIndex >= chunks.length)
        .map((chunk) => this.client.data.CachedSnapshotChunk.delete({ id: chunk.id })),
    )

    return this.readCachedSnapshot<TSnapshot>(scope, now)
  }

  async readPreferences(now = new Date()): Promise<AppPreferences> {
    const id = preferencesRecordId(this.owner, this.tenantId)
    const record = await this.client.data.UserPreference.findById(id)
    if (!record) return defaultAppPreferences(this.tenantId, now)
    return {
      schemaVersion: USER_PREFERENCES_SCHEMA_VERSION,
      tenantId: record.tenantId,
      kioskMode: record.kioskMode,
      sidebarMode: record.sidebarMode,
      sidebarRegion: record.sidebarRegion ?? null,
      timeOfDay: record.timeOfDay,
      viewMode: record.viewMode,
      chosenMetric: record.chosenMetric,
      chosenSource: record.chosenSource,
      updatedAt: iso(record.updatedAt) ?? now.toISOString(),
    }
  }

  async savePreferences(preferences: AppPreferences, now = new Date()): Promise<AppPreferences> {
    const id = preferencesRecordId(this.owner, this.tenantId)
    const next: AppPreferences = {
      ...preferences,
      schemaVersion: USER_PREFERENCES_SCHEMA_VERSION,
      tenantId: this.tenantId,
      updatedAt: now.toISOString(),
    }
    const record = {
      id,
      ownerSub: this.owner.id,
      ownerEmail: this.owner.email,
      tenantId: this.tenantId,
      schemaVersion: USER_PREFERENCES_SCHEMA_VERSION,
      kioskMode: next.kioskMode,
      sidebarMode: next.sidebarMode,
      sidebarRegion: defined(next.sidebarRegion),
      timeOfDay: next.timeOfDay,
      viewMode: next.viewMode,
      chosenMetric: next.chosenMetric,
      chosenSource: next.chosenSource,
      updatedAt: now,
    } satisfies UserPreference
    await this.client.data.UserPreference.upsert({ id }, record, record)
    return next
  }

  async listSavedViews(): Promise<SavedViewState[]> {
    const views: SavedView[] = []
    let cursor: string | undefined
    do {
      let query = this.client.data.SavedView
        .select([
          'id',
          'tenantId',
          'schemaVersion',
          'name',
          'level',
          'viewMode',
          'cameraJson',
          'capacityId',
          'selectedItemId',
          'metric',
          'sourceKind',
          'windowStart',
          'windowEnd',
          'sidebarRegion',
          'createdAt',
          'updatedAt',
        ])
        .where({ tenantId: { eq: this.tenantId } })
        .orderBy({ updatedAt: 'desc' })
        .first(100)
      if (cursor) query = query.after(cursor)
      const page = await query.executePaginated()
      views.push(...page.items)
      cursor = page.hasNextPage ? page.endCursor : undefined
    } while (cursor)
    return views.map(savedViewFromEntity)
  }

  async saveSavedView(view: SavedViewDraft, now = new Date()): Promise<SavedViewState> {
    const existing = view.id ? await this.client.data.SavedView.findById(view.id) : null
    const state = {
      ...savedViewFromDraft(this.owner, this.tenantId, view, now),
      id: view.id ?? savedViewRecordId(this.owner, this.tenantId, `${view.name}|${now.toISOString()}`),
      createdAt: iso(existing?.createdAt) ?? now.toISOString(),
      updatedAt: now.toISOString(),
    }
    const record = {
      id: state.id,
      ownerSub: this.owner.id,
      ownerEmail: this.owner.email,
      tenantId: this.tenantId,
      schemaVersion: state.schemaVersion,
      name: state.name,
      level: state.level,
      viewMode: state.viewMode,
      cameraJson: serializeCamera(state.camera),
      capacityId: defined(state.capacityId),
      selectedItemId: defined(state.selectedItemId),
      metric: defined(state.metric),
      sourceKind: defined(state.sourceKind),
      windowStart: optionalDate(state.windowStart),
      windowEnd: optionalDate(state.windowEnd),
      sidebarRegion: defined(state.sidebarRegion),
      createdAt: new Date(state.createdAt),
      updatedAt: now,
    } satisfies SavedView
    await this.client.data.SavedView.upsert({ id: state.id }, record, record)
    return state
  }

  async deleteSavedView(id: string): Promise<void> {
    await this.client.data.SavedView.delete({ id })
  }
}

function payloadSchemaVersion(snapshot: unknown): string {
  if (snapshot && typeof snapshot === 'object' && 'schemaVersion' in snapshot) {
    const value = (snapshot as { schemaVersion?: unknown }).schemaVersion
    if (typeof value === 'string' && value.length > 0) return value
  }
  return 'unversioned'
}

function savedViewFromEntity(entity: SavedView): SavedViewState {
  return {
    id: entity.id,
    schemaVersion: SAVED_VIEW_SCHEMA_VERSION,
    tenantId: entity.tenantId,
    name: entity.name,
    level: entity.level,
    viewMode: entity.viewMode,
    camera: deserializeCamera(entity.cameraJson),
    capacityId: entity.capacityId ?? null,
    selectedItemId: entity.selectedItemId ?? null,
    metric: entity.metric ?? null,
    sourceKind: entity.sourceKind ?? null,
    windowStart: iso(entity.windowStart),
    windowEnd: iso(entity.windowEnd),
    sidebarRegion: entity.sidebarRegion ?? null,
    createdAt: iso(entity.createdAt) ?? '',
    updatedAt: iso(entity.updatedAt) ?? '',
  }
}

const FIXTURE_OWNER: AuthUser = {
  id: 'fixture-user',
  email: 'fixture@local.test',
  name: 'Fixture user',
}

export function createConfiguredAppStateStore(
  owner: AuthUser | null,
  tenantId: string,
): AppStateStore {
  if (isFixtureMode()) {
    return new MemoryAppStateStore(owner ?? FIXTURE_OWNER, tenantId)
  }
  if (!owner) {
    throw new Error('App state storage requires a signed-in user outside fixture mode.')
  }
  return new RayfinAppStateStore(getRayfinClient(), owner, tenantId)
}
