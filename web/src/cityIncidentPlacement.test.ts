import { describe, expect, it } from 'vitest'
import {
  midpoint,
  nearestPointOnPolyline,
  placeIncident,
  type PlacementRoad,
} from './cityIncidentPlacement'

function road(overrides: Partial<PlacementRoad> & { routeId: string }): PlacementRoad {
  return {
    fromObjectId: 'a',
    toId: 'b',
    executions: null,
    polyline: [{ x: 0, z: 0 }, { x: 100, z: 0 }],
    ...overrides,
  }
}

describe('midpoint', () => {
  /**
   * By arc length, not by vertex index. A road that bends around a block carries most of its
   * vertices at the bend, so the middle *vertex* can sit at one end of the road -- which would pin
   * an incident to a building's kerb while claiming it was pinned to the road between two.
   */
  it('walks the arc rather than counting vertices', () => {
    const bent = [
      { x: 0, z: 0 },
      { x: 90, z: 0 },
      { x: 95, z: 0 },
      { x: 100, z: 0 },
    ]
    expect(midpoint(bent)).toEqual({ x: 50, z: 0 })
  })

  it('interpolates inside a segment instead of snapping to its ends', () => {
    const point = midpoint([{ x: 0, z: 0 }, { x: 0, z: 10 }])
    expect(point?.x).toBeCloseTo(0, 10)
    expect(point?.z).toBeCloseTo(5, 10)
  })

  it('handles a degenerate polyline without dividing by zero', () => {
    expect(midpoint([])).toBeNull()
    expect(midpoint([{ x: 3, z: 4 }])).toEqual({ x: 3, z: 4 })
    expect(midpoint([{ x: 3, z: 4 }, { x: 3, z: 4 }])).toEqual({ x: 3, z: 4 })
  })
})

describe('nearestPointOnPolyline', () => {
  it('finds a point part way along a segment, not only a vertex', () => {
    const point = nearestPointOnPolyline([{ x: 0, z: 0 }, { x: 100, z: 0 }], { x: 30, z: 40 })
    expect(point?.x).toBeCloseTo(30, 10)
    expect(point?.z).toBeCloseTo(0, 10)
  })

  it('clamps to the ends rather than running off the road', () => {
    const point = nearestPointOnPolyline([{ x: 0, z: 0 }, { x: 100, z: 0 }], { x: -500, z: 0 })
    expect(point?.x).toBeCloseTo(0, 10)
  })

  it('picks the nearer of two segments', () => {
    const point = nearestPointOnPolyline(
      [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }],
      { x: 110, z: 90 })
    expect(point?.x).toBeCloseTo(100, 10)
    expect(point?.z).toBeCloseTo(90, 10)
  })

  it('returns null for an empty polyline rather than a point at the origin', () => {
    expect(nearestPointOnPolyline([], { x: 1, z: 1 })).toBeNull()
  })
})

/**
 * The ladder, one rung at a time. Each rung is a *different claim*, so each has to be reachable, and
 * the placement has to say which one it used -- a pin on the measured road between two named objects
 * and a pin at one object's kerb look identical on screen and mean different things.
 */
