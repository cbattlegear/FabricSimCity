import { describe, expect, it } from 'vitest'
import { buildEventhouseQueries } from './eventhouseQueries'
import {
  EVENTHOUSE_CAPABILITIES,
  createEventhouseSource,
  type EventhouseKqlClient,
  type EventhouseKqlRequest,
  type EventhouseQueryName,
  type EventhouseRow,
} from './eventhouseSource'
import { TIMEPOINT_SECONDS } from '../fabricContracts'
import type { CapacityAtlasItem } from '../fabricContracts'

const NOW = new Date(Date.UTC(2026, 0, 8, 12, 0, 30))
const OBSERVED = new Date(Date.UTC(2026, 0, 8, 12, 0, 0)).toISOString()

const REQUEST = {
  capacityId: 'cap-1',
  start: new Date(Date.UTC(2026, 0, 8, 11, 59, 0)).toISOString(),
  end: new Date(Date.UTC(2026, 0, 8, 12, 1, 0)).toISOString(),
}

class FakeKqlClient implements EventhouseKqlClient {
  readonly calls: EventhouseKqlRequest[] = []

  constructor(
    private readonly rows: Partial<Record<EventhouseQueryName, readonly EventhouseRow[]>> = {},
    private readonly errors: Partial<Record<EventhouseQueryName, unknown>> = {},
  ) {}

  async execute<T extends EventhouseRow = EventhouseRow>(request: EventhouseKqlRequest): Promise<readonly T[]> {
    this.calls.push(request)
    const error = this.errors[request.queryName]
    if (error) throw error
    return (this.rows[request.queryName] ?? []) as readonly T[]
  }
}

function source(client: FakeKqlClient, capacityTopologyTable?: string | null) {
  return createEventhouseSource({
    client,
    tenant: { tenantId: 'tenant-1', displayName: 'Contoso Tenant' },
    capacityTopologyTable,
    now: () => NOW,
  })
}

function summaryRow(overrides: EventhouseRow = {}): EventhouseRow {
  return {
    CapacityId: 'cap-1',
    CapacityName: 'Contoso Capacity',
    Sku: 'F64',
    Region: 'westus',
    CapacityState: 'Active',
    StateReason: 'NotOverloaded',
    ObservedAt: OBSERVED,
    WindowStart: new Date(Date.UTC(2026, 0, 7, 12, 0, 0)).toISOString(),
    WindowEnd: OBSERVED,
    TotalCuSeconds: 1200,
    MeanUtilizationPercent: 42.5,
    PeakUtilizationPercent: 88.25,
    InteractiveDelayPercent: 35,
    InteractiveRejectionPercent: 20,
    BackgroundRejectionPercent: 10,
    CumulativeCarryOverPercent: 5,
    ExpectedBurndownMinutes: 7,
    SurgeProtectionActive: false,
    ...overrides,
  }
}

function capacityByName(capacities: CapacityAtlasItem[], name: string): CapacityAtlasItem {
  const found = capacities.find((capacity) => capacity.displayName === name)
  if (!found) throw new Error(`Missing capacity ${name}`)
  return found
}

describe('Eventhouse KQL source capabilities and queries', () => {
  it('declares the supported Eventhouse shape up front', () => {
    const feed = source(new FakeKqlClient())

    expect(feed.kind).toBe('Eventhouse')
    expect(feed.capabilities).toEqual(EVENTHOUSE_CAPABILITIES)
    expect(feed.capabilities).toMatchObject({
      perItemBreakdown: false,
      operationFamilies: false,
      operationSamples: false,
      timepoints: true,
      latencySeconds: 30,
      retentionDays: 14,
    })
  })

  it('keeps KQL table and schema assumptions reviewable', () => {
    const queries = buildEventhouseQueries({
      capacityEventsTable: 'CapacityEvents',
      capacityTopologyTable: 'CapacityTopology',
    })

    expect(queries.capacitySummary).toContain('CapacityEvents')
    expect(queries.capacitySummary).toContain('CuSeconds')
    expect(queries.timepoints).toContain('InteractiveBillablePercent')
    expect(queries.cityTopology).toContain('CapacityTopology')
    expect(() => buildEventhouseQueries({ capacityEventsTable: 'CapacityEvents; drop table X' })).toThrow(
      RangeError,
    )
  })
})

