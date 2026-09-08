/*
 * Transport for the Capacity Metrics semantic model, over the Power BI `executeQueries` REST API.
 *
 * `semanticModelSource.ts` owns the DAX and the parsing; this owns only getting a query to the
 * model and rows back. Two properties of that API shape everything here:
 *
 * 1. **There is no parameter binding.** `executeQueries` accepts a query string and nothing else,
 *    so the `@Start` / `@End` / `@CapacityId` placeholders the query builder emits have to be
 *    rewritten into DAX literals before the request is sent. That makes escaping a correctness
 *    *and* a safety concern rather than a formality — a capacity id is a server-supplied string.
 * 2. **There is no CORS.** The API sends no `Access-Control-Allow-Origin`, so a browser cannot call
 *    `api.powerbi.com` directly no matter what token it holds. `baseUrl` therefore defaults to a
 *    same-origin path that something else has to forward; in development that is the Vite proxy in
 *    `vite.config.ts`, which also keeps the bearer token out of the client bundle.
 *
 * Together those are why this client is usable from `npm run dev` and not from the deployed Fabric
 * app, which is static-only and has no place to put the forwarder. See README.
 */

import type {
  SemanticModelDaxClient,
  SemanticModelDaxParameter,
  SemanticModelDaxRequest,
  SemanticModelRow,
} from './semanticModelSource'
import { CapacitySourceError, type SourceFailureKind } from './source'

/** Same-origin path the dev proxy forwards to `https://api.powerbi.com`. */
export const DEFAULT_DAX_BASE_URL = '/powerbi'

export interface SemanticModelDaxClientOptions {
  /** Object id of the Capacity Metrics semantic model. */
  datasetId: string
  /** Origin or path that fronts the Power BI REST API. Defaults to the dev proxy path. */
  baseUrl?: string
  /**
   * Bearer token supplier, for callers that front the API themselves. Omitted in the dev-proxy
   * arrangement, where the proxy attaches the token and the browser never sees it.
   */
  getAccessToken?: () => string | null | Promise<string | null>
  fetch?: typeof globalThis.fetch
}

function fail(failure: SourceFailureKind, message: string): never {
  throw new CapacitySourceError('SemanticModel', failure, message)
}

/**
 * Render a value as a DAX literal.
 *
 * Strings double their quotes, which is DAX's own escape and is what keeps a capacity id from
 * ending the literal and continuing as expression text. Timestamps become `DATE(...) + TIME(...)`
 * rather than a quoted string because DAX comparison against a text value is a type error in some
 * models and silently coerces in others; building the value arithmetically is unambiguous in both.
 */
export function daxLiteral(value: SemanticModelDaxParameter): string {
  if (value === null) return 'BLANK()'
  if (typeof value === 'boolean') return value ? 'TRUE()' : 'FALSE()'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Unknown', `Cannot bind non-finite number ${String(value)} into DAX.`)
    return String(value)
  }

  const timestamp = asTimestamp(value)
  if (timestamp) return timestamp

  return `"${value.replaceAll('"', '""')}"`
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function asTimestamp(value: string): string | null {
  if (!ISO_TIMESTAMP.test(value)) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const y = date.getUTCFullYear()
  const mo = date.getUTCMonth() + 1
  const d = date.getUTCDate()
  const h = date.getUTCHours()
  const mi = date.getUTCMinutes()
  const s = date.getUTCSeconds()
  return `(DATE(${y},${mo},${d}) + TIME(${h},${mi},${s}))`
}

const PARAMETER_REFERENCE = /@([A-Za-z_][A-Za-z0-9_]*)/g

/**
 * Substitute `@Name` placeholders with DAX literals.
 *
 * Matching whole identifiers rather than replacing names one at a time is deliberate: a
 * find-and-replace of `@Start` would also rewrite the front of `@StartOfDay`, and the resulting
 * query would still be valid DAX, so the mistake would surface as wrong numbers rather than an
 * error. An unbound placeholder is a bug in the query builder, so it fails loudly.
 */
export function bindDaxParameters(
  query: string,
  parameters: Readonly<Record<string, SemanticModelDaxParameter>>,
): string {
  return query.replaceAll(PARAMETER_REFERENCE, (match, name: string) => {
    if (!Object.hasOwn(parameters, name)) {
      fail('Unknown', `DAX query references ${match} but no such parameter was supplied.`)
    }
    return daxLiteral(parameters[name])
  })
}

