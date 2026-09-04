import { describe, expect, it } from 'vitest'
import { GROWTH_SIZES, PLAN_TIMEOUT_MS, itemIdFor, planOf } from './cityGrowth.testkit'

/*
 * The ground half of the growth guarantee: the added item gets a lot, and no two buildings end up
 * standing on the same block. See `cityGrowth.testkit.ts` for the fixtures and for why this family
 * is split across files.
 */

describe('adding an item to the capacity', () => {
  it.each(GROWTH_SIZES)('gives the new item a building of its own, at %i items', count => {
    const before = planOf(count)
    const after = planOf(count + 1)
    const added = itemIdFor(count)
    expect(before.lots.has(added)).toBe(false)
    expect(after.lots.has(added)).toBe(true)
    expect(after.lots.size).toBe(before.lots.size + 1)
  }, PLAN_TIMEOUT_MS)

  it.each(GROWTH_SIZES)('stands every building on ground of its own, at %i items', count => {
    const plan = planOf(count + 1)
    const blocks = new Set([...plan.lots.values()].map(lot => lot.blockId))
    expect(blocks.size).toBe(plan.lots.size)
  }, PLAN_TIMEOUT_MS)

  it('does not stand the new building on ground another building already holds', () => {
    const before = planOf(120)
    const after = planOf(121)
    const taken = new Set([...before.lots.values()].map(lot => lot.blockId))
    const added = after.lots.get(itemIdFor(120))!
    expect(taken.has(added.blockId)).toBe(false)
  })
})
