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
