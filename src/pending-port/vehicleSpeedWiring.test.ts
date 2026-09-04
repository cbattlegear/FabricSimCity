import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  familyMeanDurationMs,
  vehicleSpeedScale,
  travelledFraction,
  polylineLength,
  SPEED_FAST_LOG10_MS,
  SPEED_SLOW_LOG10_MS,
  VEHICLE_SPEED,
  VEHICLE_SPEED_VARIATION,
} from './cityVehicles'
import type { OperationFamily } from '../capacityCityContracts'

/**
 * Speed became a channel on this map, and a channel has to be checked in three separate places or it
 * fails quietly: the reading, the arithmetic, and the wiring.
 *
 * The quiet failure this file exists for is the third one. `travelledFraction` takes `speedScale`
 * with a default of 1, so a production call site that simply forgets it still compiles, still runs,
 * and still draws a car — at the base speed, while the roster retires that car by the scaled one.
 * The result is a vehicle that vanishes early or overstays, which reads as a glitch rather than as a
 * missing argument. Nothing in a rendering test would catch it.
 */

const source = readFileSync(new URL('./cityVehicles.ts', import.meta.url), 'utf8')
const scene = readFileSync(new URL('./CapacityCityScene.ts', import.meta.url), 'utf8')

/** Strips comments, so a comment *describing* a call cannot be mistaken for the call. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function family(over: Partial<OperationFamily> = {}): OperationFamily {
  return {
    familyId: 'fam-1',
    familyId: 'AABBCCDDEEFF0011',
    executionCount: '1000',
    totalDurationMicroseconds: '1000000',
    ...over,
  } as OperationFamily
}

describe('reading how long a family takes', () => {
  it('averages the Query Store total over the executions it covers', () => {
    // 1,000,000 microseconds over 1,000 executions is 1ms each.
    expect(familyMeanDurationMs(family())).toBeCloseTo(1, 9)
  })

  /*
   * The bug this pins: `parseBytes` is the obvious helper to reach for and its `^\d+$` rejects every
   * real duration total, because Query Store returns them with a fractional part. Reusing it would
   * have made every family unmeasured, every scale exactly 1, and the whole feature inert while
   * looking implemented.
   */
  it('reads a total that has a fractional part, as Query Store actually returns them', () => {
    const measured = familyMeanDurationMs(family({
      totalDurationMicroseconds: '5098381354.9999988117331',
      executionCount: '38052150',
    }))
    expect(measured).not.toBeNull()
    expect(measured!).toBeCloseTo(0.13399, 4)
  })

  it('reports nothing rather than guessing when the totals cannot be read', () => {
    expect(familyMeanDurationMs(family({ executionCount: '0' }))).toBeNull()
    expect(familyMeanDurationMs(family({ totalDurationMicroseconds: 'n/a' }))).toBeNull()
    expect(familyMeanDurationMs(family({ totalDurationMicroseconds: undefined as never }))).toBeNull()
    expect(familyMeanDurationMs(family({ executionCount: '-5' }))).toBeNull()
  })
})

