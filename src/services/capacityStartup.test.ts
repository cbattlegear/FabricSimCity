import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportedMetricsProbe } from '../collect/metricsDailySchema.testkit'

const sdk = vi.hoisted(() => ({ embedded: vi.fn(), popup: vi.fn() }))
vi.mock('@microsoft/rayfin-auth-provider-fabric', () => ({
  initEmbeddedAuth: sdk.embedded,
  ensureSignedInWithFabric: sdk.popup,
}))

const session = { isAuthenticated: true, user: { id: 'user', email: 'user@example.test' } }

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  sdk.embedded.mockResolvedValue(session)
  vi.stubEnv('VITE_FABRIC_SOURCE', 'ingested')
  vi.stubEnv('VITE_RAYFIN_API_URL', 'https://example.invalid/api/')
  vi.stubEnv('VITE_RAYFIN_PUBLISHABLE_KEY', 'pk-test')
  vi.stubEnv('VITE_FABRIC_WORKSPACE_ID', 'workspace')
  vi.stubEnv('VITE_FABRIC_ITEM_ID', 'app')
  vi.stubEnv('VITE_FABRIC_PORTAL_URL', 'https://app.fabric.microsoft.com')
  vi.stubEnv('VITE_FABRIC_TENANT_ID', 'tenant')
  vi.stubEnv('VITE_FABRIC_METRICS_DATASET_ID', 'dataset')
})

