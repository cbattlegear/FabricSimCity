import type { CityPlan } from './cityPlan'
import type { Facility } from './cityInfrastructure'
import type { CapacityCityItem, OperationFamily } from './capacityCityContracts'
import { formatBytes } from './capacityAtlas'

/**
 * The address book: one flat, searchable index of everything the map can take you to.
 *
 * A city has three kinds of destination — the operation families that generate the traffic, the
 * items those operations visit, and the infrastructure facilities where their load ends up.
 * Splitting them across three lists would make you know which list a thing lives in before you
 * could look it up, so they share one list and one search box, grouped only for legibility.
 *
 * Every entry carries an **address** derived from the city plan, which is what makes this an address
 * book rather than a table of contents: it tells you where on the map the thing actually is. An
 * entry whose item was not on the loaded page has no lot and therefore no address, and says so
 * rather than inventing a location.
 */

export type AddressKind = 'query' | 'item' | 'facility'

export interface AddressEntry {
  readonly id: string
  readonly kind: AddressKind
  /** Stable target used by the map: item id, facility kind, or operation family id. */
  readonly targetId: string
  readonly name: string
  /** One-line measured summary. Never a verdict, always a quantity or an explicit unavailability. */
  readonly meta: string
  /** Where it stands, from the city plan, or null when this entry has no lot on the loaded page. */
  readonly address: string | null
  /** Lowercased haystack the search box matches against. */
  readonly searchText: string
  /** Sort key within a group. Higher sorts first. */
  readonly rank: number
}

export interface AddressGroup {
  readonly kind: AddressKind
  readonly label: string
  readonly entries: readonly AddressEntry[]
}

const GROUP_LABELS: Readonly<Record<AddressKind, string>> = {
  query: 'Operation families',
  item: 'Items',
  facility: 'Infrastructure',
}

/** Column letters for block addresses: 0 → A, 25 → Z, 26 → AA. Mirrors spreadsheet lettering. */
export function columnLabel(index: number): string {
  let remaining = index
  let label = ''
  do {
    label = String.fromCharCode(65 + (remaining % 26)) + label
    remaining = Math.floor(remaining / 26) - 1
  } while (remaining >= 0)
  return label
}

/**
 * A human-readable address for a world position, as `District · Block C4`.
 *
 * The block comes from the plan's own warp rather than from a division, because the blocks are traced
 * from a tensor field and no two are the same size — so `x / pitch` would name a block the map does
 * not draw there. It is a locator and carries no quantity claim.
 */
export function blockAddress(plan: CityPlan, x: number, z: number, districtName?: string): string {
  const { col, row } = plan.warp.blockAt(x, z)
  const block = `Block ${columnLabel(Math.max(0, col))}${Math.max(0, row) + 1}`
  return districtName ? `${districtName} · ${block}` : block
}

