import { describe, expect, it } from 'vitest'
import {
  claimLane,
  corridorKeys,
  dashSpans,
  DASH_PATTERNS,
  laneOffset,
  LANE_PITCH,
  MAX_LANE,
  offsetPolyline,
  type Point,
} from './cityRoads'

const spanLength = (span: { ax: number; az: number; bx: number; bz: number }) =>
  Math.hypot(span.bx - span.ax, span.bz - span.az)

const totalLength = (spans: ReadonlyArray<{ ax: number; az: number; bx: number; bz: number }>) =>
  spans.reduce((sum, span) => sum + spanLength(span), 0)

const polylineLength = (points: readonly Point[]) => {
  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z)
  }
  return total
}

describe('dashSpans', () => {
  it('draws an unbroken road for a confirmed reference', () => {
    const line: Point[] = [{ x: 0, z: 0 }, { x: 0, z: 200 }, { x: 300, z: 200 }]
    const spans = dashSpans(line, DASH_PATTERNS.solid)
    expect(spans).toHaveLength(2)
    expect(totalLength(spans)).toBeCloseTo(500, 6)
  })

  it('repeats a fixed-length pattern instead of leaving one gap per leg', () => {
    // The old renderer trimmed each whole leg to a fraction of its length, so a two-leg road showed
    // exactly two enormous gaps and looked severed rather than dashed.
    const line: Point[] = [{ x: 0, z: 0 }, { x: 0, z: 200 }, { x: 300, z: 200 }]
    const spans = dashSpans(line, DASH_PATTERNS.dashed)

    expect(spans.length).toBeGreaterThan(25)
    for (const span of spans) expect(spanLength(span)).toBeLessThanOrEqual(DASH_PATTERNS.dashed!.on + 1e-6)
    const duty = totalLength(spans) / polylineLength(line)
    const expected = DASH_PATTERNS.dashed!.on / (DASH_PATTERNS.dashed!.on + DASH_PATTERNS.dashed!.off)
    expect(duty).toBeGreaterThan(expected - 0.05)
    expect(duty).toBeLessThan(expected + 0.05)
  })

  it('shows less of a road the weaker the claim behind it', () => {
    const line: Point[] = [{ x: 0, z: 0 }, { x: 0, z: 400 }]
    const dashed = totalLength(dashSpans(line, DASH_PATTERNS.dashed))
    const sparse = totalLength(dashSpans(line, DASH_PATTERNS.sparse))
    expect(sparse).toBeLessThan(dashed)
    expect(dashed).toBeLessThan(polylineLength(line))
  })

  it('carries the dash phase across a corner so the road reads as one route', () => {
    const straight = dashSpans([{ x: 0, z: 0 }, { x: 0, z: 200 }], DASH_PATTERNS.dashed)
    const cornered = dashSpans(
      [{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 0, z: 200 }],
      DASH_PATTERNS.dashed)
    expect(totalLength(cornered)).toBeCloseTo(totalLength(straight), 6)
  })

  it('never emits an unbounded number of dashes for a degenerate pattern', () => {
    const spans = dashSpans([{ x: 0, z: 0 }, { x: 0, z: 5000 }], { on: 0.0001, off: 0.0001 })
    expect(spans.length).toBeLessThanOrEqual(400)
  })

  it('returns nothing to draw for a polyline with fewer than two points', () => {
    expect(dashSpans([{ x: 1, z: 1 }], DASH_PATTERNS.solid)).toEqual([])
  })
})