describe('placeIncident', () => {
  const frontage = { x: 10, z: 10 }

  it('pins to the midpoint of the shared road when both parties are known', () => {
    const placement = placeIncident('a', ['b'], frontage, [road({ routeId: 'r:ab' })])
    expect(placement?.basis).toBe('sharedRoad')
    expect(placement?.routeId).toBe('r:ab')
    expect(placement?.x).toBeCloseTo(50, 10)
    expect(placement?.z).toBeCloseTo(0, 10)
  })

  it('reads the shared road in either direction', () => {
    const placement = placeIncident('b', ['a'], frontage, [road({ routeId: 'r:ab' })])
    expect(placement?.basis).toBe('sharedRoad')
    expect(placement?.routeId).toBe('r:ab')
  })

  /** A blocker that named no object is the normal case, and it must not silently become rung one. */
  it('falls to the busiest touching road when only the contended object is known', () => {
    const placement = placeIncident('a', [], frontage, [
      road({ routeId: 'r:quiet', toId: 'c', executions: 10 }),
      road({ routeId: 'r:busy', toId: 'd', executions: 900 }),
    ])
    expect(placement?.basis).toBe('objectRoad')
    expect(placement?.routeId).toBe('r:busy')
  })

  it('puts that fallback pin at the point of the road nearest the frontage', () => {
    const placement = placeIncident('a', [], { x: 30, z: 40 }, [road({ routeId: 'r:ab' })])
    expect(placement?.basis).toBe('objectRoad')
    expect(placement?.x).toBeCloseTo(30, 10)
    expect(placement?.z).toBeCloseTo(0, 10)
  })

  it('falls all the way to the frontage when no road touches the object', () => {
    const placement = placeIncident('z', [], frontage, [road({ routeId: 'r:ab' })])
    expect(placement?.basis).toBe('frontage')
    expect(placement?.routeId).toBeNull()
    expect(placement).toMatchObject({ x: 10, z: 10 })
  })

  /**
   * Never invent a position. An object this page has not placed has no frontage, and a pin at the
   * origin would be a claim about the middle of the map.
   */
  it('returns null rather than guessing when the object was never placed', () => {
    expect(placeIncident('z', [], null, [road({ routeId: 'r:ab' })])).toBeNull()
  })

  it('ignores a counterpart that is the object itself', () => {
    const placement = placeIncident('a', ['a'], frontage, [road({ routeId: 'r:ab' })])
    expect(placement?.basis).toBe('objectRoad')
  })

  it('ignores a road with no drawable geometry', () => {
    const placement = placeIncident('a', ['b'], frontage, [
      road({ routeId: 'r:ab', polyline: [{ x: 5, z: 5 }] }),
    ])
    expect(placement?.basis).toBe('frontage')
  })

  /** Same inputs, same pin. A marker that moves between samples reads as new activity. */
  it('breaks a tie on route id so the pin does not wander between samples', () => {
    const roads = [
      road({ routeId: 'r:b', toId: 'c', executions: 5 }),
      road({ routeId: 'r:a', toId: 'd', executions: 5 }),
    ]
    const first = placeIncident('a', [], frontage, roads)
    const second = placeIncident('a', [], frontage, [...roads].reverse())
    expect(first?.routeId).toBe('r:a')
    expect(second?.routeId).toBe('r:a')
  })

  /** An unmeasured road must not outrank a measured one just because null sorts oddly. */
  it('prefers a road with captured executions over one with none', () => {
    const placement = placeIncident('a', [], frontage, [
      road({ routeId: 'r:aaa', toId: 'c', executions: null }),
      road({ routeId: 'r:zzz', toId: 'd', executions: 1 }),
    ])
    expect(placement?.routeId).toBe('r:zzz')
  })

  /**
   * The popup states the rung, so every rung needs its own sentence and none may be blank. Two rungs
   * sharing wording is two different claims wearing one label.
   */
  it('gives every rung its own rationale, and never an empty one', () => {
    const rationales = [
      placeIncident('a', ['b'], frontage, [road({ routeId: 'r:ab' })])?.rationale,
      placeIncident('a', [], frontage, [road({ routeId: 'r:ab' })])?.rationale,
      placeIncident('z', [], frontage, [road({ routeId: 'r:ab' })])?.rationale,
    ]
    expect(new Set(rationales).size).toBe(3)
    for (const rationale of rationales) expect(rationale?.length ?? 0).toBeGreaterThan(20)
  })

  /**
   * The weaker rungs have to disclaim. Rung two chose its road by captured executions rather than by
   * what is blocking, and rung three is not on a road at all -- if the popup does not say so, a
   * reader takes both for the measured placement rung one makes.
   */
  it('says out loud when the pin is not on the road the block is on', () => {
    expect(placeIncident('a', [], frontage, [road({ routeId: 'r:ab' })])?.rationale)
      .toMatch(/not by what is blocking/i)
    expect(placeIncident('z', [], frontage, [road({ routeId: 'r:ab' })])?.rationale)
      .toMatch(/no road is being claimed/i)
  })
})
