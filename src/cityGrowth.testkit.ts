/**
 * The fixtures behind the `cityGrowth*` specs: a synthetic capacity of `count` items, and the
 * comparisons that decide whether adding one to it moved anything.
 *
 * Does the city survive the capacity changing under it?
 *
 * Issue #47 measured that above 75 items, adding a single item retraced every street and moved
 * every building, so nothing a user had learned about where things are survived a workspace change.
 * Those specs are that measurement, kept: they plan a city, add an item, and compare the two plans
 * street by street and building by building.
 *
 * The property under test is deliberately narrow and absolute -- *no* existing building moves --
 * because anything softer is unfalsifiable. A city that reshuffles "only a bit" is still a city you
 * have to relearn.
 *
 * Not a spec itself. The `.testkit.ts` suffix keeps it out of vitest's `*.test.ts` collection, so
 * the specs can share these fixtures without registering each other's suites a second time.
 *
 * They are separate files rather than one because planning a city is seconds of honest work and
 * vitest parallelises across files but not within one. Held together they were 36.7s of a 44s web
 * suite -- one file the other 41 waited on. Anything added here belongs in whichever spec keeps its
 * own file's cost off the critical path.
 */
import { planCity, type CityPlan, type CityPlanOptions } from './cityPlan'
import type { CapacityCityItem, CapacityCityWorkspace } from './capacityCityContracts'
import type { Evidence } from './fabricContracts'

const evidence: Evidence = {
  source: 'SemanticModel',
  status: 'Available',
  observedAt: null,
  freshUntil: null,
}

const WORKSPACE_COUNT = 3

/**
 * Sizes spanning the ones issue #47 measured, chosen to sit *between* rungs of the growth ladder,
 * because that is where almost every capacity sits: a rung is a 25% jump, so at a hundred items
 * only one added item in twenty-five lands on one. The rungs themselves are asserted separately
 * rather than quietly excluded.
 */
export const GROWTH_SIZES = [5, 15, 74, 100, 200, 500]

/**
 * Each case plans two cities, and at the larger sizes both can miss the traced-network cache and
 * lay a street network from scratch, which is seconds of honest work rather than a hang. Vitest's
 * five second default sits right on that boundary, so it is stated here instead of left to decide
 * the result by how busy the machine is.
 */
export const PLAN_TIMEOUT_MS = 60_000

function workspaceIdFor(index: number): string {
  return `workspace:s${index % WORKSPACE_COUNT}`
}

/**
 * OneLake bytes for the item at `index`, spread over four orders of magnitude.
 *
 * Sizes have to vary, because a city of identically sized items would hide exactly the churn being
 * measured. Deliberately not monotonic in the index, so an item added at the end is an ordinary-sized
 * item rather than always the largest or the smallest. Kept well inside a single footprint rung so a
 * new item, or one that grows, does not resize the city — the property the growth specs defend.
 */
function storageBytesFor(index: number): string {
  return String(8 + ((index * 2654435761) % 40_000))
}

/**
 * The id the collector builds for an item, written out unpadded exactly as the collector writes it.
 *
 * Unpadded on purpose. Placement hands out ground in catalogue order and relies on a newly created
 * item sorting after every item already there; compared as text an unpadded id breaks that, because
 * `item/9` sorts after `item/1234567`. Padding these in the test would hide the one property the
 * specs exist to prove. The base of 3 puts the run across both the 9-to-10 and 99-to-100
 * boundaries, where a text comparison and a numeric one disagree.
 */
export function itemIdFor(index: number): string {
  return `capacity:growth/item/${index + 3}`
}

function item(index: number): CapacityCityItem {
  const workspaceId = workspaceIdFor(index)
  const bytes = storageBytesFor(index)
  const cuSeconds = String(Math.floor(Number(bytes) * 0.8))
  return {
    itemId: itemIdFor(index),
    workspaceId,
    workspaceName: workspaceId.replace('workspace:', ''),
    name: `item${index}`,
    kind: 'Lakehouse',
    archetype: 'Storage',
    storage: { bytes, status: 'Known', evidence },
    cuConsumed: { cuSeconds, status: 'Known', evidence },
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
    layout: {
      neighborhoodOrdinal: index % WORKSPACE_COUNT,
      // The collector numbers items across the whole capacity in item-id order.
      itemOrdinal: index,
    },
    sizeStatus: 'Known',
    evidence,
  }
}

function workspacesFor(items: readonly CapacityCityItem[]): CapacityCityWorkspace[] {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.workspaceId, (counts.get(item.workspaceId) ?? 0) + 1)
  return [...counts.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : 1))
    .map(([workspaceId, count], index) => ({
      workspaceId,
      name: workspaceId.replace('workspace:', ''),
      neighborhoodOrdinal: index,
      itemCount: String(count),
      evidence,
    }))
}

/** The city a capacity of `count` items reports, exactly as a completed page walk would carry it. */
export function cityOf(count: number): { items: CapacityCityItem[]; options: CityPlanOptions } {
  const items = Array.from({ length: count }, (_, index) => item(index))
  return {
    items,
    options: {
      seed: 'capacity:growth',
      totalItems: String(count),
      workspaces: workspacesFor(items),
    },
  }
}

export function planOf(count: number): CityPlan {
  const { items, options } = cityOf(count)
  return planCity(items, options)
}

/** Every street's identity and drawn shape, so a retraced network cannot compare equal to the old one. */
export function streetSignature(plan: CityPlan): string {
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

export function lotsOf(plan: CityPlan): Map<string, string> {
  const lots = new Map<string, string>()
  for (const [itemId, lot] of plan.lots) lots.set(itemId, lot.blockId)
  return lots
}

/** How many buildings present in both plans stand on a different block in the second. */
export function movedBuildings(before: CityPlan, after: CityPlan): string[] {
  const first = lotsOf(before)
  const second = lotsOf(after)
  const moved: string[] = []
  for (const [itemId, blockId] of first) {
    const now = second.get(itemId)
    if (now !== undefined && now !== blockId) moved.push(itemId)
  }
  return moved
}
