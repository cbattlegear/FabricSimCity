import { describe, expect, it } from 'vitest'
import { collectFabricTopology, sourceFailureForStatus } from '../../rayfin/functions/src/fabricTopology'
import { createTopologySource, failureFromUnknown, type FabricTopologySnapshot } from './topology'

const NOW = '2026-09-04T19:26:05.266Z'

type RouteBody = object | ((url: URL) => object | Promise<object>)

function ok(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fail(status: number, message: string): Response {
  return new Response(message, { status, statusText: message })
}

function mockFetch(routes: Record<string, RouteBody | Response>) {
  const calls: string[] = []
  let activeItems = 0
  let maxActiveItems = 0

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const key = `${url.pathname}${url.search}`
    calls.push(key)
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer fabric-token' })

    if (key.includes('/items')) {
      activeItems += 1
      maxActiveItems = Math.max(maxActiveItems, activeItems)
      await Promise.resolve()
    }

    try {
      const route = routes[key]
      if (!route) return fail(404, `missing route ${key}`)
      if (route instanceof Response) return route
      const body = typeof route === 'function' ? await route(url) : route
      return ok(body)
    } finally {
      if (key.includes('/items')) activeItems -= 1
    }
  }

  return { fetchImpl: fetchImpl as typeof fetch, calls, get maxActiveItems() { return maxActiveItems } }
}

function topology(partial = false): FabricTopologySnapshot {
  return {
    schemaVersion: '1.0',
    generatedAt: NOW,
    partial,
    capacities: [
      {
        capacityId: 'cap-a',
        displayName: 'Alpha',
        sku: 'F64',
        region: 'westus',
        state: 'Active',
        stateReason: 'NotOverloaded',
      },
    ],
    workspaces: [
      { workspaceId: 'workspace-a', capacityId: 'cap-a', name: 'Workspace A' },
      { workspaceId: 'workspace-b', capacityId: 'cap-a', name: 'Workspace B' },
    ],
    items: [
      {
        itemId: 'pipeline-1',
        workspaceId: 'workspace-a',
        capacityId: 'cap-a',
        name: 'Pipeline',
        itemType: 'DataPipeline',
      },
      {
        itemId: 'semantic-1',
        workspaceId: 'workspace-a',
        capacityId: 'cap-a',
        name: 'Model',
        itemType: 'SemanticModel',
      },
      {
        itemId: 'future-1',
        workspaceId: 'workspace-b',
        capacityId: 'cap-a',
        name: 'Future',
        itemType: 'NewFabricThing',
      },
    ],
    failures: partial
      ? [
          {
            scope: 'WorkspaceItems',
            endpoint: 'https://api.fabric.microsoft.com/v1/workspaces/workspace-b/items',
            status: 403,
            failure: 'PermissionDenied',
            message: 'Forbidden',
            capacityId: 'cap-a',
            workspaceId: 'workspace-b',
          },
        ]
      : [],
  }
}

