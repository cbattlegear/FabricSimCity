import { describe, expect, it } from 'vitest'
import {
  BLOCK_COLS,
  BLOCK_ROWS,
  CELLS_PER_BLOCK,
  MIN_FACILITY_BLOCK_GAP,
  STREET_WIDTH,
  buildingArchetype,
  buildingFootprint,
  buildingHeight,
  nearestIntersectionId,
  planCity,
  streetPath,
  streetPolyline,
  streetPolylineThrough,
  type CityPlan,
  type CityPlanOptions,
} from './cityPlan'
import { FACILITY_ORDER } from './cityInfrastructure'
import { distanceToStreetNetwork } from './cityPlan.testkit'
import type { DatabaseCityObject, DatabaseCitySchema } from './databaseCityContracts'
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
  neighborhoodOrdinal: number,
  objectOrdinal: number,
  reservedPages: string | null = '4096',
  usedPages: string | null = '2048',
): DatabaseCityObject {
  return {
    objectId,
    schemaId,
    schemaName: schemaId.replace('schema:', ''),
    name: objectId,
    kind: 'Table',
    reservedPages8KiB: reservedPages,
    usedPages8KiB: usedPages,
    reservedBytes: reservedPages === null ? null : String(BigInt(reservedPages) * 8192n),
    usedBytes: usedPages === null ? null : String(BigInt(usedPages) * 8192n),
    sizeStatus: reservedPages === null ? 'Unknown' : 'Known',
    sizeReason: null,
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

function sampleCity(): DatabaseCityObject[] {
  const objects: DatabaseCityObject[] = []
  for (let index = 0; index < 11; index += 1) {
    objects.push(object(`object:dbo:${100 + index}`, 'schema:dbo', 0, index))
  }
  for (let index = 0; index < 5; index += 1) {
    objects.push(object(`object:rep:${300 + index}`, 'schema:reporting', 1, index))
  }
  objects.push(object('object:arc:900', 'schema:archive', 2, 0, null, null))
  return objects
}

/** The schema list and totals every page of {@link sampleCity} would carry. */
function sampleSchemas(): DatabaseCitySchema[] {
  return [
    { schemaId: 'schema:dbo', name: 'dbo', neighborhoodOrdinal: 0, objectCount: '11', evidence },
    { schemaId: 'schema:reporting', name: 'reporting', neighborhoodOrdinal: 1, objectCount: '5', evidence },
    { schemaId: 'schema:archive', name: 'archive', neighborhoodOrdinal: 2, objectCount: '1', evidence },
  ]
}

function options(overrides: Partial<CityPlanOptions> = {}): CityPlanOptions {
  return { seed: 'db:sales', totalObjects: '17', schemas: sampleSchemas(), ...overrides }
}

/** Turns a world position back into the block grid coordinates the plan placed it on. */
function blockIndex(plan: CityPlan, x: number, z: number): { col: number; row: number } {
  const pitch = plan.cell + STREET_WIDTH
  return { col: Math.floor(x / pitch), row: Math.floor(z / pitch) }
}

function blockOf(plan: CityPlan, x: number, z: number): string {
  const { col, row } = blockIndex(plan, x, z)
  return `${col}-${row}`
}

describe('buildingFootprint / buildingHeight', () => {
  it('maps exact page counts logarithmically and monotonically', () => {
    expect(buildingFootprint('0')).toBeCloseTo(6, 6)
    expect(buildingFootprint('1')).toBeCloseTo(6.75, 6)
    expect(buildingHeight('0')).toBeCloseTo(0, 6)
    expect(buildingHeight('1')).toBeCloseTo(4.8, 6)

    let previousFootprint = -1
    let previousHeight = -1
    for (const pages of ['0', '1', '8', '128', '2048', '65536', '1048576', '17179869184']) {
      const footprint = buildingFootprint(pages)!
      const height = buildingHeight(pages)!
      expect(footprint).toBeGreaterThan(previousFootprint)
      expect(height).toBeGreaterThan(previousHeight)
      previousFootprint = footprint
      previousHeight = height
    }
  })

  it('adds a fixed amount per doubling', () => {
    expect(buildingFootprint('1023')! - buildingFootprint('511')!).toBeCloseTo(0.75, 6)
    expect(buildingHeight('1023')! - buildingHeight('511')!).toBeCloseTo(4.8, 6)
  })

  it('returns null for unknown size rather than inventing a value', () => {
    expect(buildingFootprint(null)).toBeNull()
    expect(buildingHeight(null)).toBeNull()
    expect(buildingFootprint('not-a-number')).toBeNull()
  })

  it('handles page counts beyond Number.MAX_SAFE_INTEGER without throwing', () => {
    expect(buildingHeight('99999999999999999999999')).toBeGreaterThan(0)
  })
})

describe('buildingArchetype', () => {
  it('selects a style family from exact reserved pages', () => {
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '1', '1'))).toBe('house')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '127', '1'))).toBe('house')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '128', '1'))).toBe('rowhouse')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '2047', '1'))).toBe('rowhouse')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '2048', '1'))).toBe('midrise')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '32768', '1'))).toBe('tower')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '524288', '1'))).toBe('skyscraper')
  })

  it('renders unknown size as a vacant parcel that makes no quantity claim', () => {
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, null, null))).toBe('vacant')
    expect(buildingArchetype(object('a', 'schema:dbo', 0, 0, '4096', null))).toBe('vacant')
  })

  it('gives indexed views their own civic style', () => {
    const view = { ...object('a', 'schema:dbo', 0, 0, '4096', '2048'), kind: 'IndexedView' as const }
    expect(buildingArchetype(view)).toBe('civic')
  })
})