afterEach(() => {
  expect(sdk.popup).not.toHaveBeenCalled()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('configured source startup', () => {
  it('keeps fixtures stable and needs no SDK session without a backend', async () => {
    vi.stubEnv('VITE_FABRIC_SOURCE', '')
    vi.stubEnv('VITE_RAYFIN_API_URL', '')
    const { loadConfiguredCapacitySource } = await import('./capacitySource')
    const first = await loadConfiguredCapacitySource()
    expect(first.kind).toBe('Fixture')
    expect(await loadConfiguredCapacitySource()).toBe(first)
    expect(sdk.embedded).not.toHaveBeenCalled()
  })

  it('leaves dev DAX on its server-side token rather than requesting a Fabric session', async () => {
    vi.stubEnv('VITE_FABRIC_SOURCE', 'semantic-model')
    const { loadConfiguredCapacitySource } = await import('./capacitySource')
    expect((await loadConfiguredCapacitySource()).kind).toBe('SemanticModel')
    expect(sdk.embedded).not.toHaveBeenCalled()
  })

  it('shares one built-in handoff while giving each ingest refresh a fresh replay', async () => {
    let resolveHandoff!: (value: typeof session) => void
    const handoff = new Promise<typeof session>((resolve) => { resolveHandoff = resolve })
    sdk.embedded.mockReturnValue(handoff)
    const { loadConfiguredCapacitySource } = await import('./capacitySource')
    let ready = false
    const first = loadConfiguredCapacitySource().then((source) => { ready = true; return source })
    const second = loadConfiguredCapacitySource()
    await Promise.resolve()
    expect(ready).toBe(false)
    expect(sdk.embedded).toHaveBeenCalledTimes(1)
    expect(sdk.embedded.mock.calls[0][1]).toEqual({
      workspaceId: 'workspace', projectId: 'app', fabricPortalUrl: 'https://app.fabric.microsoft.com',
      returnOrigin: window.location.origin,
    })
    resolveHandoff(session)
    expect(await first).not.toBe(await second)
    expect((await first).kind).toBe('SemanticModel')
  })

  it('reports a missing Fabric session without anonymous reads or a custom login flow', async () => {
    sdk.embedded.mockResolvedValueOnce(null)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { loadConfiguredCapacitySource } = await import('./capacitySource')
    await expect(loadConfiguredCapacitySource()).rejects.toMatchObject({
      failure: 'Unauthenticated', message: expect.stringContaining('inside the Fabric portal'),
    })
    expect(fetch).not.toHaveBeenCalled()
    expect((await loadConfiguredCapacitySource()).kind).toBe('SemanticModel')
    expect(sdk.embedded).toHaveBeenCalledTimes(2)
  })

  it('surfaces handoff failures and retries without reinitializing the Rayfin client', async () => {
    const error = new Error('Fabric handoff timed out')
    sdk.embedded.mockRejectedValueOnce(error)
    const { loadConfiguredCapacitySource } = await import('./capacitySource')
    await expect(loadConfiguredCapacitySource()).rejects.toBe(error)
    expect((await loadConfiguredCapacitySource()).kind).toBe('SemanticModel')
    expect(sdk.embedded).toHaveBeenCalledTimes(2)
  })

  it('validates deployment config before initializing the client singleton', async () => {
    vi.stubEnv('VITE_FABRIC_WORKSPACE_ID', '')
    const { loadConfiguredCapacitySource } = await import('./capacitySource')
    await expect(loadConfiguredCapacitySource()).rejects.toThrow('VITE_FABRIC_WORKSPACE_ID')
    vi.stubEnv('VITE_FABRIC_WORKSPACE_ID', 'workspace')
    expect((await loadConfiguredCapacitySource()).kind).toBe('SemanticModel')
  })

  it('uses real SDK-generated GraphQL, follows cursors and discovers the next completed ingest', async () => {
    const requests: string[] = []
    let run = 0
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a GraphQL request body')
      const body = JSON.parse(init.body) as { query: string }
      requests.push(init.body)
      const root = body.query.match(/\{\s*(\w+)\s*\(/)?.[1]
      if (!root) throw new Error(`No GraphQL root in ${body.query}`)
      let items: object[]
      let hasNextPage = false
      let endCursor: string | null = null
      if (root.toLowerCase().includes('ingestrun')) {
        run += 1
        items = [{
          id: `run-${run}`, tenantId: 'tenant', datasetId: 'dataset',
          schemaGeneration: 'metricsDailyWithDimensions', status: 'Complete',
          startedAt: '2026-09-09T00:00:00Z', completedAt: '2026-09-09T00:01:00Z',
          windowStart: '2026-09-06T00:00:00Z', windowEnd: '2026-09-09T00:00:00Z', rowCount: 100,
        }]
      } else if (init.body.includes('schemaProbe')) {
        const next = init.body.includes('schema-next')
        const rows = next ? exportedMetricsProbe.slice(5) : exportedMetricsProbe.slice(0, 5)
        items = rows.map((row, index) => ({
          queryName: 'schemaProbe', capacityId: '', rowIndex: index, rowJson: JSON.stringify(row),
        }))
        hasNextPage = !next
        endCursor = next ? null : 'schema-next'
      } else if (init.body.includes('capacitySummary')) {
        items = [{
          queryName: 'capacitySummary', capacityId: '', rowIndex: 0,
          rowJson: JSON.stringify({
            CapacityId: 'cap', CapacityName: `Ingest ${run}`, Sku: 'F64', CapacityState: 'Active',
            TotalCuSeconds: run * 100, ObservedAt: '2026-09-09T00:00:00Z',
          }),
        }]
      } else {
        throw new Error(`Unexpected GraphQL request: ${init.body}`)
      }
      return new Response(JSON.stringify({ data: { [root]: { items, hasNextPage, endCursor } } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }))
    const { loadConfiguredCapacitySource } = await import('./capacitySource')
    const first = await loadConfiguredCapacitySource()
    expect((await first.readAtlas()).capacities[0].displayName).toBe('Ingest 1')
    expect((await first.readAtlas()).capacities[0].cuConsumed.cuSeconds).toBe('100')
    expect(run).toBe(1)
    const second = await loadConfiguredCapacitySource()
    expect((await second.readAtlas()).capacities[0].displayName).toBe('Ingest 2')
    expect(run).toBe(2)
    expect(requests.filter((request) => request.includes('schema-next'))).toHaveLength(2)
    expect(requests[0]).toContain('Complete')
    expect(requests[0]).toContain('tenant')
    expect(requests[0]).toContain('dataset')
    expect(sdk.embedded).toHaveBeenCalledTimes(1)
  })
})
