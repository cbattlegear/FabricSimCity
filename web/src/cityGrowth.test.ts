import { describe, expect, it } from 'vitest'
import { planCity, type CityPlan, type CityPlanOptions } from './cityPlan'
import type { DatabaseCityObject, DatabaseCitySchema } from './databaseCityContracts'
import type { Evidence } from './contracts'

/*
 * Does the city survive the database changing under it?
 *
 * Issue #47 measured that above 75 objects, adding a single table retraced every street and moved
 * every building, so nothing a user had learned about where things are survived a schema change.
 * These tests are that measurement, kept: they plan a city, add a table, and compare the two plans
 * street by street and building by building.
 *
 * The property under test is deliberately narrow and absolute -- *no* existing building moves --
 * because anything softer is unfalsifiable. A city that reshuffles "only a bit" is still a city you
 * have to relearn.
 */

const evidence: Evidence = {
  source: 'CatalogSnapshot',
  status: 'Available',
  observedAt: null,
  freshUntil: null,
  reason: 'test',
}

const SCHEMA_COUNT = 3

function schemaIdFor(index: number): string {
  return `schema:s${index % SCHEMA_COUNT}`
}

/**
 * Reserved pages for the object at `index`, spread over four orders of magnitude.
 *
 * Sizes have to vary, because the old placement matched objects to blocks by footprint rank and a
 * city of identically sized tables would hide exactly the churn being measured. Deliberately not
 * monotonic in the index, so a table added at the end is an ordinary-sized table rather than always
 * the largest or the smallest.
 */
function reservedPagesFor(index: number): string {
  return String(8 + ((index * 2654435761) % 40_000))
}

/**
 * The id the connected collector builds for an object: `{databaseId}/object/{sys.objects.object_id}`,
 * with the id written out unpadded exactly as that collector writes it.
 *
 * Unpadded on purpose. Placement hands out ground in catalogue order and relies on a newly created
 * table sorting after every table already there; compared as text an unpadded id breaks that, because
 * `object/9` sorts after `object/1234567`. Padding these in the test would hide the one property the
 * tests below exist to prove. The base of 3 puts the run across both the 9-to-10 and 99-to-100
 * boundaries, where a text comparison and a numeric one disagree.
 */
function objectIdFor(index: number): string {
  return `db:growth/object/${index + 3}`
}

