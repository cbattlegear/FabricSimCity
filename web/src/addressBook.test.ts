import { describe, expect, it } from 'vitest'
import { blockAddress, buildAddressBook, columnLabel, searchAddressBook } from './addressBook'
import { planCity, type CityPlan } from './cityPlan'
import { FACILITY_ORDER, type Facility } from './cityInfrastructure'
import type {
  DatabaseCityObject,
  DatabaseCityQueryFamily,
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

function object(
  objectId: string,
  schemaId: string,
  name: string,
  neighborhoodOrdinal: number,
  objectOrdinal: number,
  reservedPages: string | null = '4096',
): DatabaseCityObject {
  return {
    objectId,
    schemaId,
    schemaName: schemaId.replace('schema:', ''),
    name,
    kind: 'Table',
    reservedPages8KiB: reservedPages,
    usedPages8KiB: reservedPages === null ? null : '2048',
    reservedBytes: reservedPages === null ? null : String(BigInt(reservedPages) * 8192n),
    usedBytes: reservedPages === null ? null : String(2048n * 8192n),
    sizeStatus: reservedPages === null ? 'Unknown' : 'Known',
    sizeReason: reservedPages === null ? 'sys.allocation_units returned no row' : null,
    layout: { neighborhoodOrdinal, objectOrdinal, x: 0, z: 0 },
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

function family(
  familyId: string,
  queryHash: string,
  objectIds: string[],
  cpu = '5000',
): DatabaseCityQueryFamily {
  return {
    familyId,
    queryHash,
    objectIds,
    executionCount: '120',
    totalCpuMicroseconds: cpu,
    totalDurationMicroseconds: '9000',
    totalLogicalReads8KiBPages: '400',
    totalWaitMilliseconds: '80',
    waitMillisecondsByCategory: {},
    confidence: 'Probable',
    rationale: 'plan references both objects',
    waitCategories: [],
    evidence,
  } as unknown as DatabaseCityQueryFamily
}

function facility(kind: Facility['kind'], label: string, known = true): Facility {
  return {
    kind,
    label,
    known,
    headline: known ? '42% utilised' : 'not sampled',
    status: known ? 'Available' : 'Unknown',
    reason: known ? 'live snapshot' : 'the DMV returned no row',
    units: [],
    alertCount: 0,
  }
}

const objects = [
  object('object:dbo:100', 'schema:dbo', 'Customer', 0, 0, '8192'),
  object('object:dbo:101', 'schema:dbo', 'Orders', 0, 1, '4096'),
  object('object:rep:300', 'schema:reporting', 'DailyTotals', 1, 0, null),
]

const schemas: DatabaseCitySchema[] = [
  { schemaId: 'schema:dbo', name: 'dbo', neighborhoodOrdinal: 0, objectCount: '2', evidence },
  { schemaId: 'schema:reporting', name: 'reporting', neighborhoodOrdinal: 1, objectCount: '1', evidence },
]

const families = [
  family('family:1', '0xAABBCC', ['object:dbo:100', 'object:dbo:101'], '90000'),
  family('family:2', '0xDDEEFF', ['object:rep:300'], '1000'),
]

const facilities = FACILITY_ORDER.map((kind, index) => facility(kind, `Facility ${index}`))

function samplePlan(): CityPlan {
  return planCity(objects, { seed: 'db:sales', totalObjects: '3', schemas })
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
    expect(blockAddress(plan, 0, 0)).toBe('Block A1')
    expect(blockAddress(plan, 0, 0, 'dbo')).toBe('dbo · Block A1')
  })

  it('advances one block per block, on ground whose spacing is no longer uniform', () => {
    const plan = samplePlan()
    // Block spans vary and the whole lattice is displaced, so the address is checked against the
    // centre of the block it should name rather than against a multiple of a pitch.
    const centre = (col: number, row: number) => plan.warp.blockCenter(col, row)
    const at = (col: number, row: number) => {
      const point = centre(col, row)
      return blockAddress(plan, point.x, point.z)
    }
    expect(at(1, 0)).toBe('Block B1')
    expect(at(0, 1)).toBe('Block A2')
    expect(at(2, 3)).toBe('Block C4')
  })

  it('never produces a negative block for a position left of the origin', () => {
    const plan = samplePlan()
    expect(blockAddress(plan, -50, -50)).toBe('Block A1')
  })
})

