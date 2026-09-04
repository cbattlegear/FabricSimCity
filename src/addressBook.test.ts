import { describe, expect, it } from 'vitest'
import { blockAddress, buildAddressBook, columnLabel, searchAddressBook } from './addressBook'
import { planCity, type CityPlan } from './cityPlan'
import { FACILITY_ORDER, type Facility } from './cityInfrastructure'
import { itemArchetype } from './itemKind'
import { POWER_GRID_FACILITIES } from './powerGrid'
import type {
  CapacityCityItem,
  OperationFamily,
  CapacityCityWorkspace,
  FabricItemKind,
} from './capacityCityContracts'
import type { Evidence } from './fabricContracts'

const evidence: Evidence = {
  source: 'SemanticModel',
  status: 'Available',
  observedAt: null,
  freshUntil: null,
}

/**
 * One city item. `storageBytes` and `cuSeconds` are the OneLake bytes and CU-seconds the keystone
 * (`capacityCity.ts`) turns into a footprint and a height, so a null in `storageBytes` is a missing
 * (or, for a compute-only kind, an absent-by-nature) storage measurement.
 */
function item(
  itemId: string,
  workspaceId: string,
  name: string,
  neighborhoodOrdinal: number,
  itemOrdinal: number,
  storageBytes: string | null = '4096',
  kind: FabricItemKind = 'Lakehouse',
): CapacityCityItem {
  return {
    itemId,
    workspaceId,
    workspaceName: workspaceId.replace('workspace:', ''),
    name,
    kind,
    archetype: itemArchetype(kind),
    storage: { bytes: storageBytes, status: storageBytes === null ? 'Unknown' : 'Known', evidence },
    cuConsumed: { cuSeconds: '2048', status: 'Known', evidence },
    durationSeconds: null,
    operations: {
      total: '1',
      successful: null,
      rejected: null,
      failed: null,
      invalid: null,
      cancelled: null,
    },
    distinctUsers: null,
    throttlingMinutes: null,
    performanceDeltaPercent: null,
    layout: { neighborhoodOrdinal, itemOrdinal },
    sizeStatus: storageBytes === null ? 'Unknown' : 'Known',
    evidence,
  }
}

function family(
  familyId: string,
  operationName: string,
  itemIds: string[],
  cuSeconds = '5000',
): OperationFamily {
  return {
    familyId,
    operationName,
    itemId: itemIds[0] ?? '',
    itemIds,
    workspaceId: 'workspace:dbo',
    operationClass: 'Interactive',
    billingType: 'Billable',
    cuSeconds,
    durationSeconds: 9,
    operationCount: '120',
    throttlingSeconds: 80,
    distinctUsers: null,
    counts: {
      total: '120',
      successful: null,
      rejected: null,
      failed: null,
      invalid: null,
      cancelled: null,
    },
    evidence,
  }
}

function facility(kind: Facility['kind'], label: string, known = true): Facility {
  const definition = POWER_GRID_FACILITIES[kind]
  const status: Evidence['status'] = known ? 'Available' : 'Unknown'
  const measurementEvidence = { ...evidence, status }
  return {
    kind,
    label,
    civicRole: definition.civicRole,
    measurement: {
      kind: definition.measurement,
      status: known ? 'Known' : 'Unknown',
      evidence: measurementEvidence,
      value: known ? 42 : null,
      detail: known ? '42% utilised' : 'not sampled',
    },
    sizing: null,
    state: known ? 'healthy' : null,
    load: known ? 0.42 : null,
    trafficStage: definition.trafficStage,
    known,
    headline: known ? '42% utilised' : 'not sampled',
    status,
    reason: known ? 'live snapshot' : 'the probe returned no row',
    units: [],
    alertCount: 0,
    size: null,
  }
}

const items = [
  item('object:dbo:100', 'workspace:dbo', 'Customer', 0, 0, '8192'),
  item('object:dbo:101', 'workspace:dbo', 'Orders', 0, 1, '4096'),
  item('object:rep:300', 'workspace:reporting', 'DailyTotals', 1, 0, null),
]

const workspaces: CapacityCityWorkspace[] = [
  { workspaceId: 'workspace:dbo', name: 'dbo', neighborhoodOrdinal: 0, itemCount: '2', evidence },
  { workspaceId: 'workspace:reporting', name: 'reporting', neighborhoodOrdinal: 1, itemCount: '1', evidence },
]

const families = [
  family('family:1', 'Warehouse Query', ['object:dbo:100', 'object:dbo:101'], '90000'),
  family('family:2', 'Semantic model refresh', ['object:rep:300'], '1000'),
]

const facilities = FACILITY_ORDER.map((kind, index) => facility(kind, `Facility ${index}`))

function samplePlan(): CityPlan {
  return planCity(items, { seed: 'capacity:sales', totalItems: '3', workspaces })
}

describe('columnLabel', () => {
  it('letters columns the way a spreadsheet does', () => {
    expect(columnLabel(0)).toBe('A')
    expect(columnLabel(25)).toBe('Z')
    expect(columnLabel(26)).toBe('AA')
    expect(columnLabel(27)).toBe('AB')
    expect(columnLabel(51)).toBe('AZ')
    expect(columnLabel(52)).toBe('BA')
  })
})

