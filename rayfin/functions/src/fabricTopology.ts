export type SourceFailureKind =
  | 'Unauthenticated'
  | 'PermissionDenied'
  | 'NotConfigured'
  | 'Unsupported'
  | 'Network'
  | 'Unknown'

export interface FabricTopologyCapacity {
  capacityId: string
  displayName: string
  sku: string | null
  region: string | null
  state: string | null
  stateReason: string | null
}

export interface FabricTopologyWorkspace {
  workspaceId: string
  capacityId: string | null
  name: string
}

export interface FabricTopologyItem {
  itemId: string
  workspaceId: string
  capacityId: string | null
  name: string
  itemType: string | null
}

export interface FabricTopologyFailure {
  scope: 'Capacities' | 'Workspaces' | 'WorkspaceItems'
  endpoint: string
  status: number | null
  failure: SourceFailureKind
  message: string
  capacityId?: string | null
  workspaceId?: string
}

export interface FabricTopologySnapshot {
  schemaVersion: '1.0'
  generatedAt: string
  capacities: FabricTopologyCapacity[]
  workspaces: FabricTopologyWorkspace[]
  items: FabricTopologyItem[]
  failures: FabricTopologyFailure[]
  partial: boolean
}

interface FabricPage<T> {
  value?: T[]
  continuationToken?: string | null
  continuationUri?: string | null
}

export interface CollectFabricTopologyOptions {
  token: string
  fetchImpl?: typeof fetch
  now?: () => Date
  baseUrl?: string
  itemConcurrency?: number
}

class FabricHttpError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number,
    readonly statusText: string,
    body: string,
  ) {
    super(`Fabric REST ${status} ${statusText} at ${endpoint}${body ? `: ${body}` : ''}`)
    this.name = 'FabricHttpError'
  }
}

export function sourceFailureForStatus(status: number | null): SourceFailureKind {
  if (status === 401) return 'Unauthenticated'
  if (status === 403) return 'PermissionDenied'
  if (status === 404) return 'NotConfigured'
  if (status === 400 || status === 405 || status === 410) return 'Unsupported'
  if (status === 0 || status === 408 || status === 429 || (status !== null && status >= 500)) {
    return 'Network'
  }
  return 'Unknown'
}

function stringField(row: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = row[name]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

function capacityFromRaw(row: unknown): FabricTopologyCapacity | null {
  if (!row || typeof row !== 'object') return null
  const record = row as Record<string, unknown>
  const capacityId = stringField(record, ['id', 'capacityId'])
  if (!capacityId) return null
  return {
    capacityId,
    displayName: stringField(record, ['displayName', 'name']) ?? capacityId,
    sku: stringField(record, ['sku', 'skuName']),
    region: stringField(record, ['region', 'location']),
    state: stringField(record, ['state', 'capacityState']),
    stateReason: stringField(record, ['stateReason', 'capacityStateReason']),
  }
}

function workspaceFromRaw(row: unknown): FabricTopologyWorkspace | null {
  if (!row || typeof row !== 'object') return null
  const record = row as Record<string, unknown>
  const workspaceId = stringField(record, ['id', 'workspaceId'])
  if (!workspaceId) return null
  return {
    workspaceId,
    capacityId: stringField(record, ['capacityId']),
    name: stringField(record, ['displayName', 'name']) ?? workspaceId,
  }
}

function itemFromRaw(
  row: unknown,
  workspace: FabricTopologyWorkspace,
): FabricTopologyItem | null {
  if (!row || typeof row !== 'object') return null
  const record = row as Record<string, unknown>
  const itemId = stringField(record, ['id', 'itemId'])
  if (!itemId) return null
  return {
    itemId,
    workspaceId: workspace.workspaceId,
    capacityId: workspace.capacityId,
    name: stringField(record, ['displayName', 'name']) ?? itemId,
    itemType: stringField(record, ['type', 'itemType', 'ItemType']),
  }
}

function endpointUrl(baseUrl: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  return new URL(pathOrUrl.replace(/^\/+/, ''), base).toString()
}

function appendContinuation(url: string, token: string | null): string {
  if (!token) return url
  const next = new URL(url)
  next.searchParams.set('continuationToken', token)
  return next.toString()
}

function normalizeContinuationUri(baseUrl: string, continuationUri: string): string {
  const base = new URL(baseUrl)
  const next = new URL(continuationUri, base)
  if (next.origin !== base.origin || !next.pathname.startsWith(base.pathname)) {
    throw new Error(`Fabric REST returned an unexpected continuation URI: ${continuationUri}`)
  }
  return next.toString()
}

async function readJson<T>(fetchImpl: typeof fetch, token: string, url: string): Promise<T> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    })
  } catch (error) {
    throw new FabricHttpError(url, 0, 'NetworkError', error instanceof Error ? error.message : '')
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500)
    throw new FabricHttpError(url, response.status, response.statusText, body)
  }
  return (await response.json()) as T
}