describe('planCity placement', () => {
  it('is independent of the order rows arrive in', () => {
    const forward = planCity(sampleCity(), options())
    const reversed = planCity([...sampleCity()].reverse(), options())
    const shuffled = planCity(
      [...sampleCity()].sort((left, right) => left.objectId.localeCompare(right.objectId)).reverse(),
      options(),
    )
    for (const plan of [reversed, shuffled]) {
      expect(plan.blockCols).toBe(forward.blockCols)
      expect(plan.blockRows).toBe(forward.blockRows)
      for (const [objectId, lot] of forward.lots) {
        expect(plan.lots.get(objectId)).toEqual(lot)
      }
    }
  })

  it('produces the identical city every time for the same seed', () => {
    const first = planCity(sampleCity(), options())
    const second = planCity(sampleCity(), options())
    expect([...second.lots.entries()]).toEqual([...first.lots.entries()])
    expect([...second.facilities.entries()]).toEqual([...first.facilities.entries()])
  })

  it('gives a different database a different city', () => {
    const sales = planCity(sampleCity(), options({ seed: 'db:sales' }))
    const archive = planCity(sampleCity(), options({ seed: 'db:archive' }))
    const moved = [...sales.lots.entries()].filter(([objectId, lot]) => {
      const other = archive.lots.get(objectId)!
      return other.x !== lot.x || other.z !== lot.z
    })
    // Two databases of identical shape must not produce the same town, or the seed is doing nothing.
    expect(moved.length).toBeGreaterThan(sales.lots.size / 2)
  })

  it('keeps a building on the same lot when a later bounded page is appended', () => {
    const firstPage = sampleCity().filter(item => item.schemaId === 'schema:dbo')
    // The totals and schema list are identical on every page, which is what lets the first page be
    // planned against the whole database rather than against itself.
    const planned = planCity(firstPage, options())
    const withMorePages = planCity(sampleCity(), options())
    for (const item of firstPage) {
      const before = planned.lots.get(item.objectId)!
      const after = withMorePages.lots.get(item.objectId)!
      expect({ x: after.x, z: after.z }).toEqual({ x: before.x, z: before.z })
    }
    expect([...withMorePages.facilities.entries()]).toEqual([...planned.facilities.entries()])
  })

  it('never overlaps two lots', () => {
    const plan = planCity(sampleCity(), options())
    const lots = [...plan.lots.values()]
    for (let left = 0; left < lots.length; left += 1) {
      for (let right = left + 1; right < lots.length; right += 1) {
        const a = lots[left]!
        const b = lots[right]!
        const separated =
          Math.abs(a.x - b.x) >= plan.cell - 0.001 || Math.abs(a.z - b.z) >= plan.cell - 0.001
        expect(separated).toBe(true)
      }
    }
  })

  it('never puts a building on a facility block', () => {
    const plan = planCity(sampleCity(), options())
    const facilityBlocks = new Set(
      [...plan.facilities.values()].map(site => blockOf(plan, site.x, site.z)),
    )
    for (const lot of plan.lots.values()) {
      expect(facilityBlocks.has(blockOf(plan, lot.x, lot.z))).toBe(false)
    }
  })

  it('keeps every building inside its own district bounding box', () => {
    const plan = planCity(sampleCity(), options())
    for (const lot of plan.lots.values()) {
      const district = plan.districts.find(item => item.districtId === lot.districtId)!
      expect(lot.x).toBeGreaterThan(district.minX)
      expect(lot.x).toBeLessThan(district.maxX)
      expect(lot.z).toBeGreaterThan(district.minZ)
      expect(lot.z).toBeLessThan(district.maxZ)
    }
  })

  it('fronts every lot onto a street it can be entered from', () => {
    const plan = planCity(sampleCity(), options())
    const streetIds = new Set(plan.streets.map(street => street.id))
    for (const lot of plan.lots.values()) {
      expect(streetIds.has(lot.frontageStreetId)).toBe(true)
      expect(Math.abs(lot.accessZ - lot.z)).toBeLessThanOrEqual(plan.cell * BLOCK_ROWS)
      expect(lot.accessX).toBeCloseTo(lot.x, 6)
      expect(lot.rotationY).toBe(lot.facing === 'north' ? Math.PI : 0)
    }
  })

  it('gives every building its own block, ringed by street', () => {
    const objects = Array.from({ length: 9 }, (_unused, index) =>
      object(`object:dbo:${index}`, 'schema:dbo', 0, index))
    const plan = planCity(objects, options())
    const blocks = new Set([...plan.lots.values()].map(lot => lot.blockId))

    // The separation that schema tints used to provide now lives in the street lattice, so no two
    // buildings may share a block no matter how many objects the database holds.
    expect(blocks.size).toBe(objects.length)
    expect(CELLS_PER_BLOCK).toBe(1)
    expect(BLOCK_COLS * BLOCK_ROWS).toBe(CELLS_PER_BLOCK)
  })

  it('separates every pair of buildings by at least a street width', () => {
    const plan = planCity(sampleCity(), options())
    const lots = [...plan.lots.values()]
    for (const left of lots) {
      for (const right of lots) {
        if (left.objectId === right.objectId) continue
        // Lots sit one per block, so any two buildings differ by a full block pitch on at least one
        // axis. Their footprints are bounded by the cell, leaving the street clear between them.
        const gapX = Math.abs(left.x - right.x)
        const gapZ = Math.abs(left.z - right.z)
        expect(Math.max(gapX, gapZ)).toBeGreaterThanOrEqual(plan.cell)
      }
    }
  })

  it('scatters buildings rather than packing them into a corner', () => {
    const plan = planCity(sampleCity(), options())
    const rows = new Set([...plan.lots.values()].map(lot => blockOf(plan, lot.x, lot.z).split('-')[1]))
    const cols = new Set([...plan.lots.values()].map(lot => blockOf(plan, lot.x, lot.z).split('-')[0]))
    // A packed layout would occupy a few contiguous rows; a scattered one reaches across the grid.
    expect(rows.size).toBeGreaterThan(plan.blockRows / 2)
    expect(cols.size).toBeGreaterThan(plan.blockCols / 2)
  })

  it('plans a usable city from a single object', () => {
    const plan = planCity([object('object:dbo:1', 'schema:dbo', 0, 0)], options())
    expect(plan.lots.size).toBe(1)
    expect(plan.streets.length).toBeGreaterThan(0)
    expect(plan.bounds.width).toBeGreaterThan(0)
  })

  it('plans an empty city without throwing, and still sites its infrastructure', () => {
    const plan = planCity([], options())
    expect(plan.lots.size).toBe(0)
    expect(plan.districts).toHaveLength(0)
    expect(plan.facilities.size).toBe(FACILITY_ORDER.length)
  })
})