describe('offsetPolyline', () => {
  it('leaves the centre line alone at lane zero', () => {
    const line: Point[] = [{ x: 0, z: 0 }, { x: 0, z: 100 }]
    expect(offsetPolyline(line, 0)).toEqual(line)
  })

  it('shifts a straight run perpendicular to its direction', () => {
    const shifted = offsetPolyline([{ x: 0, z: 0 }, { x: 0, z: 100 }], 4.2)
    expect(shifted[0].x).toBeCloseTo(-4.2, 6)
    expect(shifted[1].x).toBeCloseTo(-4.2, 6)
    expect(shifted[0].z).toBeCloseTo(0, 6)
  })

  it('mitres a right-angle corner so both offset legs still meet', () => {
    const corner = offsetPolyline(
      [{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 100, z: 100 }], 4.2)
    // The joint moves diagonally by the miter length, keeping both legs a constant 4.2 away.
    expect(Math.abs(corner[1].x - 0)).toBeCloseTo(4.2, 6)
    expect(Math.abs(corner[1].z - 100)).toBeCloseTo(4.2, 6)
  })

  it('keeps every offset road a constant distance from the one beside it', () => {
    const line: Point[] = [{ x: 0, z: 0 }, { x: 0, z: 100 }]
    const first = offsetPolyline(line, laneOffset(1))
    const second = offsetPolyline(line, laneOffset(2))
    expect(Math.abs(first[0].x - second[0].x)).toBeCloseTo(LANE_PITCH * 2, 6)
  })
})

describe('laneOffset', () => {
  it('keeps lane zero on the street centre line', () => {
    expect(laneOffset(0)).toBe(0)
  })

  it('alternates lanes to either side of the centre line', () => {
    expect(laneOffset(1)).toBeCloseTo(LANE_PITCH, 6)
    expect(laneOffset(2)).toBeCloseTo(-LANE_PITCH, 6)
    expect(laneOffset(3)).toBeCloseTo(LANE_PITCH * 2, 6)
    expect(laneOffset(4)).toBeCloseTo(-LANE_PITCH * 2, 6)
  })
})

describe('corridorKeys', () => {
  it('names the street leg each segment runs along', () => {
    expect(corridorKeys([{ x: 0, z: 0 }, { x: 0, z: 100 }, { x: 100, z: 100 }]))
      .toEqual(['x0', 'z100'])
  })

  it('returns nothing for a polyline with no segments', () => {
    expect(corridorKeys([{ x: 4, z: 9 }])).toEqual([])
  })

  it('gives every point on one bowed leg the same key, so two roads on it cannot share a lane', () => {
    const pitch = { x: 55, z: 55 }
    // Two roads running the same north-south street, sampled at different points of the same bend.
    const left = corridorKeys([{ x: 8, z: 0 }, { x: 14, z: 40 }, { x: 9, z: 80 }], pitch)
    const right = corridorKeys([{ x: 2, z: 10 }, { x: 13, z: 50 }, { x: 4, z: 90 }], pitch)
    expect(new Set([...left, ...right])).toEqual(new Set(['x0']))
    // Rounding raw coordinates instead, which is the default pitch, would have split them apart.
    expect(new Set(corridorKeys([{ x: 8, z: 0 }, { x: 14, z: 40 }, { x: 9, z: 80 }])).size).toBe(2)
  })

  it('tells neighbouring corridors apart', () => {
    const pitch = { x: 55, z: 55 }
    expect(corridorKeys([{ x: 6, z: 0 }, { x: 6, z: 40 }], pitch)).toEqual(['x0'])
    expect(corridorKeys([{ x: 61, z: 0 }, { x: 61, z: 40 }], pitch)).toEqual(['x1'])
  })
})

describe('claimLane', () => {
  it('gives the first road the centre line', () => {
    expect(claimLane(new Map(), ['x0', 'z100'])).toBe(0)
  })

  it('moves a road aside when it shares any leg with one already drawn', () => {
    const taken = new Map<string, Set<number>>()
    expect(claimLane(taken, ['x0', 'z100'])).toBe(0)
    expect(claimLane(taken, ['z100', 'x400'])).toBe(1)
    expect(claimLane(taken, ['x0', 'z100'])).toBe(2)
  })

  it('lets roads that share no leg both keep the centre line', () => {
    const taken = new Map<string, Set<number>>()
    expect(claimLane(taken, ['x0'])).toBe(0)
    expect(claimLane(taken, ['x900'])).toBe(0)
  })

  it('wraps back to the centre rather than drawing a road off the pavement', () => {
    const taken = new Map<string, Set<number>>()
    for (let lane = 0; lane <= MAX_LANE; lane += 1) expect(claimLane(taken, ['x0'])).toBe(lane)
    expect(claimLane(taken, ['x0'])).toBe(0)
  })
})