describe('blockAddress', () => {
  it('names the block a position stands on, and prefixes the district when there is one', () => {
    const plan = samplePlan()
    // A block is a face of the street graph now, so the letter is the block's own id and the row is
    // fixed at one; the address is whatever the plan's warp says stands at that point.
    const { col } = plan.warp.blockAt(0, 0)
    const expected = `Block ${columnLabel(col)}1`
    expect(blockAddress(plan, 0, 0)).toBe(expected)
    expect(blockAddress(plan, 0, 0, 'dbo')).toBe(`dbo · ${expected}`)
  })

  it('gives each block its own letter, with the row fixed at one now the grid is gone', () => {
    const plan = samplePlan()
    const ids = [...new Set([...plan.lots.values()].map(lot => lot.blockCol))]
    expect(ids.length).toBeGreaterThan(1)
    for (const id of ids) {
      const centre = plan.warp.blockCenter(id, 0)
      const { col, row } = plan.warp.blockAt(centre.x, centre.z)
      // Row is no longer a coordinate — every block sits on row zero and reads as one.
      expect(row).toBe(0)
      expect(blockAddress(plan, centre.x, centre.z)).toBe(`Block ${columnLabel(col)}1`)
    }
  })

  it('never produces a negative block for a position far outside the city', () => {
    const plan = samplePlan()
    // The nearest block is named rather than a negative one invented, so the label is always valid.
    expect(blockAddress(plan, -9999, -9999)).toMatch(/^Block [A-Z]+1$/)
  })
})

describe('buildAddressBook', () => {
  it('carries all three kinds in one flat list', () => {
    const entries = buildAddressBook(items, families, facilities, samplePlan())
    expect(entries.filter(entry => entry.kind === 'query')).toHaveLength(families.length)
    expect(entries.filter(entry => entry.kind === 'item')).toHaveLength(items.length)
    expect(entries.filter(entry => entry.kind === 'facility')).toHaveLength(facilities.length)
  })

  it('gives every item an address on the map it is drawn on', () => {
    const plan = samplePlan()
    const entries = buildAddressBook(items, families, facilities, plan)
    for (const entry of entries.filter(candidate => candidate.kind === 'item')) {
      const lot = plan.lots.get(entry.targetId)!
      expect(entry.address).toBe(blockAddress(plan, lot.x, lot.z, entry.address!.split(' · ')[0]))
      expect(entry.address).toMatch(/Block [A-Z]+\d+$/)
    }
  })

  it('says an unknown size is unavailable rather than calling it zero', () => {
    const entries = buildAddressBook(items, families, facilities, samplePlan())
    const unknown = entries.find(entry => entry.targetId === 'object:rep:300')!
    expect(unknown.meta).toContain('size unavailable')
    expect(unknown.meta).not.toContain('0 ')
  })

  it('names the items an operation visits, and distinguishes the two kinds of silence', () => {
    // One id that resolves to nothing is a reference to an item off the loaded page, not an absence.
    const offPage = buildAddressBook(items, [
      family('family:3', 'Pipeline run', ['object:elsewhere:1']),
    ], facilities, samplePlan())
    expect(offPage[0].address).toBe('References one item outside this page')

    const offPageMany = buildAddressBook(items, [
      family('family:4', 'Pipeline run', ['object:elsewhere:1', 'object:elsewhere:2']),
    ], facilities, samplePlan())
    expect(offPageMany[0].address).toBe('References 2 items outside this page')

    // A family that named no item at all says exactly that, not that one is off-page.
    const nowhere = buildAddressBook(items, [
      family('family:5', 'Capacity heartbeat', []),
    ], facilities, samplePlan())
    expect(nowhere[0].address).toBe('References no item')

    const visiting = buildAddressBook(items, families, facilities, samplePlan())
      .find(entry => entry.targetId === 'family:1')!
    expect(visiting.address).toContain('dbo.Customer')
    expect(visiting.address).toContain('dbo.Orders')
  })

  it('counts the off-page references alongside the items an operation does visit', () => {
    // An operation that touches a loaded item and one that is off the page gets both truths: the
    // local stop by name, and a count of what it reached beyond what the map can draw.
    const mixed = buildAddressBook(items, [
      family('family:6', 'Warehouse Query', ['object:dbo:100', 'object:elsewhere:9']),
    ], facilities, samplePlan())
    expect(mixed[0].address).toBe('Visits dbo.Customer (+1 outside this page)')
    // The off-page id stays in the haystack so the operation is still findable by it.
    expect(mixed[0].searchText).toContain('object:elsewhere:9')
  })

  it('reports an unsampled facility with its status rather than hiding it', () => {
    const partial = [facility(FACILITY_ORDER[0], 'CPU', false), ...facilities.slice(1)]
    const entries = buildAddressBook(items, families, partial, samplePlan())
    const cpu = entries.find(entry => entry.id === `facility:${FACILITY_ORDER[0]}`)!
    expect(cpu.meta).toContain('Unknown')
    expect(cpu.meta).toContain('not sampled')
  })
})

