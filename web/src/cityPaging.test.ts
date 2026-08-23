import { describe, expect, it } from 'vitest'
import { mergeCityPage } from './cityPaging'
import type {
  DatabaseCityObject,
  DatabaseCityPage,
  DatabaseCityRoute,
  DatabaseCitySchema,
} from './databaseCityContracts'
import type { Evidence } from './contracts'

const evidence: Evidence = {
  source: 'CatalogSnapshot',
  status: 'Available',
  observedAt: null,
  freshUntil: null,
  reason: 'test',
}

function object(objectId: string, schemaId: string): DatabaseCityObject {
  return {
    objectId,
    schemaId,
    schemaName: schemaId,
    name: objectId,
    kind: 'Table',
    reservedPages8KiB: '8',
    usedPages8KiB: '4',
    reservedBytes: String(8n * 8192n),
    usedBytes: String(4n * 8192n),
    sizeStatus: 'Known',
    sizeReason: null,
    layout: { neighborhoodOrdinal: 0, objectOrdinal: 0, x: 0, z: 0 },
    indexes: [],
    directActivity: { totalOperations: '1', resetEpochToken: null, evidence },
    attributedExposure: {
      executionCount: null,
      totalCpuMicroseconds: null,
      totalDurationMicroseconds: null,
      totalLogicalReads8KiBPages: null,
      confidence: 'Unknown',
      rationale: 'test',
      evidence,
    },
  }
}

function route(routeId: string, from: string, to: string): DatabaseCityRoute {
  return {
    routeId,
    fromObjectId: from,
    toId: to,
    kind: 'ObjectReference',
    confidence: 'Confirmed',
    rationale: 'test',
    evidence,
  }
}

function schema(schemaId: string, ordinal: number, count: string): DatabaseCitySchema {
  return { schemaId, name: schemaId, neighborhoodOrdinal: ordinal, objectCount: count, evidence }
}

function page(overrides: Partial<DatabaseCityPage> = {}): DatabaseCityPage {
  return {
    schemaVersion: '1.0',
    databaseId: 'db',
    databaseName: 'sales',
    metric: 'Cpu',
    pageSize: 50,
    nextPageToken: null,
    totalObjects: '4',
    schemas: [],
    objects: [],
    topQueryFamilies: [],
    otherWorkload: {
      familyCount: null,
      executionCount: null,
      totalCpuMicroseconds: null,
      totalDurationMicroseconds: null,
      totalLogicalReads8KiBPages: null,
      totalWaitMilliseconds: null,
      evidence,
    },
    routes: [],
    evidence,
    ...overrides,
  }
}

describe('mergeCityPage', () => {
  it('keeps the routes an earlier page carried when a later page carries none', () => {
    // The bug this exists for: co-references are reported per page, so a database whose routes all
    // sit among the first fifty objects returns an empty `routes` on page two. Replacing the page
    // wholesale erased every road ribbon the moment a second page landed.
    const first = page({
      nextPageToken: 'cursor',
      objects: [object('a', 's1'), object('b', 's1')],
      routes: [route('r1', 'a', 'b')],
    })
    const second = page({ objects: [object('c', 's1')], routes: [] })

    const merged = mergeCityPage(first, second)

    expect(merged.routes.map(item => item.routeId)).toEqual(['r1'])
    expect(merged.objects.map(item => item.objectId)).toEqual(['a', 'b', 'c'])
    expect(merged.nextPageToken).toBeNull()
  })

  it('sums per-page schema counts into the database-wide count the layout needs', () => {
    // `page.schemas` counts that page's objects, not the schema's. The city is laid out from these
    // counts, so they have to accumulate or a neighbourhood is sized for a fraction of its tables.
    const first = page({
      nextPageToken: 'cursor',
      objects: [object('a', 's1'), object('b', 's2')],
      schemas: [schema('s1', 0, '1'), schema('s2', 1, '1')],
    })
    const second = page({
      objects: [object('c', 's2'), object('d', 's3')],
      schemas: [schema('s2', 1, '1'), schema('s3', 2, '1')],
    })

    const merged = mergeCityPage(first, second)

    expect(merged.schemas.map(item => `${item.schemaId}:${item.objectCount}`))
      .toEqual(['s1:1', 's2:2', 's3:1'])
  })

  it('is idempotent, so a repeated page never doubles a count', () => {
    const first = page({
      nextPageToken: 'cursor',
      objects: [object('a', 's1')],
      schemas: [schema('s1', 0, '1')],
      routes: [route('r1', 'a', 'a')],
    })

    const once = mergeCityPage(first, first)
    const twice = mergeCityPage(once, first)

    expect(once.schemas.map(item => item.objectCount)).toEqual(['1'])
    expect(twice.schemas.map(item => item.objectCount)).toEqual(['1'])
    expect(twice.objects).toHaveLength(1)
    expect(twice.routes).toHaveLength(1)
  })

  it('takes database-wide fields from the newer page and never loses the total', () => {
    const first = page({ nextPageToken: 'cursor', totalObjects: '9' })
    const second = page({ totalObjects: null, databaseName: 'sales' })

    const merged = mergeCityPage(first, second)

    expect(merged.totalObjects).toBe('9')
    expect(merged.databaseName).toBe('sales')
  })
})
