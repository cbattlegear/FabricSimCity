import { describe, expect, it } from 'vitest'
import { familyOnMap, placedObjectIds, splitQueryFamiliesByMap } from './operationMapping'
import { family, item } from './operationTraffic.testkit'

describe('familyOnMap', () => {
  it('is true when a family names any placed item', () => {
    const placed = new Set(['item:a', 'item:b'])
    expect(familyOnMap(family({ itemIds: ['item:a', 'item:z'] }), placed)).toBe(true)
  })

  it('is false when a family names only items off this page', () => {
    const placed = new Set(['item:a'])
    expect(familyOnMap(family({ itemIds: ['item:y', 'item:z'] }), placed)).toBe(false)
  })
})

describe('placedObjectIds', () => {
  it('collects the ids of every placed item', () => {
    const ids = placedObjectIds([item('item:a', 'ws:1', 0, 0), item('item:b', 'ws:1', 0, 1)])
    expect([...ids].sort()).toEqual(['item:a', 'item:b'])
  })
})

describe('splitQueryFamiliesByMap', () => {
  const placed = new Set(['item:a', 'item:b'])
  const families = [
    family({ familyId: 'on', itemIds: ['item:a'] }),
    family({ familyId: 'off1', itemIds: ['item:y'] }),
    family({ familyId: 'off2', itemIds: ['item:z'] }),
  ]

  it('hides unmapped families by default and states how many are hidden', () => {
    const split = splitQueryFamiliesByMap(families, placed, false)
    expect(split.shown.map(f => f.familyId)).toEqual(['on'])
    expect(split.mapped).toBe(1)
    expect(split.unmapped).toBe(2)
    expect(split.total).toBe(3)
    expect(split.toggleLabel).toContain('2 of 3')
  })

  it('keeps the counts stable when the hidden families are revealed', () => {
    const split = splitQueryFamiliesByMap(families, placed, true)
    expect(split.shown).toHaveLength(3)
    // The hidden count is still disclosed while the rows are shown, so a revealed list is never
    // mistaken for one that was never filtered.
    expect(split.unmapped).toBe(2)
    expect(split.mapped).toBe(1)
  })
})
