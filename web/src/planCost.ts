import type { NormalizedShowplan, ShowplanNode, ShowplanObjectReference } from './contracts'

/**
 * Divides a compiled plan's *estimated* cost between the objects it reads.
 *
 * This mirrors `PlanCostAttribution` in the collector, deliberately and for a reason worth stating.
 * The collector runs the split over every ranked family so a page can carry attributed waits without
 * shipping plan XML — plan XML is a guarded, one-at-a-time payload and must never be fetched in bulk.
 * This copy runs over the single plan an operator asked to see. Both must produce the same shares, or
 * selecting a plan would contradict the map it was selected from, so the two are kept to the same
 * three rules:
 *
 * 1. An operator's own cost is `estimatedCpuCost + estimatedIoCost`. It is **not**
 *    `estimatedTotalSubtreeCost`, which is cumulative: summing that across operators counts every
 *    child again at each ancestor, so a deep plan would claim many times its own cost. The subtree
 *    figure is used only as a fallback, as a parent-minus-children delta, for a plan carrying no
 *    per-operator estimate at all.
 * 2. Cost on an operator naming no object is pushed **down** onto the objects in its subtree, in
 *    proportion to what they already cost. A hash join is expensive because of the rows its inputs
 *    produced, so its cost belongs to the tables that produced them.
 * 3. Cost over a subtree containing no object stays unattributed rather than being spread onto
 *    whatever else was handy.
 *
 * None of this is a measurement. It is the optimizer's own arithmetic about work it expected to do,
 * and everything drawn from it is obliged to say so.
 */

/** Strips showplan bracket quoting: `[dbo]` -> `dbo`. */
export function unquote(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
}

/** Canonical identity for an object reference, so two spellings of one table merge. */
export function referenceKey(reference: ShowplanObjectReference): string {
  const parts = [reference.database, reference.schema, reference.table, reference.index]
  return parts.map(part => (unquote(part) ?? '').toLowerCase()).join('.')
}

export interface PlanObjectCost {
  readonly reference: ShowplanObjectReference
  readonly cost: number
}

export interface PlanCostSplit {
  /** Per object reference, keyed by {@link referenceKey}, in a stable order. */
  readonly objects: readonly PlanObjectCost[]
  /** Cost that reached no object at all: compute over constants, or a plan naming nothing. */
  readonly unattributed: number
  readonly total: number
}

export const EMPTY_PLAN_COST: PlanCostSplit = { objects: [], unattributed: 0, total: 0 }

interface Subtree {
  readonly byKey: Map<string, { reference: ShowplanObjectReference; cost: number }>
  unattributed: number
}

function sum(subtree: Subtree): number {
  let total = subtree.unattributed
  for (const entry of subtree.byKey.values()) total += entry.cost
  return total
}

function absorb(into: Subtree, from: Subtree): void {
  for (const [key, entry] of from.byKey) {
    const existing = into.byKey.get(key)
    if (existing) existing.cost += entry.cost
    else into.byKey.set(key, { reference: entry.reference, cost: entry.cost })
  }
  into.unattributed += from.unattributed
}

/**
 * Per-operator cost, preferring `estimatedCpuCost + estimatedIoCost`. When a plan carries neither on
 * any operator, falls back to each operator's subtree cost minus its children's, which reconstructs
 * the same per-operator figure from the cumulative one.
 */
function ownCosts(
  nodes: readonly ShowplanNode[],
  children: ReadonlyMap<number, number[]>,
  byId: ReadonlyMap<number, ShowplanNode>,
): Map<number, number> {
  const direct = new Map<number, number>()
  let sawDirect = false
  for (const node of nodes) {
    const own = (node.estimatedCpuCost ?? 0) + (node.estimatedIoCost ?? 0)
    if (own > 0) sawDirect = true
    direct.set(node.nodeId, own > 0 ? own : 0)
  }
  if (sawDirect) return direct

  const delta = new Map<number, number>()
  for (const node of nodes) {
    let below = 0
    for (const childId of children.get(node.nodeId) ?? []) {
      below += byId.get(childId)?.estimatedTotalSubtreeCost ?? 0
    }
    const own = (node.estimatedTotalSubtreeCost ?? 0) - below
    delta.set(node.nodeId, own > 0 ? own : 0)
  }
  return delta
}