describe('Eventhouse capacity summaries', () => {
  it('parses capacity-level CU and leaves Eventhouse-absent storage unmeasured', async () => {
    const client = new FakeKqlClient({
      capacitySummary: [
        summaryRow({ CapacityId: 'cap-2', CapacityName: 'B Capacity', TotalCuSeconds: 2.4 }),
        summaryRow({ CapacityId: 'cap-1', CapacityName: 'A Capacity', TotalCuSeconds: 1200.6 }),
      ],
    })

    const snapshot = await source(client).readAtlas()
    const capacity = capacityByName(snapshot.capacities, 'A Capacity')

    expect(snapshot.tenant).toEqual({ tenantId: 'tenant-1', displayName: 'Contoso Tenant' })
    expect(snapshot.collection?.source).toBe('CapacityEvent')
    expect(capacity.cuConsumed).toMatchObject({
      cuSeconds: '1201',
      status: 'Known',
      evidence: { source: 'CapacityEvent', status: 'Available', observedAt: OBSERVED },
    })
    expect(capacity.storage).toMatchObject({
      bytes: null,
      status: 'Unknown',
      evidence: { source: 'CapacityEvent', status: 'Unsupported' },
    })
    expect(snapshot.capacities.map((entry) => entry.displayName)).toEqual(['A Capacity', 'B Capacity'])
  })

  it('maps interactive delay as busy rather than rejecting', async () => {
    const client = new FakeKqlClient({
      capacitySummary: [
        summaryRow({
          CapacityState: '',
          StateReason: 'InteractiveDelay',
          InteractiveDelayPercent: 125,
          InteractiveRejectionPercent: 99,
          BackgroundRejectionPercent: 50,
        }),
      ],
    })

    const [capacity] = (await source(client).readAtlas()).capacities

    expect(capacity.state).toBe('Overloaded')
    expect(capacity.stateReason).toBe('InteractiveDelay')
    expect(capacity.throttle.stage).toBe('InteractiveDelay')
    expect(capacity.throttle.interactiveDelayPercent).toBe(125)
    expect(capacity.throttle.interactiveRejectionPercent).toBe(99)
    expect(capacity.throttle.backgroundRejectionPercent).toBe(50)
  })
})

describe('Eventhouse timepoints', () => {
  it('parses timepoints and returns them in chronological order', async () => {
    const first = new Date(Date.UTC(2026, 0, 8, 12, 0, 0)).toISOString()
    const second = new Date(Date.UTC(2026, 0, 8, 12, 0, 30)).toISOString()
    const client = new FakeKqlClient({
      timepoints: [
        {
          Timepoint: second,
          Sku: 'F64',
          InteractiveBillablePercent: 20,
          BackgroundBillablePercent: 30,
          InteractiveDelayPercent: 40,
        },
        {
          Timepoint: first,
          CapacityUnits: 64,
          InteractiveBillablePercent: 10,
          BackgroundBillablePercent: 15,
          CarryOverAddPercent: 3,
        },
      ],
    })

    const timepoints = await source(client).readTimepoints(REQUEST)

    expect(timepoints.map((entry) => entry.timepoint)).toEqual([first, second])
    expect(timepoints[0]).toMatchObject({
      cuLimit: 64 * TIMEPOINT_SECONDS,
      interactiveBillablePercent: 10,
      backgroundBillablePercent: 15,
      carryOverAddPercent: 3,
    })
    expect(timepoints[1]).toMatchObject({
      cuLimit: 64 * TIMEPOINT_SECONDS,
      interactiveBillablePercent: 20,
      backgroundBillablePercent: 30,
      interactiveDelayPercent: 40,
    })
  })

  it('does not fill gaps in the 30-second series with fabricated zeroes', async () => {
    const first = new Date(Date.UTC(2026, 0, 8, 12, 0, 0)).toISOString()
    const afterGap = new Date(Date.UTC(2026, 0, 8, 12, 1, 0)).toISOString()
    const client = new FakeKqlClient({
      timepoints: [
        { Timepoint: first, CapacityUnits: 64, InteractiveBillablePercent: 17 },
        { Timepoint: afterGap, CapacityUnits: 64, InteractiveBillablePercent: 19 },
      ],
    })

    const timepoints = await source(client).readTimepoints(REQUEST)

    expect(timepoints).toHaveLength(2)
    expect(timepoints.map((entry) => entry.timepoint)).toEqual([first, afterGap])
    expect(timepoints.some((entry) => entry.timepoint.endsWith('12:00:30.000Z'))).toBe(false)
    expect(timepoints.map((entry) => entry.interactiveBillablePercent)).toEqual([17, 19])
  })
})

