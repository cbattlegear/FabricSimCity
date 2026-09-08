/*
 * The `IngestStore` port, implemented against the Rayfin data API.
 *
 * Deliberately thin: everything that could be got wrong — which run to trust, how a window is
 * applied, how a stored row becomes a DAX row — lives in `ingestedDax.ts` behind the port so it can
 * be tested without a backend. What is left here is pagination and filter syntax.
 */

import type { RayfinClient } from '@microsoft/rayfin-client'

import type { AppSchema } from '../../rayfin/data/schema'
import type { AppFunctionsSchema } from '../../rayfin/functions/src/types'
import { INGEST_PAGE_SIZE, type IngestRowQuery, type IngestRowRecord, type IngestRunRecord, type IngestStore } from './ingestedDax'
import type { SemanticModelQueryName } from './semanticModelQueries'

type AppClient = RayfinClient<AppSchema, AppFunctionsSchema>

export interface RayfinIngestStoreOptions {
  tenantId: string
  /**
   * Restrict to one Capacity Metrics semantic model.
   *
   * A tenant can have the metrics app installed more than once. Without this the newest run wins
   * regardless of which model it read, so the city would flip between them on a schedule.
   */
  datasetId?: string
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined
  return value instanceof Date ? value.toISOString() : value
}

function requiredIso(value: Date | string | null | undefined): string {
  return iso(value) ?? new Date(0).toISOString()
}

/**
 * Build the `rowTimestamp` filter as one object.
 *
 * Spreading `{ rowTimestamp: { gte } }` and `{ rowTimestamp: { lt } }` into the same where clause
 * looks like it combines them and does not — the second replaces the first outright, silently
 * dropping the lower bound and widening the window back to everything ingested.
 */
function timestampFilter(
  request: IngestRowQuery,
): { rowTimestamp: { gte?: Date; lt?: Date } } | Record<string, never> {
  const bounds: { gte?: Date; lt?: Date } = {}
  if (request.windowStart) bounds.gte = new Date(request.windowStart)
  if (request.windowEnd) bounds.lt = new Date(request.windowEnd)
  return Object.keys(bounds).length > 0 ? { rowTimestamp: bounds } : {}
}

export function createRayfinIngestStore(
  client: AppClient,
  options: RayfinIngestStoreOptions,
): IngestStore {
  return {
    async latestCompleteRun(): Promise<IngestRunRecord | null> {
      const query = client.data.IngestRun
        .select([
          'id',
          'tenantId',
          'datasetId',
          'schemaGeneration',
          'status',
          'startedAt',
          'completedAt',
          'windowStart',
          'windowEnd',
          'rowCount',
          'failureMessage',
        ])
        .where(
          options.datasetId
            ? {
                tenantId: { eq: options.tenantId },
                status: { eq: 'Complete' },
                datasetId: { eq: options.datasetId },
              }
            : { tenantId: { eq: options.tenantId }, status: { eq: 'Complete' } },
        )
        .orderBy({ completedAt: 'desc' })
        .first(1)

      const page = await query.executePaginated()
      const record = page.items[0]
      if (!record) return null

      return {
        id: record.id,
        tenantId: record.tenantId,
        datasetId: record.datasetId,
        schemaGeneration: record.schemaGeneration,
        status: record.status,
        startedAt: requiredIso(record.startedAt),
        completedAt: iso(record.completedAt) ?? null,
        windowStart: requiredIso(record.windowStart),
        windowEnd: requiredIso(record.windowEnd),
        rowCount: record.rowCount,
        failureMessage: record.failureMessage ?? null,
      }
    },

    async readRows(request: IngestRowQuery): Promise<readonly IngestRowRecord[]> {
      const rows: IngestRowRecord[] = []
      let cursor: string | undefined

      do {
        request.signal?.throwIfAborted()
        let query = client.data.IngestRow
          .select(['queryName', 'capacityId', 'rowIndex', 'rowTimestamp', 'rowJson'])
          .where({
            runId: { eq: request.runId },
            queryName: { eq: request.queryName },
            capacityId: { eq: request.capacityId },
            ...timestampFilter(request),
          })
          .orderBy({ rowIndex: 'asc' })
          .first(INGEST_PAGE_SIZE)
        if (cursor) query = query.after(cursor)

        const page = await query.executePaginated()
        for (const item of page.items) {
          rows.push({
            queryName: item.queryName as SemanticModelQueryName,
            capacityId: item.capacityId,
            rowIndex: item.rowIndex,
            rowTimestamp: iso(item.rowTimestamp) ?? null,
            rowJson: item.rowJson,
          })
        }
        cursor = page.hasNextPage ? page.endCursor : undefined
      } while (cursor)

      return rows
    },
  }
}
