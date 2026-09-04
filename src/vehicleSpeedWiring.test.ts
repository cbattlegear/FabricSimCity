import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  vehicleSpeedScale,
  travelledFraction,
  polylineLength,
  buildVehicleRoster,
  SPEED_FREE_LOG10,
  SPEED_CONGESTED_LOG10,
  VEHICLE_SPEED,
  VEHICLE_SPEED_VARIATION,
  type VehicleRoad,
} from './cityVehicles'
import type { IncidentPlacement } from './cityIncidentPlacement'

/**
 * Speed is a channel on this map, and a channel has to be checked in three separate places or it
 * fails quietly: the reading, the arithmetic, and the wiring.
 *
 * The quiet failure this file exists for is the third one. `travelledFraction` takes `speedScale`
 * with a default of 1, so a production call site that simply forgets it still compiles, still runs,
 * and still draws a car — at the base speed, while the roster placed that car by the scaled one.
 * The result is a vehicle drawn at the wrong point of its road, which reads as a glitch rather than
 * as a missing argument. Nothing in a rendering test would catch it.
 */

const scene = readFileSync(resolve(process.cwd(), 'src', 'CapacityCityScene.ts'), 'utf8')

/** Strips comments, so a comment *describing* a call cannot be mistaken for the call. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function road(over: Partial<VehicleRoad> = {}): VehicleRoad {
  return {
    routeId: 'r1',
    fromItemId: 'a',
    toItemId: 'b',
    familyIds: ['fam-1'],
    operations: 1000,
    carOperations: 1000,
    freightOperations: 0,
    delayPerOperation: null,
    polyline: [{ x: 0, z: 0 }, { x: 1000, z: 0 }],
    ...over,
  }
}

const NO_BLOCKS: ReadonlyMap<string, IncidentPlacement> = new Map()

describe('turning throttling into a pace', () => {
  it('drives a free-flowing road faster and a throttled one slower', () => {
    const free = vehicleSpeedScale(10 ** SPEED_FREE_LOG10)
    const congested = vehicleSpeedScale(10 ** SPEED_CONGESTED_LOG10)
    expect(free).toBeCloseTo(1 + VEHICLE_SPEED_VARIATION, 9)
    expect(congested).toBeCloseTo(1 - VEHICLE_SPEED_VARIATION, 9)
    expect(free).toBeGreaterThan(congested)
  })

  /*
   * A ramp that kept going past its anchors would put a barely-throttled road at several times the
   * base speed on some other capacity, so the clamp is the requirement rather than a detail.
   */
  it('never departs from the base speed by more than the stated fraction', () => {
    const ratios = [1e-9, 1e-4, 0.001, 0.03, 0.5, 1, 30, 500, 1e6, 1e12]
    for (const seconds of ratios) {
      const scale = vehicleSpeedScale(seconds)
      expect(scale, `${seconds}s/op`).toBeLessThanOrEqual(1 + VEHICLE_SPEED_VARIATION + 1e-12)
      expect(scale, `${seconds}s/op`).toBeGreaterThanOrEqual(1 - VEHICLE_SPEED_VARIATION - 1e-12)
    }
  })

  it('puts a road at the centre of the ramp at the base speed', () => {
    const centre = 10 ** ((SPEED_FREE_LOG10 + SPEED_CONGESTED_LOG10) / 2)
    expect(vehicleSpeedScale(centre)).toBeCloseTo(1, 9)
  })

  /*
   * Linear in the logarithm, not in the seconds. Throttling spans orders of magnitude, so a linear
   * ramp would pin all but the very slowest road at the free anchor and produce no visible spread.
   */
  it('spaces the ramp by orders of magnitude', () => {
    const decade = SPEED_CONGESTED_LOG10 - SPEED_FREE_LOG10
    const step = (2 * VEHICLE_SPEED_VARIATION) / decade
    expect(vehicleSpeedScale(0.1) - vehicleSpeedScale(1)).toBeCloseTo(step, 9)
    expect(vehicleSpeedScale(1) - vehicleSpeedScale(10)).toBeCloseTo(step, 9)
  })

  it('makes no claim at all for a road whose throttling is unmeasured', () => {
    expect(vehicleSpeedScale(null)).toBe(1)
    expect(vehicleSpeedScale(Number.NaN)).toBe(1)
  })

  it('drives a measured-zero-throttling road at the top of the band, distinct from unmeasured', () => {
    // A measured zero is genuinely free-flowing; a null is "we cannot say" and drives at exactly 1.
    expect(vehicleSpeedScale(0)).toBeCloseTo(1 + VEHICLE_SPEED_VARIATION, 9)
    expect(vehicleSpeedScale(null)).toBe(1)
  })
})

