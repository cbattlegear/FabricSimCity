import { describe, expect, it } from 'vitest'

import {
  SNAPSHOT_CACHE_SCHEMA_VERSION,
  defaultAppPreferences,
  deserializePreferences,
  serializePreferences,
  snapshotCacheKey,
  type SnapshotCacheScope,
} from './appState'
import type { AtlasSnapshot, Evidence } from './fabricContracts'
import type { CapacitySource } from './collect/source'
import {
  MemoryAppStateStore,
  createConfiguredAppStateStore,
  createMemoryAppStateBacking,
} from './services/appState'
import { createCachedCapacitySource } from './services/cachedCapacitySource'
import type { AuthUser } from './services/IAuthService'

const OWNER: AuthUser = {
  id: 'user-123',
  email: 'viewer@example.com',
  name: 'Viewer',
}

const TENANT_ID = 'tenant-abc'

const ATLAS_SCOPE: SnapshotCacheScope = {
  tenantId: TENANT_ID,
  sourceKind: 'SemanticModel',
  snapshotKind: 'Atlas',
  request: {
    metric: 'Cu',
    window: { end: '2026-09-04T12:30:00.000Z', start: '2026-09-04T12:00:00.000Z' },
  },
}

const EVIDENCE: Evidence = {
  source: 'SemanticModel',
  status: 'Available',
  observedAt: '2026-09-04T12:00:00.000Z',
  freshUntil: '2026-09-04T12:15:00.000Z',
}

function atlasSnapshot(capacityId = 'capacity-a'): AtlasSnapshot {
  return {
    schemaVersion: '1.0',
    snapshotId: 'snapshot-a',
    tenant: { tenantId: TENANT_ID, displayName: 'Contoso Fabric' },
    generatedAt: '2026-09-04T12:01:00.000Z',
    capacities: [{
      capacityId,
      displayName: 'Production F64',
      sku: 'F64',
      capacityUnits: 64,
      region: 'westus',
      state: 'Active',
      stateReason: 'NotOverloaded',
      cuConsumed: { cuSeconds: '10.5', status: 'Known', evidence: EVIDENCE },
      meanUtilizationPercent: 12,
      peakUtilizationPercent: 30,
      storage: { bytes: '1024', status: 'Known', evidence: EVIDENCE },
      workspaceCount: 1,
      itemCount: 2,
      throttle: {
        stage: 'None',
        interactiveDelayPercent: 10,
        interactiveRejectionPercent: 4,
        backgroundRejectionPercent: 1,
        cumulativeCarryOverPercent: 0,
        expectedBurndownMinutes: 0,
        surgeProtectionActive: false,
        evidence: EVIDENCE,
      },
    }],
    links: [],
    collection: {
      source: 'SemanticModel',
      state: 'Ready',
      collectedAt: '2026-09-04T12:01:00.000Z',
      isStale: false,
      capacityCount: 1,
      failureCount: 0,
      durationMilliseconds: 1200,
    },
  }
}

describe('snapshot cache keys', () => {
  it('includes the cache schema version and stable request fingerprint', () => {
    const sameRequestDifferentOrder: SnapshotCacheScope = {
      ...ATLAS_SCOPE,
      request: {
        window: { start: '2026-09-04T12:00:00.000Z', end: '2026-09-04T12:30:00.000Z' },
        metric: 'Cu',
      },
    }

    expect(snapshotCacheKey(ATLAS_SCOPE)).toBe(snapshotCacheKey(sameRequestDifferentOrder))
    expect(snapshotCacheKey(ATLAS_SCOPE)).toContain(SNAPSHOT_CACHE_SCHEMA_VERSION)
    expect(snapshotCacheKey(ATLAS_SCOPE, 'snapshot-cache:v0'))
      .not.toBe(snapshotCacheKey(ATLAS_SCOPE))
  })

  it('does not serve a legacy-shape entry after the cache schema version changes', async () => {
    const backing = createMemoryAppStateBacking()
    const legacyStore = new MemoryAppStateStore(
      OWNER,
      TENANT_ID,
      backing,
      { cacheSchemaVersion: 'snapshot-cache:v0' },
    )
    const currentStore = new MemoryAppStateStore(OWNER, TENANT_ID, backing)

    await legacyStore.writeCachedSnapshot(ATLAS_SCOPE, { oldShape: true }, new Date('2026-09-04T12:02:00.000Z'))

    await expect(currentStore.readCachedSnapshot<AtlasSnapshot>(ATLAS_SCOPE))
      .resolves.toMatchObject({ status: 'miss', reason: 'NotFound' })
  })
})

