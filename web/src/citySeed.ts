/**
 * Deterministic pseudo-randomness for city layout.
 *
 * "Randomly placed" and "stable" have to hold at the same time: a city should look like a city
 * rather than a spreadsheet, but a table must be on the same lot every time anyone opens the same
 * database, on any machine, in any browser, forever. So nothing here touches `Math.random()`.
 * Every draw comes from a small integer generator seeded from the database's own id, which makes
 * the scatter a pure function of identity.
 */

/**
 * mulberry32: a 32-bit generator with a full 2^32 period and good distribution for this use.
 *
 * Chosen over `Math.random()` because it is seedable, and over a hash-per-lookup because a stream
 * lets the placement walk the grid once. It is not cryptographic and is never used for anything
 * that needs to be unguessable.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let drawn = state
    drawn = Math.imul(drawn ^ (drawn >>> 15), drawn | 1)
    drawn ^= drawn + Math.imul(drawn ^ (drawn >>> 7), drawn | 61)
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4294967296
  }
}

/** Uniform integer in `[0, bound)`. Returns 0 for a non-positive bound rather than NaN. */
export function seededIndex(rng: () => number, bound: number): number {
  if (bound <= 0) return 0
  return Math.min(bound - 1, Math.floor(rng() * bound))
}

/**
 * Fisher-Yates shuffle driven by the supplied generator.
 *
 * Returns a new array; the input is never mutated, so a caller can shuffle a frozen list of blocks
 * without the plan quietly depending on call order elsewhere.
 */
export function seededShuffle<T>(items: readonly T[], rng: () => number): T[] {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = seededIndex(rng, index + 1)
    const held = result[index]
    result[index] = result[swap]
    result[swap] = held
  }
  return result
}