describe('Eventhouse city pages', () => {
  it('returns static topology with per-item CU and storage explicitly unmeasured', async () => {
    const client = new FakeKqlClient({
      capacitySummary: [summaryRow()],
      cityTopology: [
        {
          ObservedAt: OBSERVED,
          WorkspaceId: 'workspace-b',
          WorkspaceName: 'Beta',
          ItemId: 'item-3',
          ItemName: 'Three',
          ItemType: 'Notebook',
        },
        {
          ObservedAt: OBSERVED,
          WorkspaceId: 'workspace-a',
          WorkspaceName: 'Alpha',
          ItemId: 'item-1',
          ItemName: 'One',
          ItemType: 'Lakehouse',
        },
        {
          ObservedAt: OBSERVED,
          WorkspaceId: 'workspace-a',
          WorkspaceName: 'Alpha',
          ItemId: 'item-2',
          ItemName: 'Two',
          ItemType: 'SemanticModel',
        },
      ],
    })

    const page = await source(client, 'CapacityTopology').readCityPage({
      capacityId: 'cap-1',
      metric: 'Cu',
      pageSize: 2,
    })

    expect(page.totalItems).toBe('3')
    expect(page.nextPageToken).toBe('2')
    expect(page.items.map((item) => item.itemId)).toEqual(['item-1', 'item-2'])
    expect(page.workspaces).toEqual([
      {
        workspaceId: 'workspace-a',
        name: 'Alpha',
        neighborhoodOrdinal: 0,
        itemCount: '2',
        evidence: { source: 'FabricRest', status: 'Available', observedAt: OBSERVED, freshUntil: null },
      },
    ])
    for (const item of page.items) {
      expect(item.cuConsumed).toMatchObject({
        cuSeconds: null,
        status: 'Unknown',
        evidence: { source: 'CapacityEvent', status: 'Unsupported', observedAt: OBSERVED },
      })
      expect(item.storage).toMatchObject({
        bytes: null,
        status: 'Unknown',
        evidence: { source: 'CapacityEvent', status: 'Unsupported', observedAt: OBSERVED },
      })
      expect(item.sizeStatus).toBe('Unknown')
      expect(item.durationSeconds).toBeNull()
      expect(item.operations).toEqual({
        total: null,
        successful: null,
        rejected: null,
        failed: null,
        invalid: null,
        cancelled: null,
      })
    }
    expect(page.topOperationFamilies).toEqual([])
    expect(page.otherWorkload).toMatchObject({
      familyCount: null,
      operationCount: null,
      cuSeconds: null,
      durationSeconds: null,
      evidence: { source: 'CapacityEvent', status: 'Unsupported', observedAt: OBSERVED },
    })
  })

  it('returns an empty city page when no topology table is configured', async () => {
    const client = new FakeKqlClient({ capacitySummary: [summaryRow()] })

    const page = await source(client).readCityPage({ capacityId: 'cap-1', metric: 'Cu', pageSize: 50 })

    expect(page.items).toEqual([])
    expect(page.workspaces).toEqual([])
    expect(page.topOperationFamilies).toEqual([])
    expect(page.totalItems).toBe('0')
    expect(client.calls.map((call) => call.queryName)).toEqual(['capacitySummary'])
  })
})

describe('unsupported Eventhouse capabilities', () => {
  it('returns an empty operation sample list without touching KQL', async () => {
    const client = new FakeKqlClient({}, { timepoints: new Error('would fail if queried') })

    const samples = await source(client).readOperationSamples({ capacityId: 'cap-1', limit: 20 })

    expect(samples).toEqual([])
    expect(client.calls).toEqual([])
  })
})

describe('Eventhouse error mapping', () => {
  it.each([
    ['Unauthenticated', Object.assign(new Error('token expired'), { status: 401 })],
    ['PermissionDenied', Object.assign(new Error('Forbidden'), { status: 403 })],
    ['NotConfigured', Object.assign(new Error('database not found'), { status: 404 })],
    ['Unsupported', Object.assign(new Error('Semantic error: failed to resolve column'), { status: 400 })],
    ['Network', Object.assign(new Error('Service unavailable'), { status: 503 })],
    ['Network', Object.assign(new TypeError('Failed to fetch'), { code: 'ENOTFOUND' })],
    ['Unknown', new Error('boom')],
  ] as const)('maps %s failures to CapacitySourceError', async (failure, error) => {
    const client = new FakeKqlClient({}, { timepoints: error })

    await expect(source(client).readTimepoints(REQUEST)).rejects.toMatchObject({
      name: 'CapacitySourceError',
      sourceKind: 'Eventhouse',
      failure,
    })
  })
})
