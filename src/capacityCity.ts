import type {
  CapacityCityItem,
  CapacityCityMetric,
  CapacityCityRoute,
} from './capacityCityContracts'
import { canHoldStorage } from './itemKind'
import {
  cuToHeight,
  formatBytes,
  formatCu,
  formatDecimalCount,
  formatMinutes,
  parseExactBytes,
  parseExactCu,
  splitPascal,
} from './capacityAtlas'

/*
 * City geometry — one item, one building.
 *
 * The atlas settled the plot/height pair one level up: a capacity's plot comes from the CU budget
 * it was provisioned with, its skyline from the CU it actually consumed. The city makes the same
 * decision one level down, but the ground is a different measurement. An item does not have a
 * provisioned budget; what it has is OneLake storage. So a building's footprint is its bytes and
 * its height is the CU-seconds charged to it, and `cuToHeight` is imported from the atlas verbatim
 * so the two levels raise a skyline on exactly the same scale.
 *
 * Every mapping is strictly monotonic in its measured value and uncapped, so two buildings never
 * read as the same size unless their measurements really are equal.
 *
 * And the rule the whole visualization rests on holds here too: a measurement that is *missing*
 * renders as wireframe, never as zero. The one subtlety the city adds is that a null footprint is
 * not always missing — a Notebook holds no OneLake bytes by nature, and that is a complete
 * measurement of an item that stores nothing, not a gap. `canHoldStorage` is what tells the two
 * apart, so a compute-only kind sits on a minimum lot while a Lakehouse with no reported bytes
 * draws as a fenced, wireframe parcel.
 */

/** Smallest footprint a building stands on, for an item that stores nothing measurable. */
export const MIN_FOOTPRINT = 8

/** World units of footprint added per doubling of OneLake bytes. */
export const FOOTPRINT_UNITS_PER_DOUBLING = 1.4

/**
 * The lot a building of unmeasured footprint is fenced on.
 *
 * A default, not a measurement: it is only ever used for the wireframe parcel of an item whose
 * storage evidence is missing, and it must not vary with anything, or an absent size would leak a
 * size back in through the fence.
 */
export const VACANT_FOOTPRINT = 11

/** Height of the fence drawn where a building's height cannot be claimed. */
export const VACANT_HEIGHT = 2.2

/**
 * Footprint side, in world units, from an item's OneLake bytes.
 *
 * Logarithmic for the same reason the atlas plot is: OneLake item sizes span many orders of
 * magnitude, and a linear footprint would make every small item an invisible speck beside one
 * lakehouse. Zero bytes is `MIN_FOOTPRINT` — a real, minimum lot for an item measured to hold
 * nothing, which is not the same as an item whose size was never measured.
 */
export function bytesToFootprint(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError('Bytes must be a finite, non-negative number')
  }
  return MIN_FOOTPRINT + Math.log2(1 + bytes) * FOOTPRINT_UNITS_PER_DOUBLING
}

export { cuToHeight }

/**
 * A building's footprint, or null when its storage is missing rather than absent.
 *
 * `null` is reserved for the honest gap: a storage-bearing kind that reported no bytes. A
 * compute-only kind reporting no bytes is a measurement, not a gap, and returns `MIN_FOOTPRINT`.
 */
export function itemFootprint(item: CapacityCityItem): number | null {
  const exact = parseExactBytes(item.storage)
  if (exact !== null) {
    const value = Number(exact)
    return bytesToFootprint(Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER)
  }
  // No bytes reported. For a kind that cannot hold OneLake storage at all, that is a complete
  // measurement — a minimum lot. For a kind that can, it is missing evidence — null, so the
  // building draws as wireframe rather than at a guessed size.
  return canHoldStorage(item.kind) ? null : MIN_FOOTPRINT
}

/**
 * A building's height, or null when consumption is unknown.
 *
 * Known-zero CU is a height of zero — a paved, empty lot for an item that consumed nothing over
 * the window. Unknown CU is null, and no height is claimed at all.
 */
