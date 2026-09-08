/*
 * The store is thin, but thin is not the same as safe: the first version of it spread both window
 * bounds into the same `rowTimestamp` key, so the lower bound was silently replaced by the upper
 * one and every read widened back to the whole ingest. Nothing above the port could have noticed.
 */

import { describe, expect, it } from 'vitest'

import { INGEST_PAGE_SIZE } from './ingestedDax'
import { createRayfinIngestStore } from './rayfinIngestStore'

interface Recorded {
  where?: Record<string, unknown>
  orderBy?: Record<string, unknown>
  first?: number
  after?: string
}

/** A client whose entity builders are created fresh per query, the way the real one behaves. */
function client(pages: { items: unknown[]; hasNextPage: boolean; endCursor?: string }[]) {
  const calls: Recorded[] = []
  let pageIndex = 0

  const make = () => {
    const recorded: Recorded = {}
    calls.push(recorded)
    const self: Record<string, unknown> = {}
    Object.assign(self, {
      select: () => self,
      where: (value: Record<string, unknown>) => ((recorded.where = value), self),
      orderBy: (value: Record<string, unknown>) => ((recorded.orderBy = value), self),
      first: (value: number) => ((recorded.first = value), self),
      after: (value: string) => ((recorded.after = value), self),
      executePaginated: async () => pages[Math.min(pageIndex++, pages.length - 1)],
    })
    return self
  }

  return {
    calls,
    // The real client's type is generated from the whole schema and is not worth reconstructing to
    // fake four builder methods. The cast is confined to this one line.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api: { data: { get IngestRun() { return make() }, get IngestRow() { return make() } } } as any,
  }
}

const runRow = {
  id: 'run-9',
  tenantId: 'tenant',
  datasetId: 'dataset',
  schemaGeneration: 'v2',
  status: 'Complete',
  startedAt: new Date('2024-05-01T00:00:00Z'),
  completedAt: new Date('2024-05-01T00:04:00Z'),
  windowStart: new Date('2024-04-28T00:00:00Z'),
  windowEnd: new Date('2024-05-01T00:00:00Z'),
  rowCount: 12,
  failureMessage: null,
}

describe('latestCompleteRun', () => {
  it('asks for the newest complete run for this tenant and dataset', async () => {
    const { calls, api } = client([{ items: [runRow], hasNextPage: false }])
    const store = createRayfinIngestStore(api, { tenantId: 'tenant', datasetId: 'dataset' })

    const run = await store.latestCompleteRun()

    expect(calls[0].where).toEqual({
      tenantId: { eq: 'tenant' },
      status: { eq: 'Complete' },
      datasetId: { eq: 'dataset' },
    })
    expect(calls[0].orderBy).toEqual({ completedAt: 'desc' })
    expect(run?.id).toBe('run-9')
    expect(run?.completedAt).toBe('2024-05-01T00:04:00.000Z')
  })

  it('omits the dataset filter when the app is not pinned to one model', async () => {
    const { calls, api } = client([{ items: [runRow], hasNextPage: false }])
    await createRayfinIngestStore(api, { tenantId: 'tenant' }).latestCompleteRun()
    expect(calls[0].where).not.toHaveProperty('datasetId')
  })

  it('returns null rather than throwing when nothing has been ingested', async () => {
    const { api } = client([{ items: [], hasNextPage: false }])
    await expect(createRayfinIngestStore(api, { tenantId: 't' }).latestCompleteRun()).resolves.toBeNull()
  })
})

describe('readRows', () => {
  const row = { queryName: 'timepoints', capacityId: 'cap-1', rowIndex: 0, rowTimestamp: null, rowJson: '{}' }

  it('applies both window bounds to one rowTimestamp filter', async () => {
    const { calls, api } = client([{ items: [row], hasNextPage: false }])
    await createRayfinIngestStore(api, { tenantId: 't' }).readRows({
      runId: 'run-9',
      queryName: 'timepoints',
      capacityId: 'cap-1',
      windowStart: '2024-04-30T00:00:00.000Z',
      windowEnd: '2024-05-01T00:00:00.000Z',
    })

    expect(calls[0].where).toEqual({
      runId: { eq: 'run-9' },
      queryName: { eq: 'timepoints' },
      capacityId: { eq: 'cap-1' },
      rowTimestamp: {
        gte: new Date('2024-04-30T00:00:00.000Z'),
        lt: new Date('2024-05-01T00:00:00.000Z'),
      },
    })
  })

  it('sends no rowTimestamp filter at all for an unwindowed query', async () => {
    const { calls, api } = client([{ items: [row], hasNextPage: false }])
    await createRayfinIngestStore(api, { tenantId: 't' }).readRows({
      runId: 'run-9',
      queryName: 'cityItems',
      capacityId: 'cap-1',
    })
    expect(calls[0].where).not.toHaveProperty('rowTimestamp')
  })

  it('follows every page, because one page is a silently truncated city', async () => {
    const { calls, api } = client([
      { items: [row], hasNextPage: true, endCursor: 'cursor-1' },
      { items: [{ ...row, rowIndex: 1 }], hasNextPage: false },
    ])

    const rows = await createRayfinIngestStore(api, { tenantId: 't' }).readRows({
      runId: 'run-9',
      queryName: 'cityItems',
      capacityId: 'cap-1',
    })

    expect(rows).toHaveLength(2)
    expect(calls[0].first).toBe(INGEST_PAGE_SIZE)
    expect(calls[1].after).toBe('cursor-1')
  })

  it('stops paging when the signal aborts', async () => {
    const controller = new AbortController()
    const { api } = client([{ items: [row], hasNextPage: true, endCursor: 'c' }])
    controller.abort()

    await expect(
      createRayfinIngestStore(api, { tenantId: 't' }).readRows({
        runId: 'run-9',
        queryName: 'cityItems',
        capacityId: 'cap-1',
        signal: controller.signal,
      }),
    ).rejects.toThrow()
  })

  it('orders by rowIndex so replayed rows keep the order the model returned them in', async () => {
    const { calls, api } = client([{ items: [row], hasNextPage: false }])
    await createRayfinIngestStore(api, { tenantId: 't' }).readRows({
      runId: 'run-9',
      queryName: 'cityItems',
      capacityId: 'cap-1',
    })
    expect(calls[0].orderBy).toEqual({ rowIndex: 'asc' })
  })
})

