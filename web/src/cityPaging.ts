import type { DatabaseCityPage, DatabaseCityRoute, DatabaseCitySchema } from './databaseCityContracts'

/**
 * Folds a later bounded object page onto everything already loaded.
 *
 * Object inventory arrives one bounded page at a time, and only some of what a page carries is a
 * statement about the whole database. The rest is a statement about that page, and replacing the
 * previous page wholesale — which is what the view used to do — silently threw those parts away:
 *
 * - `objects` is obviously per-page, and was already being merged.
 * - `routes` is per-page too, and is the one that showed. A database whose co-references all sit
 *   among the first fifty objects returns them on page one and returns *none* on page two, so
 *   appending a page erased every road ribbon on the map.
 * - `schemas` carries the count of that page's objects per schema, not the database's. Summing is
 *   what makes the count the city is laid out from converge on the real one.
 * - `totalObjects`, `topQueryFamilies` and `otherWorkload` are database-wide and identical on every
 *   page, so the newer copy is taken as-is.
 *
 * The merge is order-independent and idempotent: folding the same page twice changes nothing, which
 * matters because a retried or duplicated request must not double a schema's count.
 */
export function mergeCityPage(previous: DatabaseCityPage, next: DatabaseCityPage): DatabaseCityPage {
  const objects = new Map(previous.objects.map(object => [object.objectId, object]))
  for (const object of next.objects) objects.set(object.objectId, object)

  const routes = new Map<string, DatabaseCityRoute>(
    previous.routes.map(route => [route.routeId, route]))
  for (const route of next.routes) routes.set(route.routeId, route)

  return {
    ...next,
    schemas: mergeSchemas(previous.schemas, next.schemas, objects.size === previous.objects.length),
    objects: [...objects.values()],
    routes: [...routes.values()],
    // The token always comes from the newest page: it is the cursor's own state.
    nextPageToken: next.nextPageToken,
    totalObjects: next.totalObjects ?? previous.totalObjects,
  }
}

/**
 * Adds a page's per-schema counts to the running totals.
 *
 * `repeated` guards the idempotence promise: if the incoming page contributed no object that was
 * not already held, it is the same page arriving twice and its counts are already included.
 */
function mergeSchemas(
  previous: readonly DatabaseCitySchema[],
  next: readonly DatabaseCitySchema[],
  repeated: boolean,
): DatabaseCitySchema[] {
  const merged = new Map(previous.map(schema => [schema.schemaId, schema]))
  for (const schema of next) {
    const existing = merged.get(schema.schemaId)
    if (!existing) {
      merged.set(schema.schemaId, schema)
      continue
    }
    if (repeated) continue
    merged.set(schema.schemaId, {
      ...existing,
      objectCount: String((parseCount(existing.objectCount) ?? 0) + (parseCount(schema.objectCount) ?? 0)),
    })
  }
  return [...merged.values()].sort((left, right) =>
    left.neighborhoodOrdinal - right.neighborhoodOrdinal ||
    (left.schemaId < right.schemaId ? -1 : left.schemaId > right.schemaId ? 1 : 0))
}

/** Counts arrive as decimal strings because they can exceed `Number.MAX_SAFE_INTEGER`. */
function parseCount(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
