import { describe, expect, it } from 'vitest'
import { mulberry32, seededIndex, seededShuffle } from './citySeed'
import { stableHash } from './atlasLayout'

/** Seeds are database ids in practice, hashed the same way planCity hashes them. */
const seed = (id: string) => stableHash(id)

describe('mulberry32', () => {
  it('produces the same stream for the same seed', () => {
    const left = mulberry32(seed('db:sales'))
    const right = mulberry32(seed('db:sales'))
    const a = Array.from({ length: 24 }, () => left())
    const b = Array.from({ length: 24 }, () => right())
    expect(a).toEqual(b)
  })

  it('produces a different stream for a different seed', () => {
    const a = Array.from({ length: 24 }, mulberry32(seed('db:sales')))
    const b = Array.from({ length: 24 }, mulberry32(seed('db:orders')))
    expect(a).not.toEqual(b)
  })

  it('stays inside [0, 1)', () => {
    const rng = mulberry32(seed('db:sales'))
    for (let index = 0; index < 500; index += 1) {
      const value = rng()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('does not collapse to a constant', () => {
    const rng = mulberry32(seed('db:sales'))
    const values = new Set(Array.from({ length: 200 }, () => rng()))
    expect(values.size).toBeGreaterThan(150)
  })
})

describe('seededIndex', () => {
  it('always lands inside the bound', () => {
    const rng = mulberry32(seed('db:sales'))
    for (let index = 0; index < 300; index += 1) {
      const value = seededIndex(rng, 7)
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(7)
    }
  })
})

describe('seededShuffle', () => {
  const items = Array.from({ length: 40 }, (_, index) => index)

  it('is a permutation, never a subset', () => {
    const shuffled = seededShuffle(items, mulberry32(seed('db:sales')))
    expect(shuffled).toHaveLength(items.length)
    expect([...shuffled].sort((left, right) => left - right)).toEqual(items)
  })

  it('does not mutate its input', () => {
    const before = [...items]
    seededShuffle(items, mulberry32(seed('db:sales')))
    expect(items).toEqual(before)
  })

  it('is stable for one seed and different across seeds', () => {
    expect(seededShuffle(items, mulberry32(seed('db:sales'))))
      .toEqual(seededShuffle(items, mulberry32(seed('db:sales'))))
    expect(seededShuffle(items, mulberry32(seed('db:sales'))))
      .not.toEqual(seededShuffle(items, mulberry32(seed('db:orders'))))
  })

  it('actually reorders', () => {
    const shuffled = seededShuffle(items, mulberry32(seed('db:sales')))
    const moved = shuffled.filter((value, index) => value !== items[index])
    expect(moved.length).toBeGreaterThan(items.length / 2)
  })

  it('handles empty and single-item inputs', () => {
    expect(seededShuffle([], mulberry32(seed('db:sales')))).toEqual([])
    expect(seededShuffle(['only'], mulberry32(seed('db:sales')))).toEqual(['only'])
  })
})