describe('the pace reaches the road', () => {
  const straight = [{ x: 0, z: 0 }, { x: 1000, z: 0 }]

  it('moves a scaled car further in the same time', () => {
    const base = travelledFraction(straight, 5, null, 1)
    const quick = travelledFraction(straight, 5, null, 1 + VEHICLE_SPEED_VARIATION)
    expect(quick).toBeGreaterThan(base)
    expect(quick / base).toBeCloseTo(1 + VEHICLE_SPEED_VARIATION, 9)
  })

  it('covers exactly the scaled distance', () => {
    const scale = 1.15
    const seconds = 4
    const expected = (seconds * VEHICLE_SPEED * scale) / polylineLength(straight)
    expect(travelledFraction(straight, seconds, null, scale)).toBeCloseTo(expected, 9)
  })

  it('ignores a scale that could only make a car travel backwards or nowhere', () => {
    const base = travelledFraction(straight, 5, null, 1)
    expect(travelledFraction(straight, 5, null, 0)).toBeCloseTo(base, 9)
    expect(travelledFraction(straight, 5, null, -2)).toBeCloseTo(base, 9)
    expect(travelledFraction(straight, 5, null, Number.NaN)).toBeCloseTo(base, 9)
  })
})

describe('the roster carries the scale onto every vehicle', () => {
  /*
   * The behavioural half of the wiring: the roster grades a road's speed from its own throttling and
   * stamps it on each vehicle, so a congested road's cars are slower than a free road's. If the
   * roster took the default 1 the two would be identical and the channel would be inert.
   */
  it('scales a congested road slower than a free-flowing one', () => {
    const free = buildVehicleRoster({ roads: [road({ delayPerOperation: 0.01 })], blocked: NO_BLOCKS })
    const congested = buildVehicleRoster({ roads: [road({ delayPerOperation: 10 })], blocked: NO_BLOCKS })
    expect(free.vehicles.length).toBeGreaterThan(0)
    expect(congested.vehicles.length).toBeGreaterThan(0)
    expect(free.vehicles[0].speedScale).toBeGreaterThan(congested.vehicles[0].speedScale)
  })

  it('leaves an unmeasured-throttling road at the base speed rather than guessing', () => {
    const roster = buildVehicleRoster({ roads: [road({ delayPerOperation: null })], blocked: NO_BLOCKS })
    expect(roster.vehicles.length).toBeGreaterThan(0)
    for (const vehicle of roster.vehicles) expect(vehicle.speedScale).toBe(1)
  })
})

describe('every production call site actually passes the scale', () => {
  /*
   * Source-text guard, for the reason at the top of this file: the default makes an omission
   * compile. The scene positions the drawn vehicle and its trail, and both calls must pass the
   * scale the roster placed the vehicle by, or the drawing and the roster disagree.
   */
  it('scales both the drawn vehicle and the trail behind it', () => {
    const calls = code(scene).match(/travelledFraction\([\s\S]*?\)/g) ?? []
    expect(calls.length, 'the scene no longer positions vehicles here').toBeGreaterThanOrEqual(2)
    for (const call of calls) {
      expect(call, `a travelledFraction call in the scene drops the speed scale: ${call}`)
        .toMatch(/vehicle\.speedScale/)
    }
  })

  it('carries the scale onto the vehicle instead of recomputing it in the renderer', () => {
    expect(code(scene)).not.toMatch(/vehicleSpeedScale\(/)
  })
})