export function planCostSplit(showplan: NormalizedShowplan): PlanCostSplit {
  const nodes = showplan.nodes
  if (nodes.length === 0) return EMPTY_PLAN_COST

  const byId = new Map<number, ShowplanNode>()
  for (const node of nodes) byId.set(node.nodeId, node)

  const children = new Map<number, number[]>()
  const roots: number[] = []
  for (const node of nodes) {
    const parent = node.parentNodeId
    if (parent === null || parent === node.nodeId || !byId.has(parent)) {
      roots.push(node.nodeId)
      continue
    }
    const bucket = children.get(parent)
    if (bucket) bucket.push(node.nodeId)
    else children.set(parent, [node.nodeId])
  }
  for (const bucket of children.values()) bucket.sort((a, b) => a - b)
  roots.sort((a, b) => a - b)

  const costs = ownCosts(nodes, children, byId)

  // Children before parents, matching the direction rows flow. Operators stranded in a parent-link
  // cycle become their own tops rather than being dropped, so a malformed plan loses no cost.
  const order: number[] = []
  const tops: number[] = []
  const seen = new Set<number>()
  for (const start of [...roots, ...nodes.map(node => node.nodeId)]) {
    if (seen.has(start)) continue
    seen.add(start)
    tops.push(start)
    const stack: Array<{ id: number; expanded: boolean }> = [{ id: start, expanded: false }]
    while (stack.length > 0) {
      const frame = stack.pop()!
      if (frame.expanded) {
        order.push(frame.id)
        continue
      }
      stack.push({ id: frame.id, expanded: true })
      const bucket = children.get(frame.id)
      if (!bucket) continue
      for (let index = bucket.length - 1; index >= 0; index -= 1) {
        const child = bucket[index]
        if (seen.has(child)) continue
        seen.add(child)
        stack.push({ id: child, expanded: false })
      }
    }
  }

  const folded = new Map<number, Subtree>()
  for (const id of order) {
    const node = byId.get(id)
    if (!node) continue
    const subtree: Subtree = { byKey: new Map(), unattributed: 0 }
    for (const childId of children.get(id) ?? []) {
      const child = folded.get(childId)
      if (child) absorb(subtree, child)
    }

    const own = costs.get(id) ?? 0
    if (node.objectReference !== null) {
      const key = referenceKey(node.objectReference)
      const existing = subtree.byKey.get(key)
      if (existing) existing.cost += own
      else subtree.byKey.set(key, { reference: node.objectReference, cost: own })
    } else if (own > 0) {
      const basis = sum(subtree)
      if (basis > 0) {
        // The unattributed pool takes its share too, so cost over a half-attributed subtree does not
        // silently become fully attributed on the way up.
        for (const entry of subtree.byKey.values()) entry.cost += (own * entry.cost) / basis
        subtree.unattributed += (own * subtree.unattributed) / basis
      } else if (subtree.byKey.size > 0) {
        // Free reads below an expensive operator: the objects are real but cost nothing on their own,
        // so the operator's cost divides evenly rather than vanishing into unattributed.
        const each = own / subtree.byKey.size
        for (const entry of subtree.byKey.values()) entry.cost += each
      } else {
        subtree.unattributed += own
      }
    }

    folded.set(id, subtree)
  }

  const total: Subtree = { byKey: new Map(), unattributed: 0 }
  for (const top of tops) {
    const subtree = folded.get(top)
    if (subtree) absorb(total, subtree)
  }

  const totalCost = sum(total)
  if (totalCost <= 0) return EMPTY_PLAN_COST

  // Map iteration order is insertion order, which depends on plan shape. The published order is fixed
  // here so a city redrawn from the same plan reads the same way.
  const objects = [...total.byKey.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, entry]) => ({ reference: entry.reference, cost: entry.cost }))

  return { objects, unattributed: total.unattributed, total: totalCost }
}