function toNumber(value: string | null): number {
  if (value === null) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function compactCount(value: string | null): string {
  if (value === null) return 'unavailable'
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return value
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(parsed)
}

function itemEntry(item: CapacityCityItem, plan: CityPlan): AddressEntry {
  const lot = plan.lots.get(item.itemId)
  const district = plan.districts.find(candidate => candidate.districtId === item.workspaceId)
  const name = `${item.workspaceName}.${item.name}`
  // Three cases, kept apart so a compute-only item is never confused with a missing measurement:
  // an unknown storage measurement is unavailable; a *known* null is an item that stores nothing
  // in OneLake by nature (a Notebook, a Pipeline); a known byte count is a real footprint.
  const size = item.storage.status !== 'Known'
    ? 'size unavailable'
    : item.storage.bytes === null
      ? 'no OneLake storage'
      : `${formatBytes(item.storage)} in OneLake`
  return {
    id: `item:${item.itemId}`,
    kind: 'item',
    targetId: item.itemId,
    name,
    meta: `${item.kind} · ${size}`,
    address: lot ? blockAddress(plan, lot.x, lot.z, district?.name) : null,
    searchText: `${name} ${item.kind} ${item.workspaceName} ${item.name}`.toLowerCase(),
    rank: toNumber(item.storage.bytes),
  }
}

/**
 * The address-book id for an operation family.
 *
 * Shared rather than inlined because two call sites have to agree on it exactly and neither can
 * see the other: `queryEntry` below mints the id for the list, and `showFamilyOnMap` in
 * `CapacityCityView` selects by it when a route is drawn from somewhere *other* than the list --
 * the live feed, or the ranked families table. A drift in the template would not fail anything
 * loudly; the row would simply never highlight, which is the same silent divergence that made the
 * feed and the list behave differently in the first place.
 */
export function queryAddressId(familyId: string): string {
  return `query:${familyId}`
}

function queryEntry(family: OperationFamily, itemNames: ReadonlyMap<string, string>): AddressEntry {
  const stops = family.itemIds
    .map(id => itemNames.get(id))
    .filter((value): value is string => value !== undefined)
  // Ids that did not resolve are references to items that were not on the loaded page: the metrics
  // model attributes an operation to an item id the ranked page need not contain. Distinguishing
  // that from "no reference at all" is the same distinction the source draws between absent and
  // off-page evidence, and collapsing both into one phrase is what made real multi-item operations
  // read as empty.
  const unresolved = family.itemIds.length - stops.length
  let address: string
  if (stops.length > 0) {
    const visits = stops.slice(0, 3).join(', ') + (stops.length > 3 ? ` +${stops.length - 3} more` : '')
    address = unresolved > 0
      ? `Visits ${visits} (+${unresolved} outside this page)`
      : `Visits ${visits}`
  } else if (family.itemIds.length > 0) {
    address = family.itemIds.length === 1
      ? 'References one item outside this page'
      : `References ${family.itemIds.length} items outside this page`
  } else {
    address = 'References no item'
  }
  return {
    id: queryAddressId(family.familyId),
    kind: 'query',
    targetId: family.familyId,
    name: family.operationName,
    meta: `${compactCount(family.operationCount)} operations · ${compactCount(family.cuSeconds)} CU-s`,
    address,
    // Search over every reference the family named — resolved names and the raw ids of the off-page
    // ones alike, plus the operation name and family id — so an operation stays findable by an item
    // it touches whether or not that item is on the page.
    searchText: `${family.familyId} ${family.operationName} ${stops.join(' ')} ${family.itemIds.join(' ')}`.toLowerCase(),
    rank: toNumber(family.cuSeconds),
  }
}

function facilityEntry(facility: Facility, plan: CityPlan, index: number): AddressEntry {
  const site = plan.facilities.get(facility.kind)
  return {
    id: `facility:${facility.kind}`,
    kind: 'facility',
    targetId: facility.kind,
    name: facility.label,
    meta: facility.known ? facility.headline : `${facility.status} · ${facility.headline}`,
    address: site ? blockAddress(plan, site.x, site.z) : null,
    searchText: `${facility.label} ${facility.kind} ${facility.headline}`.toLowerCase(),
    // Facilities are landmarks in a fixed order, so their rank is that order, not a measurement.
    rank: -index,
  }
}

/**
 * Orders one kind's entries: measurement first, then name.
 *
 * Kept next to `buildAddressBook`, which applies it once, rather than inside the search — see the
 * note on `searchAddressBook` for why the order is established at build time.
 */
function byRankThenName(left: AddressEntry, right: AddressEntry): number {
  return right.rank - left.rank || left.name.localeCompare(right.name)
}

export function buildAddressBook(
  items: readonly CapacityCityItem[],
  families: readonly OperationFamily[],
  facilities: readonly Facility[],
  plan: CityPlan,
): AddressEntry[] {
  const itemNames = new Map(items.map(item => [item.itemId, `${item.workspaceName}.${item.name}`]))
  /*
   * Sorted here, once, rather than on every keystroke.
   *
   * The order within a group never depends on the search term, so establishing it when the book is
   * built and letting `filter` — which is stable — carry it through is exactly equivalent to sorting
   * the survivors, and it takes the comparator out of the typing path. Each kind is sorted on its
   * own because the three ranks are three different quantities: OneLake bytes, CU-seconds and a
   * fixed landmark order are not comparable with one another, and only ever get compared with their
   * own kind.
   */
  return [
    ...families.map(family => queryEntry(family, itemNames)).sort(byRankThenName),
    ...items.map(item => itemEntry(item, plan)).sort(byRankThenName),
    ...facilities.map((facility, index) => facilityEntry(facility, plan, index)).sort(byRankThenName),
  ]
}

/**
 * Filters the book by a free-text term and groups what survives.
 *
 * Matching is a simple case-insensitive substring over each entry's own haystack — every token in
 * the term must appear somewhere, so "warehouse cu" narrows rather than widens. Empty groups are
 * dropped so a search never shows a heading with nothing under it.
 *
 * The entries arrive already ordered from `buildAddressBook`, and `filter` preserves relative order,
 * so nothing is sorted here. Measured over a 4,200-item city the sort was 93% of this function's
 * cost — and this whole function was 1.4 ms of a 635 ms keystroke, so removing it is a tidiness win
 * and not a fix for anything a user can feel. What that keystroke actually costs is re-rendering
 * the 4,018 entries this returns; see `tools/measure-browser`.
 */
export function searchAddressBook(entries: readonly AddressEntry[], term: string): AddressGroup[] {
  const tokens = term.toLowerCase().split(/\s+/).filter(token => token !== '')
  const matched = tokens.length === 0
    ? entries
    : entries.filter(entry => tokens.every(token => entry.searchText.includes(token)))

  const order: AddressKind[] = ['query', 'item', 'facility']
  return order
    .map(kind => ({
      kind,
      label: GROUP_LABELS[kind],
      entries: matched.filter(entry => entry.kind === kind),
    }))
    .filter(group => group.entries.length > 0)
}