describe('Fabric topology function collection', () => {
  it('follows continuation tokens and caps workspace item fan-out', async () => {
    const fetch = mockFetch({
      '/v1/capacities': {
        value: [{ id: 'cap-a', displayName: 'Alpha', sku: 'F64' }],
        continuationToken: 'cap-page-2',
      },
      '/v1/capacities?continuationToken=cap-page-2': {
        value: [{ id: 'cap-b', displayName: 'Beta', sku: 'F2' }],
      },
      '/v1/workspaces': {
        value: [
          { id: 'workspace-a', displayName: 'Workspace A', capacityId: 'cap-a' },
          { id: 'workspace-b', displayName: 'Workspace B', capacityId: 'cap-b' },
        ],
        continuationToken: 'workspace-page-2',
      },
      '/v1/workspaces?continuationToken=workspace-page-2': {
        value: [{ id: 'workspace-c', displayName: 'Workspace C', capacityId: 'cap-a' }],
      },
      '/v1/workspaces/workspace-a/items': {
        value: [{ id: 'item-a', displayName: 'Pipeline', type: 'DataPipeline' }],
        continuationToken: 'item-page-2',
      },
      '/v1/workspaces/workspace-a/items?continuationToken=item-page-2': {
        value: [{ id: 'item-b', displayName: 'Model', type: 'SemanticModel' }],
      },
      '/v1/workspaces/workspace-b/items': { value: [] },
      '/v1/workspaces/workspace-c/items': { value: [{ id: 'item-c', type: 'Notebook' }] },
    })

    const result = await collectFabricTopology({
      token: 'fabric-token',
      fetchImpl: fetch.fetchImpl,
      now: () => new Date(NOW),
      itemConcurrency: 2,
    })

    expect(result.capacities.map((capacity) => capacity.capacityId)).toEqual(['cap-a', 'cap-b'])
    expect(result.items.map((item) => item.itemId)).toEqual(['item-a', 'item-b', 'item-c'])
    expect(fetch.calls).toContain('/v1/capacities?continuationToken=cap-page-2')
    expect(fetch.calls).toContain('/v1/workspaces?continuationToken=workspace-page-2')
    expect(fetch.calls).toContain('/v1/workspaces/workspace-a/items?continuationToken=item-page-2')
    expect(fetch.maxActiveItems).toBeLessThanOrEqual(2)
  })

  it('degrades a forbidden workspace to a partial topology', async () => {
    const fetch = mockFetch({
      '/v1/capacities': { value: [{ id: 'cap-a', displayName: 'Alpha' }] },
      '/v1/workspaces': {
        value: [
          { id: 'allowed', displayName: 'Allowed', capacityId: 'cap-a' },
          { id: 'denied', displayName: 'Denied', capacityId: 'cap-a' },
        ],
      },
      '/v1/workspaces/allowed/items': {
        value: [{ id: 'item-a', displayName: 'Warehouse', type: 'Warehouse' }],
      },
      '/v1/workspaces/denied/items': fail(403, 'Forbidden'),
    })

    const result = await collectFabricTopology({
      token: 'fabric-token',
      fetchImpl: fetch.fetchImpl,
      now: () => new Date(NOW),
    })

    expect(result.partial).toBe(true)
    expect(result.items.map((item) => item.itemId)).toEqual(['item-a'])
    expect(result.failures).toMatchObject([
      {
        scope: 'WorkspaceItems',
        failure: 'PermissionDenied',
        status: 403,
        capacityId: 'cap-a',
        workspaceId: 'denied',
      },
    ])
  })

  it('maps HTTP failures onto source failure kinds', () => {
    expect(sourceFailureForStatus(401)).toBe('Unauthenticated')
    expect(sourceFailureForStatus(403)).toBe('PermissionDenied')
    expect(sourceFailureForStatus(404)).toBe('NotConfigured')
    expect(sourceFailureForStatus(400)).toBe('Unsupported')
    expect(sourceFailureForStatus(429)).toBe('Network')
    expect(sourceFailureForStatus(503)).toBe('Network')
    expect(sourceFailureForStatus(418)).toBe('Unknown')
    expect(failureFromUnknown(new Error('403 Forbidden'))).toBe('PermissionDenied')
  })
})

describe('topology CapacitySource adapter', () => {
  it('normalizes REST item kinds and keeps unknown kinds as buildings', async () => {
    const source = createTopologySource({ readTopology: async () => topology() })
    const page = await source.readCityPage({
      capacityId: 'cap-a',
      metric: 'Cu',
      pageSize: 10,
    })

    expect(page.items.map((item) => item.kind)).toEqual([
      'DataPipeline',
      'SemanticModel',
      'Unknown',
    ])
    expect(page.items.find((item) => item.itemId === 'future-1')?.archetype).toBe('Compute')
  })

  it('reports topology without telemetry as unmeasured rather than zero', async () => {
    const source = createTopologySource({ readTopology: async () => topology() })
    const [atlas, summaries, page] = await Promise.all([
      source.readAtlas(),
      source.readCitySummaries(),
      source.readCityPage({ capacityId: 'cap-a', metric: 'Cu', pageSize: 10 }),
    ])

    const capacity = atlas.capacities[0]
    expect(capacity.cuConsumed).toMatchObject({ cuSeconds: null, status: 'Unknown' })
    expect(capacity.storage).toMatchObject({ bytes: null, status: 'Unknown' })
    expect(capacity.meanUtilizationPercent).toBeNull()
    expect(capacity.throttle.interactiveDelayPercent).toBeNull()
    expect(summaries.capacities[0]).toMatchObject({
      cuSeconds: null,
      storageBytes: null,
      sizeStatus: 'Unknown',
    })
    expect(page.otherWorkload).toMatchObject({
      familyCount: null,
      operationCount: null,
      cuSeconds: null,
      durationSeconds: null,
    })

    for (const item of page.items) {
      expect(item.cuConsumed).toMatchObject({ cuSeconds: null, status: 'Unknown' })
      expect(item.storage).toMatchObject({ bytes: null, status: 'Unknown' })
      expect(item.durationSeconds).toBeNull()
      expect(item.operations.total).toBeNull()
      expect(item.sizeStatus).toBe('Unknown')
    }
  })

  it('surfaces partial permissions in counts and evidence without dropping visible topology', async () => {
    const source = createTopologySource({ readTopology: async () => topology(true) })
    const atlas = await source.readAtlas()
    const page = await source.readCityPage({ capacityId: 'cap-a', metric: 'Cu', pageSize: 10 })

    expect(atlas.collection?.state).toBe('Degraded')
    expect(atlas.collection?.failureCount).toBe(1)
    expect(atlas.capacities[0].itemCount).toBeNull()
    expect(page.totalItems).toBeNull()
    expect(page.evidence.status).toBe('PermissionDenied')
    expect(page.items.map((item) => item.itemId)).toContain('pipeline-1')
  })
})
