/*
 * Reading Capacity Metrics out of the app's own SQL database.
 *
 * The deployed Fabric app cannot call the Capacity Metrics semantic model itself — Rayfin ships no
 * connector, Fabric refuses to deploy functions, and `executeQueries` sends no CORS headers, so
 * there is nowhere to put the server-side relay a browser would need. See README.
 *
 * The way around all three is to move the read off the browser entirely: a scheduled Fabric
 * notebook runs the DAX and writes the rows into the Rayfin database, and this module reads them
 * back. What comes out is a `SemanticModelDaxClient`, so `createSemanticModelSource` cannot tell
 * the difference and every line of its parsing is reused unchanged. The notebook does no
 * interpretation at all: it stores rows verbatim, which is what keeps the Capacity Metrics schema
 * knowledge in one language rather than two.
 */

import { normalizeRowKey } from './semanticModelDaxClient'
import {
  SEMANTIC_MODEL_CAPABILITIES,
  createSemanticModelSource,
  type SemanticModelDaxClient,
  type SemanticModelDaxRequest,
  type SemanticModelRow,
} from './semanticModelSource'
import type { SemanticModelQueryName } from './semanticModelQueries'
import { CapacitySourceError, type CapacitySource, type CapacitySourceCapabilities } from './source'

/**
 * The capacity column for a row that belongs to no single capacity.
 *
 * Empty string rather than null so the column stays non-nullable and equality filtering needs no
 * special case — `capacitySummary` and `schemaProbe` rows are looked up the same way as the rest.
 */
export const TENANT_WIDE_CAPACITY_ID = ''

/** Rows fetched per page when reading a run back. Matches the app's other paginated reads. */
export const INGEST_PAGE_SIZE = 100

export interface IngestRunRecord {
  id: string
  tenantId: string
  datasetId: string
  schemaGeneration: string
  status: 'Running' | 'Complete' | 'Failed'
  startedAt: string
  completedAt?: string | null
  windowStart: string
  windowEnd: string
  rowCount: number
  failureMessage?: string | null
}

export interface IngestRowRecord {
  queryName: SemanticModelQueryName
  capacityId: string
  rowIndex: number
  rowTimestamp?: string | null
  rowJson: string
}

export interface IngestRowQuery {
  runId: string
  queryName: SemanticModelQueryName
  capacityId: string
  /** Inclusive lower bound on `rowTimestamp`, applied only when the query is windowed. */
  windowStart?: string
  /** Exclusive upper bound on `rowTimestamp`. */
  windowEnd?: string
  signal?: AbortSignal
}

/**
 * The narrow port the replay client needs.
 *
 * Split out from the Rayfin data client so the interesting logic — which run to trust, how a
 * window is applied, how a stored row becomes a DAX row — is testable without a backend.
 */
export interface IngestStore {
  latestCompleteRun(signal?: AbortSignal): Promise<IngestRunRecord | null>
  readRows(query: IngestRowQuery): Promise<readonly IngestRowRecord[]>
}

/**
 * Which queries carry a per-row timestamp worth filtering on.
 *
 * Only `timepoints` is asked for a narrower window than the one ingested. The others are already
 * aggregated down to one row per capacity or item, so applying a window to them would drop rows
 * the source expects to be there.
 */
const WINDOWED_QUERIES: ReadonlySet<SemanticModelQueryName> = new Set<SemanticModelQueryName>(['timepoints'])

function capacityIdFor(request: SemanticModelDaxRequest): string {
  const value = request.parameters.CapacityId
  return typeof value === 'string' ? value : TENANT_WIDE_CAPACITY_ID
}

function windowFor(request: SemanticModelDaxRequest): { windowStart?: string; windowEnd?: string } {
  if (!WINDOWED_QUERIES.has(request.queryName)) return {}
  const start = request.parameters.Start
  const end = request.parameters.End
  return {
    windowStart: typeof start === 'string' ? start : undefined,
    windowEnd: typeof end === 'string' ? end : undefined,
  }
}

/**
 * Turn a stored row back into the shape the DAX transport would have returned.
 *
 * The keys are normalized on the way out rather than on the way in. `evaluateQueries` and `sempy`
 * both hand back bracketed names (`[CapacityId]`, `Table[Column]`) and the notebook stores whatever
 * it was given, so normalizing here means one implementation covers both transports instead of the
 * notebook having to reimplement it in Python and stay in step.
 */
export function parseIngestedRow(record: IngestRowRecord): SemanticModelRow {
  let parsed: unknown
  try {
    parsed = JSON.parse(record.rowJson)
  } catch {
    throw new CapacitySourceError(
      'SemanticModel',
      'Unknown',
      `Ingested row ${record.queryName}#${record.rowIndex} is not valid JSON.`,
    )
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CapacitySourceError(
      'SemanticModel',
      'Unknown',
      `Ingested row ${record.queryName}#${record.rowIndex} is not a JSON object.`,
    )
  }

  const row: SemanticModelRow = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    row[normalizeRowKey(key)] = value
  }
  return row
}