describe('facility scatter', () => {
  it('places every facility at least two blocks from every other', () => {
    for (const seed of ['db:sales', 'db:archive', 'db:1', 'db:2', 'db:3']) {
      const plan = planCity(sampleCity(), options({ seed }))
      const blocks = [...plan.facilities.values()].map(site => blockIndex(plan, site.x, site.z))
      expect(blocks).toHaveLength(FACILITY_ORDER.length)
      for (let left = 0; left < blocks.length; left += 1) {
        for (let right = left + 1; right < blocks.length; right += 1) {
          const gap = Math.max(
            Math.abs(blocks[left]!.col - blocks[right]!.col),
            Math.abs(blocks[left]!.row - blocks[right]!.row),
          )
          expect(gap).toBeGreaterThanOrEqual(MIN_FACILITY_BLOCK_GAP)
        }
      }
    }
  })

  it('sites one facility per kind, in a consistent reading order', () => {
    const plan = planCity(sampleCity(), options())
    expect([...plan.facilities.keys()]).toEqual([...FACILITY_ORDER])
    const blocks = FACILITY_ORDER.map(kind => blockIndex(plan, plan.facilities.get(kind)!.x, plan.facilities.get(kind)!.z))
    for (let index = 1; index < blocks.length; index += 1) {
      const previous = blocks[index - 1]!
      const current = blocks[index]!
      expect(current.row > previous.row || (current.row === previous.row && current.col > previous.col)).toBe(true)
    }
  })

  it('still lays out when the grid cannot satisfy the spacing rule', () => {
    // Falls back to a maximise-minimum-distance sweep rather than throwing or dropping a facility.
    const plan = planCity([], { seed: 'tiny' })
    expect(plan.facilities.size).toBe(FACILITY_ORDER.length)
    const seen = new Set([...plan.facilities.values()].map(site => `${site.x}/${site.z}`))
    expect(seen.size).toBe(FACILITY_ORDER.length)
  })
})