/**
 * Strip the brackets `executeQueries` wraps column names in.
 *
 * Rows come back keyed `"[CapacityId]"` for a `SELECTCOLUMNS` alias and `"Table[Column]"` for a
 * bare column reference, while the source parses plain names. Without this every lookup misses and
 * the source sees a well-formed response with nothing in it.
 */
export function normalizeRowKey(key: string): string {
  const match = /\[([^[\]]+)\]$/.exec(key)
  return match ? match[1] : key
}

function normalizeRow<T extends SemanticModelRow>(row: SemanticModelRow): T {
  const out: SemanticModelRow = {}
  for (const [key, value] of Object.entries(row)) out[normalizeRowKey(key)] = value
  return out as T
}

interface ExecuteQueriesEnvelope {
  results?: readonly {
    tables?: readonly { rows?: readonly SemanticModelRow[] }[]
    error?: unknown
  }[]
  error?: { code?: unknown; message?: unknown } | string
}

function messageFrom(payload: unknown, status: number): string {
  if (typeof payload === 'string' && payload.trim()) return payload.slice(0, 500)
  if (payload && typeof payload === 'object') {
    const error = (payload as ExecuteQueriesEnvelope).error
    if (typeof error === 'string' && error.trim()) return error.slice(0, 500)
    if (error && typeof error === 'object') {
      const message = (error as { message?: unknown }).message
      if (typeof message === 'string' && message.trim()) return message.slice(0, 500)
      const code = (error as { code?: unknown }).code
      if (typeof code === 'string' && code.trim()) return code.slice(0, 500)
    }
  }
  return `Power BI executeQueries returned ${status}.`
}

/*
 * A 400 is mapped to `Unsupported`, not to `Unknown`.
 *
 * The API returns 400 for a DAX error, and the DAX error this source expects to meet is a table or
 * column that has been renamed — Microsoft documents this whole access path as unsupported and the
 * Capacity Metrics schema has already moved once. `Unsupported` is the kind the app treats as a
 * reason to fall back and say so, which is the correct handling for a model that has drifted.
 */
function failureForStatus(status: number): SourceFailureKind {
  if (status === 401) return 'Unauthenticated'
  if (status === 403) return 'PermissionDenied'
  if (status === 404) return 'NotConfigured'
  if (status === 400) return 'Unsupported'
  return 'Unknown'
}

export function createSemanticModelDaxClient(
  options: SemanticModelDaxClientOptions,
): SemanticModelDaxClient {
  const datasetId = options.datasetId?.trim()
  if (!datasetId) {
    fail('NotConfigured', 'No Capacity Metrics dataset id was configured for the semantic-model source.')
  }

  const baseUrl = (options.baseUrl ?? DEFAULT_DAX_BASE_URL).replace(/\/+$/, '')
  const doFetch = options.fetch ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    fail('NotConfigured', 'No fetch implementation is available for the semantic-model source.')
  }

  const endpoint = `${baseUrl}/v1.0/myorg/datasets/${encodeURIComponent(datasetId)}/executeQueries`

  return {
    async execute<T extends SemanticModelRow = SemanticModelRow>(
      request: SemanticModelDaxRequest,
    ): Promise<readonly T[]> {
      const query = bindDaxParameters(request.query, request.parameters)

      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (options.getAccessToken) {
        const token = await options.getAccessToken()
        if (!token) fail('Unauthenticated', 'No access token is available for the Capacity Metrics model.')
        headers.authorization = `Bearer ${token}`
      }

      let response: Response
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers,
          signal: request.signal,
          body: JSON.stringify({
            queries: [{ query }],
            serializerSettings: { includeNulls: true },
          }),
        })
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        if (error instanceof CapacitySourceError) throw error
        fail('Network', `Could not reach the Capacity Metrics model: ${describe(error)}`)
      }

      const payload = await readJson(response)

      if (!response.ok) {
        fail(failureForStatus(response.status), messageFrom(payload, response.status))
      }

      const envelope = (payload ?? {}) as ExecuteQueriesEnvelope
      const result = envelope.results?.[0]
      if (result?.error) {
        fail('Unsupported', messageFrom({ error: result.error }, 200))
      }

      const rows = result?.tables?.[0]?.rows
      if (!rows) return []
      return rows.map((row) => normalizeRow<T>(row))
    },
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