describe('searchAddressBook', () => {
  const entries = buildAddressBook(items, families, facilities, samplePlan())
  const groupOf = (term: string, kind: 'query' | 'item' | 'facility') =>
    searchAddressBook(entries, term).find(group => group.kind === kind)?.entries ?? []

  it('groups in a fixed order and drops empty groups', () => {
    expect(searchAddressBook(entries, '').map(group => group.kind))
      .toEqual(['query', 'item', 'facility'])
    expect(searchAddressBook(entries, 'utilised').map(group => group.kind)).toEqual(['facility'])
  })

  it('finds an item by workspace, by name, and by qualified name', () => {
    expect(groupOf('dbo', 'item').map(entry => entry.name)).toEqual(['dbo.Customer', 'dbo.Orders'])
    expect(groupOf('orders', 'item').map(entry => entry.name)).toEqual(['dbo.Orders'])
    expect(groupOf('dbo.customer', 'item').map(entry => entry.name)).toEqual(['dbo.Customer'])
  })

  it('finds an operation by its family id, its name, and the items it visits', () => {
    expect(groupOf('family:1', 'query').map(entry => entry.targetId)).toEqual(['family:1'])
    expect(groupOf('warehouse query', 'query').map(entry => entry.targetId)).toEqual(['family:1'])
    // Searching an item name surfaces the operations that drive traffic to it, which is the point of
    // one unified list: you look up a place, not a category.
    expect(groupOf('customer', 'query').map(entry => entry.targetId)).toEqual(['family:1'])
  })

  it('finds a facility by its label', () => {
    expect(groupOf('facility 0', 'facility')).toHaveLength(1)
  })

  it('narrows with every token rather than widening', () => {
    const wide = searchAddressBook(entries, 'dbo').flatMap(group => group.entries)
    const narrow = searchAddressBook(entries, 'dbo orders').flatMap(group => group.entries)
    expect(narrow.length).toBeLessThan(wide.length)
    expect(narrow.map(entry => entry.name)).toContain('dbo.Orders')
  })

  it('is case-insensitive', () => {
    expect(groupOf('CUSTOMER', 'item').map(entry => entry.name)).toEqual(['dbo.Customer'])
  })

  it('returns nothing rather than everything when nothing matches', () => {
    expect(searchAddressBook(entries, 'no-such-thing-anywhere')).toEqual([])
  })

  it('ranks the heaviest first within a group', () => {
    expect(groupOf('', 'item')[0].name).toBe('dbo.Customer')
    expect(groupOf('', 'query')[0].targetId).toBe('family:1')
  })

  it('keeps facilities in their fixed landmark order, not a measured one', () => {
    expect(groupOf('', 'facility').map(entry => entry.targetId)).toEqual([...FACILITY_ORDER])
  })
})

/*
 * Where the ordering lives.
 *
 * The order within a group never depends on the search term, so it is established once when the
 * book is built and carried through by `filter`, which is stable. These two tests pin the halves of
 * that contract from opposite sides: the book comes out ordered, and the search does not re-order.
 * Together they are what stops the comparator being moved back into the typing path.
 */
describe('where the address book is ordered', () => {
  // Deliberately not in rank order, so an implementation that returns the input untouched fails.
  const unsorted = [
    item('object:dbo:1', 'workspace:dbo', 'Small', 0, 0, '10'),
    item('object:dbo:2', 'workspace:dbo', 'Largest', 0, 1, '9000'),
    item('object:dbo:3', 'workspace:dbo', 'Middling', 0, 2, '500'),
  ]
  const unsortedFamilies = [
    family('family:cheap', 'Notebook run', [], '10'),
    family('family:dear', 'Warehouse Query', [], '99000'),
  ]

  it('hands back a book that is already in order, so searching never has to sort', () => {
    const plan = planCity(unsorted, {
      seed: 'capacity:order',
      totalItems: '3',
      workspaces: [{ workspaceId: 'workspace:dbo', name: 'dbo', neighborhoodOrdinal: 0, itemCount: '3', evidence }],
    })
    const built = buildAddressBook(unsorted, unsortedFamilies, facilities, plan)

    expect(built.filter(entry => entry.kind === 'item').map(entry => entry.name))
      .toEqual(['dbo.Largest', 'dbo.Middling', 'dbo.Small'])
    expect(built.filter(entry => entry.kind === 'query').map(entry => entry.targetId))
      .toEqual(['family:dear', 'family:cheap'])
    expect(built.filter(entry => entry.kind === 'facility').map(entry => entry.targetId))
      .toEqual([...FACILITY_ORDER])
  })

  it('preserves the order it was given rather than sorting on every keystroke', () => {
    const plan = samplePlan()
    // Reversed on the way in. A search that sorts would put Customer back on top; one that only
    // filters must hand back exactly the order it received.
    const reversed = [...buildAddressBook(items, families, facilities, plan)].reverse()
    const foundItems = searchAddressBook(reversed, 'dbo').find(group => group.kind === 'item')?.entries ?? []
    expect(foundItems.map(entry => entry.name)).toEqual(['dbo.Orders', 'dbo.Customer'])
  })
})
