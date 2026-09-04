import { describe, expect, it } from 'vitest'
import { CITY_LOADING_SAYINGS, loadingProgress, sayingReel } from './cityLoadingSayings'

/** A seeded generator, so a shuffle can be replayed exactly rather than tested by hope. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

describe('the sayings themselves', () => {
  it('are all distinct', () => {
    expect(new Set(CITY_LOADING_SAYINGS).size).toBe(CITY_LOADING_SAYINGS.length)
  })

  it('are worth waiting for', () => {
    expect(CITY_LOADING_SAYINGS.length).toBeGreaterThan(40)
  })

  it('carry no trailing punctuation, because the screen adds the ellipsis', () => {
    for (const saying of CITY_LOADING_SAYINGS) {
      expect(saying.trim()).toBe(saying)
      expect(saying).not.toMatch(/[.…]$/)
    }
  })

  /*
   * The one line kept from SimCity, and the reason a loading screen in a city builder is funny at
   * all. Everything else here is written for this app; this one is the homage.
   */
  it('reticulate splines', () => {
    expect(CITY_LOADING_SAYINGS).toContain('Reticulating splines')
  })
})

describe('dealing sayings', () => {
  it('shows every saying once before showing any of them twice', () => {
    const sayings = ['one', 'two', 'three', 'four', 'five']
    const next = sayingReel(sayings, seeded(7))
    const drawn = Array.from({ length: sayings.length * 40 }, next)

    for (let at = 0; at < drawn.length; at += sayings.length) {
      const deck = drawn.slice(at, at + sayings.length)
      expect([...deck].sort()).toEqual([...sayings].sort())
    }
  })

  /*
   * The reason a deck is dealt rather than a saying picked each time. Independent draws repeat back
   * to back about once in every `n` changes, and on a screen whose only moving part is this line, a
   * repeat reads as the app having hung.
   */
  it('never shows the same saying twice in a row, including across a reshuffle', () => {
    const sayings = ['one', 'two', 'three', 'four', 'five']
    const next = sayingReel(sayings, seeded(3))
    let previous = next()
    for (let draw = 0; draw < 2000; draw += 1) {
      const saying = next()
      expect(saying).not.toBe(previous)
      previous = saying
    }
  })

  it('leaves the source list in its original order', () => {
    const sayings = ['one', 'two', 'three', 'four', 'five']
    const original = [...sayings]
    const next = sayingReel(sayings, seeded(11))
    for (let draw = 0; draw < 20; draw += 1) next()
    expect(sayings).toEqual(original)
  })

  /* `Math.random` never returns exactly 1, but an injected generator may, and an unclamped index
   * would swap past the end of the deck and quietly drop a saying. */
  it('loses no saying to a generator that returns one', () => {
    const sayings = ['one', 'two', 'three', 'four', 'five']
    const next = sayingReel(sayings, () => 1)
    const deck = Array.from({ length: sayings.length }, next)
    expect([...deck].sort()).toEqual([...sayings].sort())
  })

  it('says nothing rather than throwing when there is nothing to say', () => {
    const next = sayingReel([], seeded(1))
    expect(next()).toBe('')
    expect(next()).toBe('')
  })

  it('repeats a lone saying rather than stalling', () => {
    const next = sayingReel(['only'], seeded(1))
    expect([next(), next(), next()]).toEqual(['only', 'only', 'only'])
  })
})

describe('measuring progress', () => {
  it('reports a fraction of the objects surveyed', () => {
    expect(loadingProgress(25, 100)).toBe(0.25)
    expect(loadingProgress(100, 100)).toBe(1)
  })

  /*
   * The distinction the loading bar is built on: before the first page lands nobody knows the total,
   * and a bar resting at zero would state a measurement that has not been taken. `null` means "draw
   * an indeterminate bar", which is the honest shape for an unknown.
   */
  it('knows nothing rather than reporting zero when the total is unknown', () => {
    expect(loadingProgress(0, null)).toBeNull()
    expect(loadingProgress(null, 100)).toBeNull()
    expect(loadingProgress(12, 0)).toBeNull()
    expect(loadingProgress(12, Number.NaN)).toBeNull()
    expect(loadingProgress(Number.POSITIVE_INFINITY, 100)).toBeNull()
  })

  it('never overfills or underfills the bar', () => {
    expect(loadingProgress(140, 100)).toBe(1)
    expect(loadingProgress(-4, 100)).toBe(0)
  })
})