function object(index: number): DatabaseCityObject {
  const schemaId = schemaIdFor(index)
  const reserved = reservedPagesFor(index)
  const used = String(Math.floor(Number(reserved) * 0.8))
  return {
    objectId: objectIdFor(index),
    schemaId,
    schemaName: schemaId.replace('schema:', ''),
    name: `t${index}`,
    kind: 'Table',
    reservedPages8KiB: reserved,
    usedPages8KiB: used,
    reservedBytes: String(BigInt(reserved) * 8192n),
    usedBytes: String(BigInt(used) * 8192n),
    sizeStatus: 'Known',
    sizeReason: null,
    layout: {
      neighborhoodOrdinal: index % SCHEMA_COUNT,
      // The connected collector numbers objects across the whole database in object-id order.
      objectOrdinal: index,
      x: 0,
      z: 0,
    },
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

function schemasFor(objects: readonly DatabaseCityObject[]): DatabaseCitySchema[] {
  const counts = new Map<string, number>()
  for (const item of objects) counts.set(item.schemaId, (counts.get(item.schemaId) ?? 0) + 1)
  return [...counts.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : 1))
    .map(([schemaId, count], index) => ({
      schemaId,
      name: schemaId.replace('schema:', ''),
      neighborhoodOrdinal: index,
      objectCount: String(count),
      evidence,
    }))
}

/** The city a database of `count` objects reports, exactly as a completed page walk would carry it. */
export function cityOf(count: number): { objects: DatabaseCityObject[]; options: CityPlanOptions } {
  const objects = Array.from({ length: count }, (_, index) => object(index))
  return {
    objects,
    options: {
      seed: 'db:growth',
      totalObjects: String(count),
      schemas: schemasFor(objects),
    },
  }
}

function planOf(count: number): CityPlan {
  const { objects, options } = cityOf(count)
  return planCity(objects, options)
}

/** Every street's identity and drawn shape, so a retraced network cannot compare equal to the old one. */
function streetSignature(plan: CityPlan): string {
  return plan.streets
    .map(street =>
      [
        street.id,
        street.streetClass,
        ...street.path.map(point => `${point.x.toFixed(2)},${point.z.toFixed(2)}`),
      ].join('|'),
    )
    .sort()
    .join('\n')
}

function lotsOf(plan: CityPlan): Map<string, string> {
  const lots = new Map<string, string>()
  for (const [objectId, lot] of plan.lots) lots.set(objectId, lot.blockId)
  return lots
}

/** How many buildings present in both plans stand on a different block in the second. */
function movedBuildings(before: CityPlan, after: CityPlan): string[] {
  const first = lotsOf(before)
  const second = lotsOf(after)
  const moved: string[] = []
  for (const [objectId, blockId] of first) {
    const now = second.get(objectId)
    if (now !== undefined && now !== blockId) moved.push(objectId)
  }
  return moved
}

/**
 * The traced street network is cached and handed to every plan that shares a seed, by reference. That
 * is what makes a page merge cheap, and it is also the one way this change could corrupt a city
 * rather than stabilise it: if any part of planning wrote to the shared network, the second city to
 * use it would be planned against ground the first had already altered.
 *
 * Reading the consumers is not proof, because a future consumer could start writing. These plan the
 * same city on either side of a different one and check the network came back identical, which fails
 * the moment anything mutates what it was lent.
 */
describe('the shared street network', () => {
  it('survives another city being planned against it', () => {
    const first = planOf(100)
    const signature = streetSignature(first)
    const lots = lotsOf(first)

    planOf(140)
    planOf(100)

    // The first plan object itself, not a fresh one: it holds the shared network by reference, so it
    // is where a leak would show.
    expect(streetSignature(first)).toEqual(signature)
    expect(lotsOf(first)).toEqual(lots)
  })

  it('plans the same city identically whether or not it was traced fresh', () => {
    const traced = planOf(100)
    const cached = planOf(100)
    expect(streetSignature(cached)).toEqual(streetSignature(traced))
    expect(lotsOf(cached)).toEqual(lotsOf(traced))
    expect(cached.intersections.size).toEqual(traced.intersections.size)
    expect(cached.terrain).toEqual(traced.terrain)
    expect(cached.districts).toEqual(traced.districts)
  })

  it('routes the same way after another city has used the router', () => {
    const first = planOf(100)
    const ids = [...first.intersections.keys()].sort()
    const from = first.intersections.get(ids[0])!
    const to = first.intersections.get(ids[ids.length - 1])!
    const before = first.router.route(from.col, to.col)

    planOf(140).router.route(from.col, to.col)

    expect(first.router.route(from.col, to.col)).toEqual(before)
  })
})

describe('adding a table to the database', () => {
  /*
   * Sizes spanning the ones issue #47 measured, chosen to sit *between* rungs of the growth ladder,
   * because that is where almost every database sits: a rung is a 25% jump, so at a hundred tables
   * only one added table in twenty-five lands on one. The rungs themselves are asserted separately
   * below rather than quietly excluded.
   */
  const sizes = [5, 15, 74, 100, 200, 500]

  /*
   * Each case plans two cities, and at the larger sizes both can miss the traced-network cache and
   * lay a street network from scratch, which is seconds of honest work rather than a hang. Vitest's
   * five second default sits right on that boundary, so it is stated here instead of left to decide
   * the result by how busy the machine is.
   */
  const PLAN_TIMEOUT_MS = 60_000

  it.each(sizes)('leaves every existing building where it was, at %i objects', count => {
    const before = planOf(count)
    const after = planOf(count + 1)
    expect(movedBuildings(before, after)).toEqual([])
  }, PLAN_TIMEOUT_MS)

  it.each(sizes)('leaves the street network untouched, at %i objects', count => {
    expect(streetSignature(planOf(count + 1))).toBe(streetSignature(planOf(count)))
  }, PLAN_TIMEOUT_MS)

  it.each(sizes)('gives the new table a building of its own, at %i objects', count => {
    const before = planOf(count)
    const after = planOf(count + 1)
    const added = objectIdFor(count)
    expect(before.lots.has(added)).toBe(false)
    expect(after.lots.has(added)).toBe(true)
    expect(after.lots.size).toBe(before.lots.size + 1)
  }, PLAN_TIMEOUT_MS)

  it.each(sizes)('stands every building on ground of its own, at %i objects', count => {
    const plan = planOf(count + 1)
    const blocks = new Set([...plan.lots.values()].map(lot => lot.blockId))
    expect(blocks.size).toBe(plan.lots.size)
  }, PLAN_TIMEOUT_MS)

  it('does not stand the new building on ground another building already holds', () => {
    const before = planOf(120)
    const after = planOf(121)
    const taken = new Set([...before.lots.values()].map(lot => lot.blockId))
    const added = after.lots.get(objectIdFor(120))!
    expect(taken.has(added.blockId)).toBe(false)
  })

  /*
   * A quantised city redraws on a ladder step rather than never. The promise is that growth is rare
   * and bounded, so this walks a long stretch of it and counts how often the network is retraced
   * rather than asserting it never is.
   */
  it('retraces the streets rarely rather than on every added table', () => {
    let retraced = 0
    let previous = streetSignature(planOf(80))
    for (let count = 81; count <= 140; count += 1) {
      const signature = streetSignature(planOf(count))
      if (signature !== previous) retraced += 1
      previous = signature
    }
    expect(retraced).toBeLessThanOrEqual(2)
  }, 60_000)

  /*
   * The honest half of the trade. Growth cannot be both continuous and stable: either every added
   * table moves the map a little, or the map holds still and rebuilds on a rung. This asserts the
   * rebuild really does happen there, so the ladder is a documented behaviour rather than a gap in
   * the tests above.
   */
  it('does rebuild the city when the database climbs a rung', () => {
    expect(streetSignature(planOf(77))).not.toBe(streetSignature(planOf(76)))
  })
})

describe('a table created after the city was drawn', () => {
  /*
   * The premise the whole append-only guarantee rests on, tested on its own because it is the one
   * that is quietly false under a text comparison: SQL Server writes object ids unpadded, so
   * `object/9` sorts after `object/1234567` as text. A table created into a database whose ids have
   * just gained a digit is the case that would otherwise land mid-order and push every building after
   * it along.
   */
  it('sorts last however many digits its object id has', () => {
    // 97 objects run to object id 99, so the 98th is id 100 — the first three-digit id in the
    // database. Compared as text it sorts before `11`, landing near the front of the catalogue and
    // pushing most of the city along; compared as a number it sorts last, which is the truth.
    const before = planOf(97)
    const after = planOf(98)
    expect(movedBuildings(before, after)).toEqual([])
    expect(after.lots.has(objectIdFor(97))).toBe(true)
  })

  it('takes ground no earlier table wanted', () => {
    const before = planOf(97)
    const after = planOf(98)
    const taken = new Set([...before.lots.values()].map(lot => lot.blockId))
    expect(taken.has(after.lots.get(objectIdFor(97))!.blockId)).toBe(false)
  })
})

describe('a table growing', () => {
  /** The same database, with one table holding more pages than it did before. */
  function grownBy(count: number, index: number, pages: string): CityPlan {
    const { objects, options } = cityOf(count)
    const grown = objects.map(item =>
      item.objectId === objectIdFor(index)
        ? {
            ...item,
            reservedPages8KiB: pages,
            usedPages8KiB: pages,
            reservedBytes: String(BigInt(pages) * 8192n),
            usedBytes: String(BigInt(pages) * 8192n),
          }
        : item,
    )
    return planCity(grown, options)
  }

  /*
   * The everyday case, and the one that would be worst if it churned: tables gain pages constantly,
   * so a city that retraces when its largest table grows is a city that is never the same twice.
   */
  it('does not retrace the city when a table gains pages', () => {
    const before = planOf(120)
    const after = grownBy(120, 7, '90000')
    expect(streetSignature(after)).toBe(streetSignature(before))
    expect(movedBuildings(before, after)).toEqual([])
  })
})
