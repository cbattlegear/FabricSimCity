import { useRef } from 'react'
import type { DatabaseCityObject, DatabaseCitySchema } from './databaseCityContracts'

/**
 * How often an open city re-reads its database.
 *
 * A city whose traffic is graded from the last quarter of an hour has to be re-read considerably
 * more often than that, or the colours are a window's worth of stale and the "live" claim is false.
 * Thirty seconds is well inside the window and well outside the cost of a walk.
 *
 * Polling stops while the document is hidden. A background tab that keeps re-probing SQL Server
 * forever is indistinguishable from this one in a screenshot and shows up only as an instance that
 * never goes idle.
 */
export const CITY_REFRESH_INTERVAL_MS = 30_000

/**
 * The object fields the city *layout* is derived from.
 *
 * Everything else on an object -- `directActivity`, `attributedExposure`, sizes' evidence prose --
 * changes on almost every refresh, and none of it moves a building. Separating the two is what lets
 * a refresh repaint the traffic without re-planning the city.
 *
 * This has to name the same fields `cityPlan` actually reads. Adding a read there without adding it
 * here fails silently and in the worst possible direction: the plan is *not* recomputed when it
 * should be, so a building keeps a footprint its table no longer has.
 */
export function cityLayoutSignature(objects: readonly DatabaseCityObject[]): string {
  return objects
    .map(object => [
      object.objectId,
      object.schemaId,
      object.schemaName,
      object.kind,
      object.reservedPages8KiB ?? '',
      object.usedPages8KiB ?? '',
      object.layout.neighborhoodOrdinal,
      object.layout.objectOrdinal,
    ].join('\u0000'))
    .join('\u0001')
}

/**
 * The schema fields `planCity` is given as options. `evidence` is deliberately excluded: its
 * `observedAt` moves every single refresh and never changes where a neighbourhood goes.
 */
export function citySchemaSignature(schemas: readonly DatabaseCitySchema[] | undefined): string {
  if (!schemas) return ''
  return schemas
    .map(schema => [schema.schemaId, schema.name, schema.neighborhoodOrdinal, schema.objectCount].join('\u0000'))
    .join('\u0001')
}

/**
 * Returns `previous` whenever the two carry the same content, so a consumer keyed on identity does
 * not re-run.
 *
 * The point is `planCity`, measured in AGENTS.md at 16,150ms over counts 80..140. A poll that hands
 * the memo a fresh array every thirty seconds re-plans the whole city each time -- and because a
 * re-plan re-ranks each schema's buildings by footprint, the city visibly reshuffles while someone
 * is looking at it. Content-stability is what makes a live city cheap *and* still.
 */
export function stableByContent<T>(previous: T, next: T, signature: (value: T) => string): T {
  return signature(previous) === signature(next) ? previous : next
}

/** `stableByContent` across renders. The signature is recomputed each render and is cheap; the plan is not. */
export function useContentStable<T>(value: T, signature: (value: T) => string): T {
  const held = useRef<{ signature: string; value: T } | null>(null)
  const current = signature(value)
  if (held.current === null || held.current.signature !== current) held.current = { signature: current, value }
  return held.current.value
}
