import type { OperationFamily, CapacityCityItem } from './capacityCityContracts'

/**
 * Which ranked operation families this city can actually draw, and how to say so.
 *
 * The families table is a list of things to click, and its "Show on map" control is the reason to
 * click them. A family whose item list names nothing this city has placed cannot answer that click:
 * it walks the listed items, finds no building to stop at and draws a route through none of them.
 * Historically, at the default of 48 published families on SQLSimCity's seeded `SimCitySmall`, that
 * was 30 of 48 rows -- well over half the table -- so the list is mostly things that look
 * actionable and are not.
 *
 * Hiding them is therefore the default, and the count of what was hidden is stated rather than
 * dropped. That is the same contract the operation feed keeps when it reports how much evidence is
 * off-page or otherwise unavailable: the reader is told the list is partial and by how much, so a
 * short list is never mistaken for a quiet capacity.
 */

/**
 * What "on the map" means here, and why it is the narrower of the two candidates.
 *
 * A family carries `itemIds`, and the obvious test is whether it carries any at all. That test
 * over-promises, because the city is paged. The route can only stop at items this view has *loaded*;
 * a reference it cannot match becomes an `offmap` stop rather than a building. So a family naming
 * only items from a page that is not loaded passes the "has any id" test and still draws a
 * route with no stop on it -- exactly the click this filter exists to remove.
 *
 * Historically, on SQLSimCity's `SimCitySmall` at 48 published families: 20 families carried at
 * least one object id, and only 18 named one the loaded page drew. The two definitions differed by
 * 2 rows on a 60-object database, and the same gap widens with the item count here, since a larger
 * city is more pages.
 *
 * So the test is membership in the ids the map has placed. It is deliberately the same input the
 * route walk uses, so the filter cannot promise a stop the route then fails to make.
 */
export function familyOnMap(
  family: Pick<OperationFamily, 'itemIds'>,
  placedObjectIds: ReadonlySet<string>,
): boolean {
  return family.itemIds.some(id => placedObjectIds.has(id))
}

/** The ids of everything this city has actually placed, which is what a route can stop at. */
export function placedObjectIds(objects: readonly CapacityCityItem[]): ReadonlySet<string> {
  return new Set(objects.map(object => object.itemId))
}

export interface QueryFamilyMapSplit<T> {
  /** The rows to render, which is every family when the toggle is on and the mapped ones when off. */
  shown: readonly T[]
  /** Families naming at least one placed item. */
  mapped: number
  /** Families naming none, which is what the toggle reveals. */
  unmapped: number
  total: number
  /** The toggle's own label, which is where the hidden count is disclosed. */
  toggleLabel: string
  /** The longer sentence under the table, saying what the filter tested and against what. */
  reason: string
}

/**
 * Splits the ranked families into what is drawable and what is not.
 *
 * `showUnmapped` only decides what is *rendered*: the counts are computed over the whole list
 * either way, so the label keeps stating the size of the hidden set while it is being shown. A
 * label that read "show 30 hidden" and then vanished once they were shown would leave a reader
 * with no way to tell a filtered list from an unfiltered one.
 */
export function splitQueryFamiliesByMap<T extends Pick<OperationFamily, 'itemIds'>>(
  families: readonly T[],
  placed: ReadonlySet<string>,
  showUnmapped: boolean,
): QueryFamilyMapSplit<T> {
  const mappedFamilies = families.filter(family => familyOnMap(family, placed))
  const mapped = mappedFamilies.length
  const total = families.length
  const unmapped = total - mapped
  return {
    shown: showUnmapped ? families : mappedFamilies,
    mapped,
    unmapped,
    total,
    toggleLabel: toggleLabel(unmapped, total, showUnmapped),
    reason: reason(mapped, unmapped, total, placed.size, showUnmapped),
  }
}

function toggleLabel(unmapped: number, total: number, showUnmapped: boolean): string {
  if (total === 0) return 'Show operation families with nothing on this map'
  if (unmapped === 0) {
    // Nothing to reveal, and saying so is the point: an unchecked box next to "0 hidden" tells the
    // reader the list is already complete, where a silent absent control would leave them guessing
    // whether a filter had trimmed it.
    return `Show operation families with nothing on this map — none of the ${total} are hidden`
  }
  return showUnmapped
    ? `Showing ${unmapped} of ${total} ${plural(unmapped, 'operation family', 'operation families')} with nothing on this map`
    : `Show ${unmapped} of ${total} ${plural(unmapped, 'operation family', 'operation families')} with nothing on this map`
}

function reason(
  mapped: number,
  unmapped: number,
  total: number,
  placed: number,
  showUnmapped: boolean,
): string {
  if (total === 0) return 'No operation family has been published for this capacity yet.'
  const scope = `“On this map” is measured against the ${placed} ${plural(placed, 'item', 'items')} this page has placed, not against every item in the capacity, because a route can only stop at a building the city has drawn.`
  if (unmapped === 0) {
    return `All ${total} published ${plural(total, 'family', 'families')} name at least one item on this map. ${scope}`
  }
  return showUnmapped
    ? `All ${total} published ${plural(total, 'family', 'families')} are listed, including ${unmapped} whose ${plural(unmapped, 'item list names', 'item lists name')} nothing on this map; “Show on map” draws no stop for ${plural(unmapped, 'that one', 'those')}. ${scope}`
    : `${mapped} of ${total} published ${plural(total, 'family', 'families')} shown; ${unmapped} hidden because ${plural(unmapped, 'its item list names', 'their item lists name')} nothing on this map and “Show on map” would draw no stop. ${scope}`
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}
