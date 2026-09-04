import type {
  CapacityCityItem,
  CapacityCityPage,
  OperationFamily,
  CapacityCityRoute,
  CapacityCityWorkspace,
} from './capacityCityContracts'

/**
 * Folds a later bounded city page onto everything already loaded.
 *
 * A capacity's items arrive one bounded page at a time, and only some of what a page carries is a
 * statement about the whole capacity. The rest is a statement about that page, and replacing the
 * previous page wholesale — which a naive view does — silently throws those parts away:
 *
 * - `items` is per-page and is merged by `itemId`, newest wins for an item both pages carried.
 * - `routes` is per-page too. A capacity whose dependencies all sit among the first fifty items
 *   returns them on page one and returns *none* on page two, so appending a page erased every road
 *   ribbon on the map. Merged by `routeId`.
 * - `workspaces` carries the count of *that page's* items per workspace, not the capacity's. Summing
 *   is what makes the neighbourhood count the city is laid out from converge on the real one.
 * - `topOperationFamilies` is *not* capacity-wide either: a family's `itemIds` are resolved against
 *   only the current page's items, so a reference to an item on another page lands nowhere and drops
 *   out. Different pages therefore resolve different subsets of the same family, and taking the
 *   newest page wholesale left every family carrying only the last page's handful of ids. Folded by
 *   `familyId` here so a family accumulates every item any page could resolve for it.
 * - `totalItems`, `otherWorkload`, `throttle` and the window are capacity-wide and identical on
 *   every page, so the newer copy is taken as-is.
 *
 * The merge is order-independent and idempotent: folding the same page twice changes nothing, which
 * matters because a retried or duplicated request must not double a workspace's count or re-append
 * an id to a family.
 */
export function mergeCityPage(previous: CapacityCityPage, next: CapacityCityPage): CapacityCityPage {
  const items = new Map<string, CapacityCityItem>(
    previous.items.map(item => [item.itemId, item]))
  for (const item of next.items) items.set(item.itemId, item)

  const routes = new Map<string, CapacityCityRoute>(
    previous.routes.map(route => [route.routeId, route]))
  for (const route of next.routes) routes.set(route.routeId, route)

  return {
    ...next,
    workspaces: mergeWorkspaces(
      previous.workspaces,
      next.workspaces,
      items.size === previous.items.length,
    ),
    items: [...items.values()],
    routes: [...routes.values()],
    topOperationFamilies: mergeOperationFamilies(
      previous.topOperationFamilies,
      next.topOperationFamilies,
    ),
    // The token always comes from the newest page: it is the cursor's own state.
    nextPageToken: next.nextPageToken,
    totalItems: next.totalItems ?? previous.totalItems,
  }
}

/**
 * Folds each operation family's per-page item set across pages, keyed by `familyId`.
 *
 * Families keep the newest page's ranking order; a family only an earlier page carried is retained
 * and appended after, never dropped. Every other field is capacity-wide and identical on every page
 * (`cuSeconds`, `operationCount`, the counts, `recentActivity`, `evidence`), so `...next` carries
 * them through untouched — only `itemIds`, which is page-relative, is rebuilt from the union.
 */
function mergeOperationFamilies(
  previous: readonly OperationFamily[],
  next: readonly OperationFamily[],
): OperationFamily[] {
  const earlierById = new Map(previous.map(family => [family.familyId, family]))
  const seen = new Set<string>()
  const merged: OperationFamily[] = []
  for (const family of next) {
    seen.add(family.familyId)
    const earlier = earlierById.get(family.familyId)
    merged.push(earlier ? foldFamily(earlier, family) : family)
  }
  for (const family of previous) {
    if (!seen.has(family.familyId)) merged.push(family)
  }
  return merged
}

/**
 * Combines an earlier and a newer resolution of the same family.
 *
 * The union is sound because a family's totals are the same on every page; pages differ only in
 * which item references were resolvable. Sorted so the merged order does not depend on page order,
 * and deduplicated so folding a page twice is a no-op.
 */
function foldFamily(previous: OperationFamily, next: OperationFamily): OperationFamily {
  const itemIds = [...new Set([...previous.itemIds, ...next.itemIds])].sort()
  return { ...next, itemIds }
}

/**
 * Adds a page's per-workspace item counts to the running totals.
 *
 * `repeated` guards the idempotence promise: if the incoming page contributed no item that was not
 * already held, it is the same page arriving twice and its counts are already included.
 */
function mergeWorkspaces(
  previous: readonly CapacityCityWorkspace[],
  next: readonly CapacityCityWorkspace[],
  repeated: boolean,
): CapacityCityWorkspace[] {
  const merged = new Map(previous.map(workspace => [workspace.workspaceId, workspace]))
  for (const workspace of next) {
    const existing = merged.get(workspace.workspaceId)
    if (!existing) {
      merged.set(workspace.workspaceId, workspace)
      continue
    }
    if (repeated) continue
    merged.set(workspace.workspaceId, {
      ...existing,
      itemCount: sumCounts(existing.itemCount, workspace.itemCount),
    })
  }
  return [...merged.values()].sort((left, right) =>
    left.neighborhoodOrdinal - right.neighborhoodOrdinal ||
    (left.workspaceId < right.workspaceId ? -1 : left.workspaceId > right.workspaceId ? 1 : 0))
}

/**
 * Sums two per-page item counts.
 *
 * Counts arrive as decimal strings because they can exceed `Number.MAX_SAFE_INTEGER`. If either
 * side is null the workspace's count is not fully measured, so the sum is null too — a missing count
 * must not be treated as a zero that lets the other side pass through as if it were the whole.
 */
function sumCounts(left: string | null, right: string | null): string | null {
  if (left === null || right === null) return null
  if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return null
  return String(BigInt(left) + BigInt(right))
}