describe('turning a duration into a pace', () => {
  it('drives a fast query faster and a slow one slower', () => {
    const fast = vehicleSpeedScale(10 ** SPEED_FAST_LOG10_MS)
    const slow = vehicleSpeedScale(10 ** SPEED_SLOW_LOG10_MS)
    expect(fast).toBeCloseTo(1 + VEHICLE_SPEED_VARIATION, 9)
    expect(slow).toBeCloseTo(1 - VEHICLE_SPEED_VARIATION, 9)
    expect(fast).toBeGreaterThan(slow)
  })

  /*
   * The user asked for "like 15% up or down". A ramp that kept going past its anchors would put a
   * microsecond query at several times the base speed on some other database, so the clamp is the
   * requirement rather than a detail.
   */
  it('never departs from the base speed by more than the stated fraction', () => {
    const durations = [1e-9, 1e-4, 0.001, 0.03, 0.5, 1, 30, 500, 1e6, 1e12]
    for (const ms of durations) {
      const scale = vehicleSpeedScale(ms)
      expect(scale, `${ms}ms`).toBeLessThanOrEqual(1 + VEHICLE_SPEED_VARIATION + 1e-12)
      expect(scale, `${ms}ms`).toBeGreaterThanOrEqual(1 - VEHICLE_SPEED_VARIATION - 1e-12)
    }
  })

  it('puts a query at the centre of the ramp at the base speed', () => {
    const centre = 10 ** ((SPEED_FAST_LOG10_MS + SPEED_SLOW_LOG10_MS) / 2)
    expect(vehicleSpeedScale(centre)).toBeCloseTo(1, 9)
  })

  /*
   * Linear in the logarithm, not in the milliseconds. Durations span orders of magnitude, so a linear
   * ramp would pin all but the very slowest family at the fast anchor and produce no visible spread
   * at all -- which is exactly what "varies by how fast the query runs" is asking to see.
   */
  it('spaces the ramp by orders of magnitude', () => {
    const decade = (SPEED_SLOW_LOG10_MS - SPEED_FAST_LOG10_MS)
    const step = (2 * VEHICLE_SPEED_VARIATION) / decade
    expect(vehicleSpeedScale(0.1) - vehicleSpeedScale(1)).toBeCloseTo(step, 9)
    expect(vehicleSpeedScale(1) - vehicleSpeedScale(10)).toBeCloseTo(step, 9)
  })

  it('makes no claim at all for a family whose duration is unmeasured', () => {
    expect(vehicleSpeedScale(null)).toBe(1)
    expect(vehicleSpeedScale(0)).toBe(1)
    expect(vehicleSpeedScale(Number.NaN)).toBe(1)
    expect(vehicleSpeedScale(Number.POSITIVE_INFINITY)).toBe(1)
  })

  /*
   * Measured against the 60-object sample database, whose mean durations run 0.024ms to 3.21ms. The
   * point of the assertion is that this real range lands *inside* the ramp and produces a spread a
   * reader can actually see, rather than clamping flat at one end.
   */
  it('produces a visible spread over the range a real database actually shows', () => {
    const quickest = vehicleSpeedScale(0.0242)
    const slowest = vehicleSpeedScale(3.2119)
    expect(quickest).toBeCloseTo(1.15, 2)
    expect(slowest).toBeLessThan(1.0)
    expect(quickest - slowest).toBeGreaterThan(0.15)
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

describe('every production call site actually passes the scale', () => {
  /*
   * Source-text guards, for the reason at the top of this file: the default makes an omission
   * compile. These read the two files rather than the behaviour, because the behaviour of a forgotten
   * argument is "slightly wrong position", which no assertion about a rendered frame would separate
   * from correct.
   */
  it('scales the fraction the roster retires a car by', () => {
    const build = code(source).slice(
      code(source).indexOf('export function buildVehicleRoster'),
      code(source).indexOf('export function travelledFraction'),
    )
    expect(build.length).toBeGreaterThan(0)
    expect(build).toMatch(/travelledFraction\([\s\S]{0,200}?speedScale/)
    expect(build).toMatch(/speedScale: number|speedScale,/)
  })

  it('carries the scale onto the vehicle instead of recomputing it in the renderer', () => {
    expect(code(source)).toMatch(/readonly speedScale: number/)
    expect(code(scene)).not.toMatch(/vehicleSpeedScale\(/)
  })

  it('scales both the drawn vehicle and the trail behind it', () => {
    const calls = code(scene).match(/travelledFraction\([\s\S]*?\)/g) ?? []
    expect(calls.length, 'the scene no longer positions vehicles here').toBeGreaterThanOrEqual(2)
    for (const call of calls) {
      expect(call, `a travelledFraction call in the scene drops the speed scale: ${call}`)
        .toMatch(/vehicle\.speedScale/)
    }
  })
})