describe('street graph', () => {
  it('connects every intersection to every other intersection', () => {
    const plan = planCity(sampleCity())
    const ids = [...plan.intersections.keys()]
    const first = ids[0]!
    for (const id of ids) {
      expect(streetPath(plan, first, id).length).toBeGreaterThan(0)
    }
  })

  it('produces a continuous path where every step is a real street', () => {
    const plan = planCity(sampleCity())
    const ids = [...plan.intersections.keys()].sort()
    const path = streetPath(plan, ids[0]!, ids[ids.length - 1]!)
    expect(path[0]).toBe(ids[0])
    expect(path[path.length - 1]).toBe(ids[ids.length - 1])

    // Steps used to be asserted as one block of Manhattan distance, which quietly assumed the network
    // was nothing but the lattice. Diagonal avenues are real edges now, so the invariant that actually
    // matters is that consecutive nodes are joined by a street that exists.
    const edges = new Set(plan.streets.flatMap(street => [
      `${street.fromId}>${street.toId}`,
      `${street.toId}>${street.fromId}`,
    ]))
    for (let index = 1; index < path.length; index += 1) {
      expect(edges.has(`${path[index - 1]}>${path[index]}`)).toBe(true)
    }
  })

  it('is deterministic and symmetric in length', () => {
    const plan = planCity(sampleCity())
    const ids = [...plan.intersections.keys()].sort()
    const forward = streetPath(plan, ids[0]!, ids[ids.length - 1]!)
    expect(streetPath(plan, ids[0]!, ids[ids.length - 1]!)).toEqual(forward)
    expect(streetPath(plan, ids[ids.length - 1]!, ids[0]!)).toHaveLength(forward.length)
  })

  it('returns an empty path for an unknown intersection', () => {
    const plan = planCity(sampleCity())
    expect(streetPath(plan, 'x0:z0', 'nowhere')).toEqual([])
  })

  it('walks streets between two buildings instead of cutting across blocks', () => {
    const plan = planCity(sampleCity())
    const lots = [...plan.lots.values()]
    const from = { x: lots[0]!.accessX, z: lots[0]!.accessZ }
    const to = { x: lots[lots.length - 1]!.accessX, z: lots[lots.length - 1]!.accessZ }
    const line = streetPolyline(plan, from, to)
    expect(line.length).toBeGreaterThan(2)

    // Every vertex between the two kerbs sits on a carriageway. The endpoints are excused because a
    // lot's access point is deliberately half a street off the centre line, at the kerb.
    for (let index = 1; index < line.length - 1; index += 1) {
      expect(distanceToStreetNetwork(plan, line[index]!)).toBeLessThanOrEqual(STREET_WIDTH)
    }
  })

  it('threads one continuous street path through every waypoint in order', () => {
    const plan = planCity(sampleCity())
    const lots = [...plan.lots.values()]
    const stops = [lots[0]!, lots[2]!, lots[lots.length - 1]!].map(lot => ({
      x: lot.accessX,
      z: lot.accessZ,
    }))
    const threaded = streetPolylineThrough(plan, stops)

    // Every waypoint is actually visited, so a shared lane really does pass each building it names.
    for (const stop of stops) {
      expect(threaded.some(point => point.x === stop.x && point.z === stop.z)).toBe(true)
    }
    // Waypoints appear in the order given: the path is one journey, not three overlapping ones.
    const visits = stops.map(stop =>
      threaded.findIndex(point => point.x === stop.x && point.z === stop.z))
    expect(visits).toEqual([...visits].sort((left, right) => left - right))
    // Still drives on streets rather than cutting the corner between legs.
    for (let index = 1; index < threaded.length - 1; index += 1) {
      expect(distanceToStreetNetwork(plan, threaded[index]!)).toBeLessThanOrEqual(STREET_WIDTH)
    }
    // No duplicated vertex where one leg hands over to the next.
    for (let index = 1; index < threaded.length; index += 1) {
      expect(threaded[index]).not.toEqual(threaded[index - 1])
    }
  })

  it('draws nothing for a lane with fewer than two waypoints', () => {
    const plan = planCity(sampleCity())
    expect(streetPolylineThrough(plan, [])).toEqual([])
    expect(streetPolylineThrough(plan, [{ x: 0, z: 0 }])).toEqual([])
  })

  it('snaps a world point to the nearest intersection', () => {
    const plan = planCity(sampleCity())
    expect(nearestIntersectionId(plan, 0, 0)).toBe('x0:z0')
    expect(plan.intersections.has(nearestIntersectionId(plan, -9999, -9999))).toBe(true)
    expect(plan.intersections.has(nearestIntersectionId(plan, 9999, 9999))).toBe(true)
  })

  it('marks district boundaries as arterials', () => {
    const plan = planCity(sampleCity())
    expect(plan.streets.some(street => street.streetClass === 'arterial')).toBe(true)
    for (const street of plan.streets) {
      expect(street.width).toBeGreaterThan(0)
    }
  })
})