export interface IngestedDaxClientOptions {
  store: IngestStore
}

/**
 * A `SemanticModelDaxClient` that replays a notebook run instead of calling Power BI.
 *
 * The run is resolved once and held, so every query in a single page load reads the same ingest.
 * Resolving per query would let a notebook finishing mid-render serve `cityItems` from one run and
 * `operationFamilies` from the next, which is a torn city that no error would report.
 */
export function createIngestedDaxClient(options: IngestedDaxClientOptions): SemanticModelDaxClient {
  let runPromise: Promise<IngestRunRecord> | null = null

  async function resolveRun(signal?: AbortSignal): Promise<IngestRunRecord> {
    if (!runPromise) {
      runPromise = options.store
        .latestCompleteRun(signal)
        .then((run) => {
          if (!run) {
            throw new CapacitySourceError(
              'SemanticModel',
              'NotConfigured',
              'No completed capacity metrics ingest was found. Run the Fabric ingest notebook.',
            )
          }
          return run
        })
        .catch((error) => {
          runPromise = null
          throw error
        })
    }
    return runPromise
  }

  return {
    async execute<T extends SemanticModelRow = SemanticModelRow>(
      request: SemanticModelDaxRequest,
    ): Promise<readonly T[]> {
      request.signal?.throwIfAborted()
      const run = await resolveRun(request.signal)
      const records = await options.store.readRows({
        runId: run.id,
        queryName: request.queryName,
        capacityId: capacityIdFor(request),
        ...windowFor(request),
        signal: request.signal,
      })
      return records.map((record) => parseIngestedRow(record) as T)
    },
  }
}

export interface IngestedCapacitySourceOptions {
  store: IngestStore
  tenant: { tenantId: string; displayName: string }
  /**
   * How often the notebook is scheduled, in minutes.
   *
   * Reported as the source's latency because that is the honest worst case: data is at most one
   * interval old plus the semantic model's own lag. Declaring the model's 15 minutes here instead
   * would tell the UI the city is fresher than it is, which is the "unmeasured drawn as measured"
   * failure the evidence model exists to prevent.
   */
  intervalMinutes?: number
  /** How many days of history the notebook ingests. Must match its `INGEST_WINDOW_DAYS`. */
  windowDays?: number
  now?: () => Date
}

/** Kept in step with `INGEST_INTERVAL_MINUTES` in the notebook by `ingestNotebook.test.ts`. */
export const DEFAULT_INGEST_INTERVAL_MINUTES = 60

/** Kept in step with `INGEST_WINDOW_DAYS` in the notebook by `ingestNotebook.test.ts`. */
export const DEFAULT_INGEST_WINDOW_DAYS = 3

export function ingestedCapabilities(
  intervalMinutes: number,
  windowDays: number,
): CapacitySourceCapabilities {
  return Object.freeze({
    ...SEMANTIC_MODEL_CAPABILITIES,
    latencySeconds: SEMANTIC_MODEL_CAPABILITIES.latencySeconds + Math.max(0, intervalMinutes) * 60,
    retentionDays: Math.max(0, windowDays),
  })
}

/**
 * The whole point: a source the *deployed* app can use.
 *
 * Everything below the client is `createSemanticModelSource` unchanged, so this reports
 * `kind: 'SemanticModel'` — which is also just true. The rows came from the Capacity Metrics
 * semantic model; only the transport is different, and the transport is exactly what the three
 * walls made impossible from a browser.
 */
export function createIngestedCapacitySource(options: IngestedCapacitySourceOptions): CapacitySource {
  const intervalMinutes = options.intervalMinutes ?? DEFAULT_INGEST_INTERVAL_MINUTES
  const windowDays = options.windowDays ?? DEFAULT_INGEST_WINDOW_DAYS
  const inner = createSemanticModelSource({
    client: createIngestedDaxClient({ store: options.store }),
    tenant: options.tenant,
    now: options.now,
  })

  return {
    ...inner,
    kind: inner.kind,
    get capabilities() {
      return {
        ...ingestedCapabilities(intervalMinutes, windowDays),
        timepoints: inner.capabilities.timepoints,
      }
    },
    readAtlas: (signal) => inner.readAtlas(signal),
    readCitySummaries: (signal) => inner.readCitySummaries(signal),
    readCityPage: (request) => inner.readCityPage(request),
    readTimepoints: (request) => inner.readTimepoints(request),
    readOperationSamples: (request) => inner.readOperationSamples(request),
  }
}