describe('buildAddressBook', () => {
  it('carries all three kinds in one flat list', () => {
    const entries = buildAddressBook(objects, families, facilities, samplePlan())
    expect(entries.filter(entry => entry.kind === 'query')).toHaveLength(families.length)
    expect(entries.filter(entry => entry.kind === 'table')).toHaveLength(objects.length)
    expect(entries.filter(entry => entry.kind === 'facility')).toHaveLength(facilities.length)
  })

  it('gives every table an address on the map it is drawn on', () => {
    const plan = samplePlan()
    const entries = buildAddressBook(objects, families, facilities, plan)
    for (const entry of entries.filter(candidate => candidate.kind === 'table')) {
      const lot = plan.lots.get(entry.targetId)!
      expect(entry.address).toBe(blockAddress(plan, lot.x, lot.z, entry.address!.split(' · ')[0]))
      expect(entry.address).toMatch(/Block [A-Z]+\d+$/)
    }
  })

  it('says an unknown size is unavailable rather than calling it zero', () => {
    const entries = buildAddressBook(objects, families, facilities, samplePlan())
    const unknown = entries.find(entry => entry.targetId === 'object:rep:300')!
    expect(unknown.meta).toContain('size unavailable')
    expect(unknown.meta).not.toContain('0 reserved')
  })

  it('names the objects a query visits, and says so when it names none that loaded', () => {
    const entries = buildAddressBook(objects, [
      family('family:3', '0x112233', ['object:elsewhere:1']),
    ], facilities, samplePlan())
    expect(entries[0].address).toBe('Visits no loaded object named')

    const visiting = buildAddressBook(objects, families, facilities, samplePlan())
      .find(entry => entry.targetId === 'family:1')!
    expect(visiting.address).toContain('dbo.Customer')
    expect(visiting.address).toContain('dbo.Orders')
  })

  it('reports an unsampled facility with its status rather than hiding it', () => {
    const partial = [facility(FACILITY_ORDER[0], 'CPU', false), ...facilities.slice(1)]
    const entries = buildAddressBook(objects, families, partial, samplePlan())
    const cpu = entries.find(entry => entry.id === `facility:${FACILITY_ORDER[0]}`)!
    expect(cpu.meta).toContain('Unknown')
    expect(cpu.meta).toContain('not sampled')
  })
})

describe('searchAddressBook', () => {
  const entries = buildAddressBook(objects, families, facilities, samplePlan())
  const groupOf = (term: string, kind: 'query' | 'table' | 'facility') =>
    searchAddressBook(entries, term).find(group => group.kind === kind)?.entries ?? []

  it('groups in a fixed order and drops empty groups', () => {
    expect(searchAddressBook(entries, '').map(group => group.kind))
      .toEqual(['query', 'table', 'facility'])
    expect(searchAddressBook(entries, 'utilised').map(group => group.kind)).toEqual(['facility'])
  })

  it('finds a table by schema, by name, and by qualified name', () => {
    expect(groupOf('dbo', 'table').map(entry => entry.name)).toEqual(['dbo.Customer', 'dbo.Orders'])
    expect(groupOf('orders', 'table').map(entry => entry.name)).toEqual(['dbo.Orders'])
    expect(groupOf('dbo.customer', 'table').map(entry => entry.name)).toEqual(['dbo.Customer'])
  })

  it('finds a query by its hash, its rationale, and the tables it visits', () => {
    expect(groupOf('0xaabbcc', 'query').map(entry => entry.targetId)).toEqual(['family:1'])
    expect(groupOf('plan references', 'query')).toHaveLength(families.length)
    // Searching a table name surfaces the queries that drive traffic to it, which is the point of
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
    expect(groupOf('CUSTOMER', 'table').map(entry => entry.name)).toEqual(['dbo.Customer'])
  })

  it('returns nothing rather than everything when nothing matches', () => {
    expect(searchAddressBook(entries, 'no-such-thing-anywhere')).toEqual([])
  })

  it('ranks the heaviest first within a group', () => {
    expect(groupOf('', 'table')[0].name).toBe('dbo.Customer')
    expect(groupOf('', 'query')[0].targetId).toBe('family:1')
  })

  it('keeps facilities in their fixed landmark order, not a measured one', () => {
    expect(groupOf('', 'facility').map(entry => entry.targetId)).toEqual([...FACILITY_ORDER])
  })
})