export function itemHeight(item: CapacityCityItem): number | null {
  const exact = parseExactCu(item.cuConsumed)
  if (exact === null) return null
  const value = Number(exact)
  return cuToHeight(Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER)
}

export interface ItemMassing {
  footprint: number
  height: number
  kind: 'built' | 'vacant'
}

/**
 * The massing a building is drawn with, resolving the footprint/height pair into geometry.
 *
 * A building is `built` only when *both* its footprint and its height are measured. If either is
 * missing it is `vacant`: a fenced parcel that claims neither a size nor a skyline, because drawing
 * a solid building at a guessed height (or on a guessed lot) would assert a measurement that was
 * never taken. This mirrors the atlas, where a null tower height turns a lot vacant.
 */
export function itemMassing(item: CapacityCityItem): ItemMassing {
  const footprint = itemFootprint(item)
  const height = itemHeight(item)
  if (footprint === null || height === null) {
    return { footprint: footprint ?? VACANT_FOOTPRINT, height: VACANT_HEIGHT, kind: 'vacant' }
  }
  return { footprint, height, kind: 'built' }
}

/**
 * The raw decimal value a building is ranked and sized by for the current metric, or null.
 *
 * Kept as the source string rather than a number: CU-seconds and byte totals routinely exceed what
 * a double survives, and the ordering the city is laid out from must be exact. Null is a real
 * answer and stays null — it must never collapse to a zero that would sort an unmeasured item
 * against measured ones.
 */
export function cityItemMetricValue(
  item: CapacityCityItem,
  metric: CapacityCityMetric,
): string | null {
  switch (metric) {
    case 'Cu':
      return item.cuConsumed.cuSeconds
    case 'Storage':
      return item.storage.bytes
    case 'Duration':
      return item.durationSeconds === null ? null : String(item.durationSeconds)
    case 'Operations':
      return item.operations.total
  }
}

/**
 * How to describe a building's footprint in a screen-reader label.
 *
 * Three outcomes, deliberately distinct: a measured size, a true "stores nothing" for a
 * compute-only kind, and a "storage unavailable" for a storage kind whose bytes are missing. The
 * last two are the paused-vs-idle distinction at the item level and must not read the same.
 */
export function storageSummary(item: CapacityCityItem): string {
  if (parseExactBytes(item.storage) !== null) return `${formatBytes(item.storage)} OneLake storage`
  return canHoldStorage(item.kind) ? 'OneLake storage unavailable' : 'no OneLake storage'
}

/** A spoken description of a building, from measured evidence only. */
export function accessibleItemLabel(item: CapacityCityItem): string {
  const parts = [
    `${item.workspaceName} / ${item.name}, ${splitPascal(item.kind)}`,
    storageSummary(item),
    `CU ${formatCu(item.cuConsumed)}`,
  ]
  if (item.operations.total !== null) {
    parts.push(`${formatDecimalCount(item.operations.total)} operations`)
  }
  if (item.operations.rejected !== null && item.operations.rejected !== '0') {
    parts.push(`${formatDecimalCount(item.operations.rejected)} rejected`)
  }
  if (item.throttlingMinutes !== null && item.throttlingMinutes > 0) {
    parts.push(`throttled ${formatMinutes(item.throttlingMinutes)}`)
  }
  return `${parts.join('. ')}.`
}

/**
 * Whether a route should be drawn, given the set of buildings currently on screen.
 *
 * Both endpoints must be visible. A route with one end on an item that a filter hid or a later page
 * has not loaded is not drawn to a guessed position — inventing the far end would draw a dependency
 * to a building that is not there. This is the same rule the SQL build held: a road needs two real
 * ends, or it is not a road.
 */
export function shouldRenderRoute(
  route: CapacityCityRoute,
  visibleItemIds: ReadonlySet<string>,
): boolean {
  return visibleItemIds.has(route.fromItemId) && visibleItemIds.has(route.toItemId)
}