describe('snapshot cache evidence', () => {
  it('preserves the snapshot observation time instead of re-stamping it as cache time', async () => {
    const store = new MemoryAppStateStore(OWNER, TENANT_ID, createMemoryAppStateBacking())
    const cachedAt = new Date('2026-09-04T12:20:00.000Z')

    const result = await store.writeCachedSnapshot(ATLAS_SCOPE, atlasSnapshot(), cachedAt)

    expect(result.status).toBe('hit')
    if (result.status !== 'hit') return
    expect(result.observedAt).toBe('2026-09-04T12:00:00.000Z')
    expect(result.cachedAt).toBe('2026-09-04T12:20:00.000Z')
    expect(result.snapshot.capacities[0].cuConsumed.evidence.observedAt)
      .toBe('2026-09-04T12:00:00.000Z')
    expect(result.stale).toBe(true)
  })

  it('distinguishes a cold miss from a measured-empty snapshot', async () => {
    const store = new MemoryAppStateStore(OWNER, TENANT_ID, createMemoryAppStateBacking())
    const emptySnapshot = { ...atlasSnapshot(), capacities: [], links: [] }

    await expect(store.readCachedSnapshot<AtlasSnapshot>(ATLAS_SCOPE))
      .resolves.toMatchObject({ status: 'miss', reason: 'NotFound' })

    const result = await store.writeCachedSnapshot(ATLAS_SCOPE, emptySnapshot)

    expect(result.status).toBe('hit')
    if (result.status !== 'hit') return
    expect(result.snapshot.capacities).toEqual([])
  })
})

describe('cached capacity source', () => {
  it('serves a reload from the cache without re-fetching the source', async () => {
    const store = new MemoryAppStateStore(OWNER, TENANT_ID, createMemoryAppStateBacking())
    let atlasReads = 0
    const source: CapacitySource = {
      kind: 'SemanticModel',
      capabilities: {
        perItemBreakdown: true,
        operationFamilies: true,
        operationSamples: true,
        timepoints: true,
        latencySeconds: 900,
        retentionDays: 14,
      },
      async readAtlas() {
        atlasReads += 1
        return atlasSnapshot(`capacity-${atlasReads}`)
      },
      async readCitySummaries() {
        throw new Error('not used')
      },
      async readCityPage() {
        throw new Error('not used')
      },
      async readTimepoints() {
        throw new Error('not used')
      },
      async readOperationSamples() {
        throw new Error('not used')
      },
    }
    const cached = createCachedCapacitySource(source, store, { tenantId: TENANT_ID })

    const first = await cached.readAtlas()
    const second = await cached.readAtlas()

    expect(atlasReads).toBe(1)
    expect(second).toEqual(first)
    expect(second.capacities[0].capacityId).toBe('capacity-1')
  })
})

describe('application preferences and saved views', () => {
  it('round-trips the real UI preferences', async () => {
    const store = new MemoryAppStateStore(OWNER, TENANT_ID, createMemoryAppStateBacking())
    const saved = await store.savePreferences({
      ...defaultAppPreferences(TENANT_ID, new Date('2026-09-04T06:00:00.000Z')),
      kioskMode: true,
      sidebarMode: 'Route',
      sidebarRegion: 'plans',
      timeOfDay: 'night',
      viewMode: 'map',
      chosenMetric: 'Storage',
      chosenSource: 'Eventhouse',
    }, new Date('2026-09-04T12:30:00.000Z'))

    expect(await store.readPreferences()).toEqual(saved)
    expect(deserializePreferences(serializePreferences(saved))).toEqual(saved)
  })

  it('serializes a named saved camera view', async () => {
    const store = new MemoryAppStateStore(OWNER, TENANT_ID, createMemoryAppStateBacking())
    const saved = await store.saveSavedView({
      name: 'Morning storage map',
      level: 'CapacityCity',
      viewMode: 'map',
      camera: {
        position: [1, 2, 3],
        target: [4, 5, 6],
        zoom: 1.25,
        headingDegrees: 90,
        pitchDegrees: 45,
      },
      capacityId: 'capacity-a',
      metric: 'Storage',
      sourceKind: 'SemanticModel',
      windowStart: '2026-09-04T12:00:00.000Z',
      windowEnd: '2026-09-04T12:30:00.000Z',
      sidebarRegion: 'directory',
    }, new Date('2026-09-04T12:35:00.000Z'))

    await expect(store.listSavedViews()).resolves.toEqual([saved])
  })

  it('keeps saved views scoped to their owner as well as their tenant', async () => {
    const backing = createMemoryAppStateBacking()
    const firstStore = new MemoryAppStateStore(OWNER, TENANT_ID, backing)
    const secondStore = new MemoryAppStateStore({
      id: 'user-456',
      email: 'other@example.com',
      name: 'Other',
    }, TENANT_ID, backing)

    await firstStore.saveSavedView({
      name: 'Only mine',
      level: 'Atlas',
      viewMode: 'city',
      camera: { position: [0, 1, 2], target: [0, 0, 0] },
    })

    await expect(secondStore.listSavedViews()).resolves.toEqual([])
  })

  it('uses an in-memory tenant-less store in fixture mode', async () => {
    const store = createConfiguredAppStateStore(null, 'fixture-tenant')

    const preferences = await store.savePreferences({
      ...defaultAppPreferences('fixture-tenant', new Date('2026-09-04T08:00:00.000Z')),
      kioskMode: true,
    })

    await expect(store.readPreferences()).resolves.toMatchObject({
      tenantId: 'fixture-tenant',
      kioskMode: preferences.kioskMode,
    })
  })
})
