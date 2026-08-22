import { describe, expect, it } from 'vitest'
import { planField } from './cityField'
import { ProximityIndex, traceStreamlines, type Point, type Streamline } from './cityStreamlines'

const RADIUS = 700
const SEPARATION = 62
const BOUNDS = {
  minX: -RADIUS * 1.1,
  maxX: RADIUS * 1.1,
  minZ: -RADIUS * 1.1,
  maxZ: RADIUS * 1.1,
}

function trace(seed: string, excluded?: (x: number, z: number) => boolean): Streamline[] {
  return traceStreamlines({
    field: planField({ seed, centreX: 0, centreZ: 0, radius: RADIUS }),
    ...BOUNDS,
    separation: SEPARATION,
    edgeSeparationScale: 2.3,
    minLength: 90,
    maxStreamlines: 700,
    excluded,
  })
}

const LINES = trace('db:sales')

function nearest(point: Point, lines: readonly Streamline[], exclude: string): number {
  let best = Infinity
  for (const line of lines) {
    if (line.id === exclude) continue
    for (const other of line.points) {
      best = Math.min(best, Math.hypot(other.x - point.x, other.z - point.z))
    }
  }
  return best
}

describe('traceStreamlines', () => {
  it('traces both street families', () => {
    expect(LINES.some(line => line.family === 'major')).toBe(true)
    expect(LINES.some(line => line.family === 'minor')).toBe(true)
  })

  it('is a pure function of the seed', () => {
    const again = trace('db:sales')
    expect(again.length).toBe(LINES.length)
    again.forEach((line, index) => {
      expect(line.id).toBe(LINES[index].id)
      expect(line.points).toEqual(LINES[index].points)
    })
  })

  it('gives different seeds different streets', () => {
    const other = trace('db:ops')
    expect(other.map(line => line.points)).not.toEqual(LINES.map(line => line.points))
  })

  it('stays inside the plan', () => {
    for (const line of LINES) {
      for (const point of line.points) {
        expect(point.x).toBeGreaterThanOrEqual(BOUNDS.minX - 1)
        expect(point.x).toBeLessThanOrEqual(BOUNDS.maxX + 1)
        expect(point.z).toBeGreaterThanOrEqual(BOUNDS.minZ - 1)
        expect(point.z).toBeLessThanOrEqual(BOUNDS.maxZ + 1)
      }
    }
  })

  it('drops stubs that would bound nothing', () => {
    for (const line of LINES) expect(line.length).toBeGreaterThanOrEqual(90)
  })

  /*
   * Separation is enforced only within a family: cross streets have to be allowed arbitrarily close
   * to the streets they cross, and are kept apart only from their own kind. Tested at midpoints
   * because a street is deliberately allowed to run right up to a neighbour it is terminating on.
   */
  it('keeps streets of one family apart from each other', () => {
    for (const family of ['major', 'minor'] as const) {
      const family_ = LINES.filter(line => line.family === family)
      let crowded = 0
      let tested = 0
      for (const line of family_) {
        const middle = line.points[Math.floor(line.points.length / 2)]
        tested += 1
        if (nearest(middle, family_, line.id) < SEPARATION * 0.45) crowded += 1
      }
      expect(crowded / tested).toBeLessThan(0.06)
    }
  })

  /*
   * Seed propagation alone cannot cover a radial field, because spokes diverge and no seed dropped
   * beside one ever lands in the widening gap between two of them. The first attempt left blank
   * wedges at the edge of the map, so coverage is asserted rather than assumed.
   */
  it('leaves no large gap in the built-up area', () => {
    let uncovered = 0
    let sampled = 0
    for (let x = -RADIUS * 0.85; x <= RADIUS * 0.85; x += 40) {
      for (let z = -RADIUS * 0.85; z <= RADIUS * 0.85; z += 40) {
        sampled += 1
        if (nearest({ x, z }, LINES, '') > SEPARATION * 2.4) uncovered += 1
      }
    }
    expect(uncovered / sampled).toBeLessThan(0.03)
  })

  it('keeps streets out of excluded ground', () => {
    const inLake = (x: number, z: number): boolean => Math.hypot(x - 200, z + 150) < 160
    const lines = trace('db:sales', inLake)
    let inside = 0
    for (const line of lines) {
      for (const point of line.points) if (inLake(point.x, point.z)) inside += 1
    }
    expect(inside).toBe(0)
  })

  it('reports centrality as a position on the map, in range', () => {
    for (const line of LINES) {
      expect(line.centrality).toBeGreaterThanOrEqual(0)
      expect(line.centrality).toBeLessThanOrEqual(1)
    }
  })

  it('gives every street a unique id', () => {
    expect(new Set(LINES.map(line => line.id)).size).toBe(LINES.length)
  })

  it('never emits a degenerate street', () => {
    for (const line of LINES) {
      expect(line.points.length).toBeGreaterThanOrEqual(2)
      for (let index = 1; index < line.points.length; index += 1) {
        const step = Math.hypot(
          line.points[index].x - line.points[index - 1].x,
          line.points[index].z - line.points[index - 1].z,
        )
        expect(step).toBeGreaterThan(0)
      }
    }
  })
})


describe('ProximityIndex', () => {
  /*
   * The gap sweep whittles one candidate list down over its passes instead of rescanning the map,
   * and that is only sound because coverage never retreats: a point once within reach of a street
   * stays within reach of it, however many streets are added afterwards. If `hasWithin` could ever
   * go back to false, later passes would miss ground the earlier ones had already dismissed and the
   * outskirts would quietly lose their streets.
   */
  it('never takes back a point it has already covered', () => {
    const index = new ProximityIndex(40)
    const queries: Point[] = []
    for (let i = 0; i < 60; i += 1) {
      queries.push({ x: ((i * 137) % 400) - 200, z: ((i * 89) % 400) - 200 })
    }
    const covered = new Set<number>()
    for (let step = 0; step < 40; step += 1) {
      index.add(((step * 211) % 400) - 200, ((step * 53) % 400) - 200)
      queries.forEach((query, at) => {
        const within = index.hasWithin(query.x, query.z, 45)
        if (within) covered.add(at)
        else expect(covered.has(at)).toBe(false)
      })
    }
    // The test is only meaningful if points actually did get covered along the way.
    expect(covered.size).toBeGreaterThan(0)
  })

  it('sweeps every bucket a radius wider than one cell can reach', () => {
    const index = new ProximityIndex(10)
    index.add(0, 0)
    expect(index.hasWithin(35, 0, 40)).toBe(true)
    expect(index.hasWithin(45, 0, 40)).toBe(false)
  })
})
