import { describe, expect, it } from 'vitest'
import {
  DEGENERATE_EPSILON,
  majorDirection,
  minorDirection,
  noiseAt,
  planField,
  sampleField,
  tensorMagnitude,
} from './cityField'

const FIELD = planField({ seed: 'db:sales', centreX: 0, centreZ: 0, radius: 800 })

function samplePoints(): Array<{ x: number; z: number }> {
  const points: Array<{ x: number; z: number }> = []
  for (let x = -700; x <= 700; x += 70) {
    for (let z = -700; z <= 700; z += 70) points.push({ x, z })
  }
  return points
}

describe('planField', () => {
  it('is a pure function of the seed', () => {
    const again = planField({ seed: 'db:sales', centreX: 0, centreZ: 0, radius: 800 })
    for (const { x, z } of samplePoints()) {
      expect(sampleField(again, x, z)).toEqual(sampleField(FIELD, x, z))
    }
  })

  it('gives different seeds different fields', () => {
    const other = planField({ seed: 'db:ops', centreX: 0, centreZ: 0, radius: 800 })
    const differences = samplePoints().filter(({ x, z }) => {
      const a = sampleField(FIELD, x, z)
      const b = sampleField(other, x, z)
      return Math.abs(a.a - b.a) > 1e-6 || Math.abs(a.b - b.b) > 1e-6
    })
    expect(differences.length).toBeGreaterThan(samplePoints().length * 0.9)
  })

  it('scales the number of districts with area so district size stays constant', () => {
    const small = planField({ seed: 'db:sales', centreX: 0, centreZ: 0, radius: 400 })
    const large = planField({ seed: 'db:sales', centreX: 0, centreZ: 0, radius: 1600 })
    expect(large.elements.length).toBeGreaterThan(small.elements.length)
  })
})

describe('sampleField', () => {
  /*
   * A large field is sampled through a spatial index that skips elements too far away to register.
   * This is an optimisation only, so it has to be provably invisible: a field of one element is
   * below the indexing threshold and takes the plain path, so summing those single-element samples
   * reproduces what the indexed field must return.
   *
   * The noise warp is switched off because it rotates the blended result and so is not additive.
   */
  it('sums exactly the same contributions as an unindexed scan', () => {
    // Big enough that the index actually engages; a small city stays on the plain path.
    const planned = planField({ seed: 'db:sales', centreX: 0, centreZ: 0, radius: 2400 })
    const field = { ...planned, noiseAmplitude: 0, boundaries: [] }
    expect(field.elements.length).toBeGreaterThan(24)

    for (let x = -2200; x <= 2200; x += 220) {
      for (let z = -2200; z <= 2200; z += 220) {
        let a = 0
        let b = 0
        for (const element of field.elements) {
          const one = sampleField({ ...field, elements: [element] }, x, z)
          a += one.a
          b += one.b
        }
        const indexed = sampleField(field, x, z)
        expect(indexed.a).toBeCloseTo(a, 9)
        expect(indexed.b).toBeCloseTo(b, 9)
      }
    }
  })

  it('still answers outside the built-up area, where no element reaches', () => {
    const far = sampleField(FIELD, 90_000, -90_000)
    expect(Number.isFinite(far.a)).toBe(true)
    expect(Number.isFinite(far.b)).toBe(true)
  })
})

describe('eigenvector directions', () => {
  /*
   * The whole reason for using a tensor rather than a vector field is that the two street families
   * are perpendicular by construction. If this ever stops holding, streets stop meeting at square
   * corners and the city reads as a scribble.
   */
  it('keeps the two street families perpendicular everywhere', () => {
    for (const { x, z } of samplePoints()) {
      const tensor = sampleField(FIELD, x, z)
      if (tensorMagnitude(tensor) < DEGENERATE_EPSILON) continue
      const major = majorDirection(tensor)
      const minor = minorDirection(tensor)
      expect(Math.abs(major.x * minor.x + major.z * minor.z)).toBeLessThan(1e-9)
    }
  })

  it('returns unit directions', () => {
    for (const { x, z } of samplePoints()) {
      const tensor = sampleField(FIELD, x, z)
      if (tensorMagnitude(tensor) < DEGENERATE_EPSILON) continue
      expect(Math.hypot(majorDirection(tensor).x, majorDirection(tensor).z)).toBeCloseTo(1, 9)
    }
  })

  it('is non-degenerate almost everywhere', () => {
    const degenerate = samplePoints().filter(({ x, z }) =>
      tensorMagnitude(sampleField(FIELD, x, z)) < DEGENERATE_EPSILON)
    expect(degenerate.length / samplePoints().length).toBeLessThan(0.02)
  })
})

describe('noiseAt', () => {
  it('stays within its stated range', () => {
    for (const { x, z } of samplePoints()) {
      const value = noiseAt(1234, 200, x, z)
      expect(value).toBeGreaterThanOrEqual(-1)
      expect(value).toBeLessThanOrEqual(1)
    }
  })

  /*
   * A streamline integrates through this noise, so a discontinuity in it becomes a kink in a road.
   * Sampling either side of a lattice boundary is where a badly interpolated value noise shows.
   */
  it('is continuous across cell boundaries', () => {
    for (let step = -3; step <= 3; step += 1) {
      const at = step * 200
      const before = noiseAt(99, 200, at - 0.001, 37)
      const after = noiseAt(99, 200, at + 0.001, 37)
      expect(Math.abs(after - before)).toBeLessThan(1e-3)
    }
  })
})