async function readPaged<T>(
  fetchImpl: typeof fetch,
  token: string,
  baseUrl: string,
  path: string,
): Promise<T[]> {
  const values: T[] = []
  const firstUrl = endpointUrl(baseUrl, path)
  let nextUrl: string | null = firstUrl
  let guard = 0

  while (nextUrl && guard < 1000) {
    const page: FabricPage<T> = await readJson<FabricPage<T>>(
      fetchImpl,
      token,
      nextUrl,
    )
    values.push(...(Array.isArray(page.value) ? page.value : []))
    nextUrl = page.continuationUri
      ? normalizeContinuationUri(baseUrl, page.continuationUri)
      : appendContinuation(firstUrl, page.continuationToken ?? null)
    if (nextUrl === firstUrl) nextUrl = null
    guard += 1
  }

  if (guard >= 1000) throw new Error(`Fabric REST pagination did not terminate for ${path}`)
  return values
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= values.length) return
      results[index] = await mapper(values[index])
    }
  })
  await Promise.all(workers)
  return results
}

function failureFromError(error: unknown, scope: FabricTopologyFailure['scope']): FabricTopologyFailure {
  if (error instanceof FabricHttpError) {
    return {
      scope,
      endpoint: error.endpoint,
      status: error.status,
      failure: sourceFailureForStatus(error.status),
      message: error.message,
    }
  }
  return {
    scope,
    endpoint: '',
    status: null,
    failure: 'Unknown',
    message: error instanceof Error ? error.message : String(error),
  }
}

export async function collectFabricTopology(
  options: CollectFabricTopologyOptions,
): Promise<FabricTopologySnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = options.baseUrl ?? 'https://api.fabric.microsoft.com/v1'
  const concurrency = Math.max(1, options.itemConcurrency ?? 6)
  const generatedAt = (options.now ?? (() => new Date()))().toISOString()

  const capacities = (await readPaged<unknown>(fetchImpl, options.token, baseUrl, '/capacities'))
    .map(capacityFromRaw)
    .filter((entry): entry is FabricTopologyCapacity => entry !== null)

  const workspaces = (await readPaged<unknown>(fetchImpl, options.token, baseUrl, '/workspaces'))
    .map(workspaceFromRaw)
    .filter((entry): entry is FabricTopologyWorkspace => entry !== null)

  const failures: FabricTopologyFailure[] = []
  const itemBatches = await mapLimit(workspaces, concurrency, async (workspace) => {
    try {
      const rows = await readPaged<unknown>(
        fetchImpl,
        options.token,
        baseUrl,
        `/workspaces/${encodeURIComponent(workspace.workspaceId)}/items`,
      )
      return rows
        .map((row) => itemFromRaw(row, workspace))
        .filter((entry): entry is FabricTopologyItem => entry !== null)
    } catch (error) {
      failures.push({
        ...failureFromError(error, 'WorkspaceItems'),
        capacityId: workspace.capacityId,
        workspaceId: workspace.workspaceId,
      })
      return []
    }
  })

  return {
    schemaVersion: '1.0',
    generatedAt,
    capacities,
    workspaces,
    items: itemBatches.flat(),
    failures,
    partial: failures.length > 0,
  }
}