/** A city big enough to earn a ring boulevard, diagonals and a river. */
function largeCity(count = 220): DatabaseCityObject[] {
  const objects: DatabaseCityObject[] = []
  const perSchema = Math.ceil(count / 3)
  for (let index = 0; index < count; index += 1) {
    const ordinal = Math.floor(index / perSchema)
    objects.push(
      object(
        `object:${index}`,
        `schema:s${ordinal}`,
        ordinal,
        index % perSchema,
        String(1024 * (1 + (index % 40))),
        String(512 * (1 + (index % 40))),
      ),
    )
  }
  return objects
}

function largeOptions(seed = 'db:sales'): CityPlanOptions {
  return {
    seed,
    totalObjects: '220',
    schemas: [0, 1, 2].map(ordinal => ({
      schemaId: `schema:s${ordinal}`,
      name: `s${ordinal}`,
      neighborhoodOrdinal: ordinal,
      objectCount: '74',
      evidence,
    })),
  }
}

describe('street network', () => {
  it('draws every street between the intersections it connects', () => {
    const plan = planCity(largeCity(), largeOptions())
    for (const street of plan.streets) {
      const first = street.path[0]!
      const last = street.path[street.path.length - 1]!
      expect(street.path.length).toBeGreaterThan(1)
      // Curvature is decoration: it moves the middle of a road, never its ends, so the graph the
      // route finder walks is exactly the graph the map draws.
      expect(first.x).toBeCloseTo(street.fromX, 9)
      expect(first.z).toBeCloseTo(street.fromZ, 9)
      expect(last.x).toBeCloseTo(street.toX, 9)
      expect(last.z).toBeCloseTo(street.toZ, 9)
      expect(plan.intersections.has(street.fromId)).toBe(true)
      expect(plan.intersections.has(street.toId)).toBe(true)
    }
  })

  it('never runs a carriageway through a measured building', () => {
    // The single invariant that lets roads curve at all: a bowed street, an embankment shifted onto
    // the far bank and a diagonal avenue must all still miss every footprint the catalogue measured.
    const violations: string[] = []
    for (const seed of ['db:sales', 'db:warehouse', 'db:archive', 'db:ops']) {
      const plan = planCity(largeCity(), largeOptions(seed))
      const lots = [...plan.lots.values()].filter(lot => lot.footprint !== null)
      for (const street of plan.streets) {
        const reach = street.width / 2
        for (const point of street.path) {
          for (const lot of lots) {
            const half = lot.footprint! / 2 + reach
            if (Math.abs(point.x - lot.x) < half && Math.abs(point.z - lot.z) < half) {
              violations.push(`${seed}: ${street.id} (${street.streetClass}) hits ${lot.objectId}`)
            }
          }
        }
      }
    }
    expect(violations.slice(0, 5)).toEqual([])
  })

  it('bends most of its streets without turning any of them into a detour', () => {
    const plan = planCity(largeCity(), largeOptions())
    const curved = plan.streets.filter(street => street.path.length > 2)
    expect(curved.length).toBeGreaterThan(plan.streets.length * 0.5)
    for (const street of plan.streets) {
      const straight = Math.hypot(street.toX - street.fromX, street.toZ - street.fromZ)
      let drawn = 0
      for (let index = 1; index < street.path.length; index += 1) {
        drawn += Math.hypot(
          street.path[index]!.x - street.path[index - 1]!.x,
          street.path[index]!.z - street.path[index - 1]!.z,
        )
      }
      // A curve costs a little length. More than half again would read as a detour, not a bend.
      expect(drawn).toBeLessThan(straight * 1.5)
    }
  })

  it('adds a road hierarchy the lattice alone could not express', () => {
    const plan = planCity(largeCity(), largeOptions())
    const classes = new Set(plan.streets.map(street => street.streetClass))
    expect(classes.has('collector')).toBe(true)
    expect(classes.has('arterial')).toBe(true)
    expect(classes.has('boulevard')).toBe(true)
    expect(classes.has('avenue')).toBe(true)
  })

  it('runs its diagonal avenues between real intersections it did not invent', () => {
    const plan = planCity(largeCity(), largeOptions())
    const avenues = plan.streets.filter(street => street.axis === 'd')
    expect(avenues.length).toBeGreaterThan(0)
    for (const avenue of avenues) {
      const from = plan.intersections.get(avenue.fromId)!
      const to = plan.intersections.get(avenue.toId)!
      expect(from).toBeDefined()
      expect(to).toBeDefined()
      // One block diagonally: a genuine short cut across the lattice, not a new junction.
      expect(Math.abs(from.col - to.col)).toBe(1)
      expect(Math.abs(from.row - to.row)).toBe(1)
    }
  })

  it('carries its crossings on bridges and its riverside roads on the bank', () => {
    const plan = planCity(largeCity(), largeOptions())
    expect(plan.terrain.river.length).toBeGreaterThan(2)
    expect(plan.streets.some(street => street.bridge)).toBe(true)
    expect(plan.streets.some(street => street.streetClass === 'riverside')).toBe(true)
    for (const street of plan.streets) {
      // A deck is a structure, so it is drawn straight; and nothing is both a bank and a crossing.
      if (street.bridge) expect(street.path).toHaveLength(2)
      if (street.streetClass === 'riverside') expect(street.bridge).toBe(false)
    }
  })

  it('draws the same city twice for the same database', () => {
    const first = planCity(largeCity(), largeOptions())
    const second = planCity(largeCity(), largeOptions())
    expect(second.streets).toEqual(first.streets)
    expect([...second.lots.entries()]).toEqual([...first.lots.entries()])
  })
})
