import { describe, expect, it } from 'vitest'
import { planCity } from './cityPlan'
import { cityOf, movedBuildings } from './cityGrowth.testkit'

/**
 * What item-id shape does to placement stability.
 *
 * The growth specs defend one property above all others: a capacity that gains an item does not
 * rearrange the city around it. Buildings that were already standing keep their block, so the place
 * you learned yesterday is still there today.
 *
 * That property is **not** free. It holds only because placement hands out ground in item-id order
 * and a newly created item sorts *after* every item already there. In SQLSimCity that was true by
 * construction: `object_id` is issued monotonically, so a new table always sorted last.
 *
 * **Fabric item ids are GUIDs, and a GUID does not encode creation order.** A new item is as likely
 * to sort into the middle of a workspace as onto the end, and everything after it shifts one block
 * along. So the guarantee the growth specs prove is a guarantee about *the fixtures' id shape*, not
 * about Fabric.
 *
 * The growth testkit mints ids as `item/3`, `item/4`, … precisely so it can exercise the numeric
 * comparison in `compareItemIdOrder`. That makes every growth spec pass while the real deployment
 * shuffles — a guard advertising protection it does not provide, which is the failure mode this
 * repo's conventions call out by name.
 *
 * This file exists so that limitation is **measured and visible** rather than implied by a comment.
 * It is deliberately written to pass against today's behaviour: it pins the shape of the problem,
 * not a wish. If placement is ever made insertion-stable for unordered ids — by keying blocks on a
 * per-item hash instead of on dense sort position, or by persisting a first-seen ordinal in app
 * state — the GUID assertion here will start failing, and that failure is the signal the fix landed
 * and this file should be rewritten to demand the stronger property.
 */

/**
 * Deterministic pseudo-GUID ids, in the shape Fabric actually issues.
 *
 * Seeded xorshift rather than `Math.random`, so a failure here is reproducible and this test can
 * never flake. The point is only that the ids carry no creation order, which any fixed scramble
 * demonstrates as well as a real GUID does.
 */
function withUnorderedIds(count: number): ReturnType<typeof cityOf> {
  const { items, options } = cityOf(count)
  let state = 0x2545f491
  const chunk = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0).toString(16).padStart(8, '0')
  }
  return {
    items: items.map(item => ({
      ...item,
      itemId: `capacity:growth/item/${chunk()}-${chunk()}-${chunk()}-${chunk()}`,
    })),
    options,
  }
}

function planWith(city: ReturnType<typeof cityOf>) {
  return planCity(city.items, city.options)
}

/**
 * Small on purpose. `planCity` is the expensive part of the growth family -- 16s across counts
 * 80..140 -- and nothing here needs a large city to show the effect, so this file stays cheap
 * enough to sit beside the growth specs without becoming the suite's critical path.
 */
const COUNT = 40

describe('placement stability under item-id shape', () => {
  it('keeps every building on its block when ids are issued in creation order', () => {
    const moved = movedBuildings(planWith(cityOf(COUNT)), planWith(cityOf(COUNT + 1)))
    expect(moved).toEqual([])
  })

  /**
   * The measured failure, pinned. 4 of 40 buildings move today. The assertion is deliberately
   * "some building moves" rather than "exactly 4", so it survives an unrelated change to block
   * sizing while still going red the moment placement becomes insertion-stable.
   */
  it('lets a new item displace existing buildings when ids carry no creation order', () => {
    const before = planWith(withUnorderedIds(COUNT))
    const after = planWith(withUnorderedIds(COUNT + 1))

    const shared = [...before.lots.keys()].filter(id => after.lots.has(id))
    expect(shared.length).toBeGreaterThan(COUNT / 2)

    expect(movedBuildings(before, after).length).toBeGreaterThan(0)
  })

  /**
   * Whatever the id shape, placement must stay a pure function of its inputs -- the architectural
   * rule that a city looks the same on every load, in every browser, on every machine. Unordered
   * ids cost stability *across a change*, and must not also cost determinism.
   */
  it('stays deterministic for unordered ids', () => {
    const first = planWith(withUnorderedIds(COUNT))
    const second = planWith(withUnorderedIds(COUNT))
    expect(movedBuildings(first, second)).toEqual([])
    expect([...first.lots.keys()]).toEqual([...second.lots.keys()])
  })
})
