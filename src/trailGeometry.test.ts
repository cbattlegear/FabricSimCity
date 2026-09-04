import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROAD_Y, ROAD_LANE_STEP, ROAD_TOP_Y, TRAIL_Y, VEHICLE_Y } from './CapacityCityScene'
import { MAX_LANE } from './cityRoads'

/**
 * The light trail was invisible, and it was invisible for a reason no rendering test would catch.
 *
 * It was pinned at a hard-coded `0.05` under a comment claiming that was "just above the road
 * ribbon". Road ribbons are laid at `ROAD_Y + lane * ROAD_LANE_STEP`, so the stack reaches 0.144 —
 * nearly three times as high. A trail is drawn along the route its own vehicle is driving, which is
 * exactly where that route's ribbon is, so the ribbon won the depth test along the trail's entire
 * length. The wake survived only in the fringe pixels where it happened to be wider than the road
 * beneath it: measured in Chromium before the fix, 28 to 76 changed trail-coloured pixels out of
 * ~906,400.
 *
 * The failure mode is what makes this worth pinning. Nothing errored, nothing flickered, the
 * geometry was uploaded correctly every frame and the buffer contents were right. A test asserting
 * that a trail is built, or has vertices, or has the right colours, passes throughout. So these
 * guards assert the *ordering*, and — more importantly — that the ordering is still derived from one
 * expression. Two independent literals is the defect: it is what let the ribbon stack grow past the
 * trail with nothing saying so, and it is what would let it happen again.
 */

const source = readFileSync(resolve(process.cwd(), 'src', 'CapacityCityScene.ts'), 'utf8')

/** Strips comments, so the doc comment explaining the old `0.05` cannot read as the old `0.05`. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('what is drawn on the street is ordered by height', () => {
  it('clears the whole ribbon stack, not just the lane the trail happens to share', () => {
    expect(ROAD_TOP_Y).toBeCloseTo(ROAD_Y + MAX_LANE * ROAD_LANE_STEP, 9)
    // The assertion that fails against the old hard-coded 0.05: it is below 0.144.
    expect(TRAIL_Y).toBeGreaterThan(ROAD_TOP_Y)
  })

  it('is clear of every lane a route could be assigned, not only the busiest one seen so far', () => {
    for (let lane = 0; lane <= MAX_LANE; lane += 1) {
      expect(TRAIL_Y, `a route in lane ${lane} would bury its own trail`)
        .toBeGreaterThan(ROAD_Y + lane * ROAD_LANE_STEP)
    }
  })

  it('puts the car on its wake rather than inside it', () => {
    expect(VEHICLE_Y).toBeGreaterThan(TRAIL_Y)
  })

  /*
   * Small gaps, deliberately. The trail has to beat the depth buffer, not be seen to: a trail lifted
   * far enough to be obvious in its own right stops reading as light painted onto the street and
   * starts reading as a ribbon hovering over it, which is a different and worse defect.
   */
  it('lifts each layer only far enough to win the depth test', () => {
    expect(TRAIL_Y - ROAD_TOP_Y).toBeLessThan(ROAD_LANE_STEP)
    expect(VEHICLE_Y - TRAIL_Y).toBeLessThan(0.05)
  })
})

describe('the ordering stays derived, so the stack cannot outgrow it again', () => {
  it('takes the top of the stack from the lane count rather than restating it', () => {
    const decl = code(source)
    expect(decl).toMatch(/export const ROAD_TOP_Y\s*=\s*ROAD_Y\s*\+\s*MAX_LANE\s*\*\s*ROAD_LANE_STEP/)
    expect(decl).toMatch(/export const TRAIL_Y\s*=\s*ROAD_TOP_Y\s*[+\-]/)
    expect(decl).toMatch(/export const VEHICLE_Y\s*=\s*TRAIL_Y\s*[+\-]/)
  })

  /*
   * The ribbons and the trail have to read the *same* constants. If the road placement went back to
   * its own literal, every assertion above would still pass while the bug returned in full.
   */
  it('lays the road ribbons from the same two constants the trail is derived from', () => {
    expect(code(source)).toMatch(/mesh\.position\.y\s*=\s*ROAD_Y\s*\+\s*lane\s*\*\s*ROAD_LANE_STEP/)
  })

  it('writes the trail vertices at the named height and not at a literal', () => {
    const trail = code(source)
    const write = trail.slice(trail.indexOf('trailPositions[offset + 1]'))
    expect(write.length, 'the trail vertex write moved').toBeGreaterThan(0)
    expect(write.slice(0, 60)).toMatch(/trailPositions\[offset \+ 1\] = TRAIL_Y/)
  })

  it('positions the vehicles at the named height and not at a literal', () => {
    expect(code(source)).toMatch(/vehiclePosition\.set\([^)]*VEHICLE_Y[^)]*\)/)
  })
})

/**
 * The ribbon's *width* had the same shape of defect as its height, one screen further down.
 *
 * It was a flat `TRAIL_WIDTH = 1.9` world units applied to all five classes -- about a car's width
 * (1.87), so it was right for one rung and wrong for the other four. At the bottom of the ladder it
 * was wrong by a lot and in the direction that shows: a bicycle is 0.52 wide and 1.77 long, so its
 * wake was 3.6x wider than the bike and wider than the bike was long. On the sample capacity 71% of
 * vehicles are bicycles, so that was the ordinary case.
 *
 * These read the class table out of the source because `VEHICLE_SIZE` is a local inside the scene
 * factory and is deliberately not exported -- the same reason `cityVehicleLegibility.test.ts` reads
 * it that way. Parsing it is what lets the ladder assertions below be about the real numbers rather
 * than about a copy of them that could agree with the test and disagree with the map.
 */
const CLASS_WIDTH: Record<string, number> = (() => {
  const table = code(source).slice(code(source).indexOf('const VEHICLE_SIZE'))
  const body = table.slice(0, table.indexOf('\n  }'))
  const out: Record<string, number> = {}
  for (const match of body.matchAll(/(\w+):\s*\{\s*width:\s*([\d.]+)/g)) out[match[1]] = Number(match[2])
  return out
})()

describe('the wake is as wide as the vehicle leaving it', () => {
  it('reads a class table to be proportional to in the first place', () => {
    for (const klass of ['bike', 'car', 'van', 'semiTruck', 'unknown']) {
      expect(CLASS_WIDTH[klass], `VEHICLE_SIZE no longer states a width for ${klass}`)
        .toBeGreaterThan(0)
    }
  })

  it('takes its width from the vehicle rather than restating a number beside it', () => {
    const scene = code(source)
    expect(scene, 'the ribbon is back to one flat width for every class')
      .not.toMatch(/const TRAIL_WIDTH\s*=/)
    expect(scene, 'the ribbon width is no longer derived from the class table')
      .toMatch(/VEHICLE_SIZE\[[^\]]+\]\.width\s*\*\s*TRAIL_WIDTH_RATIO/)
  })

  /*
   * The failure this pins is the one that would look finished and change nothing: declaring the ratio
   * and still computing a single `halfWidth` above the batch loop. Every class shares one number
   * again, the constant is referenced so no linter complains, and the ladder is still flat. The width
   * has to be computed per batch, and the batches are what carry the class.
   */
  it('computes the width per class and not once for the whole frame', () => {
    const body = code(source).slice(code(source).indexOf('function writeTrails'))
    const fn = body.slice(0, body.indexOf('\n  function ', 1))
    expect(fn.length, 'writeTrails moved or was renamed').toBeGreaterThan(0)

    const halfWidth = fn.indexOf('const halfWidth')
    const batchLoop = fn.indexOf('for (const batch of vehicleBatches)')
    expect(halfWidth, 'writeTrails no longer computes a half width').toBeGreaterThan(-1)
    expect(batchLoop, 'writeTrails no longer walks the class batches').toBeGreaterThan(-1)
    expect(halfWidth, 'one width is computed for every class again, so the ladder is flat')
      .toBeGreaterThan(batchLoop)
  })

  it('keeps the ribbon inside the silhouette rather than the full width of it', () => {
    const ratio = Number(code(source).match(/const TRAIL_WIDTH_RATIO\s*=\s*([\d.]+)/)?.[1])
    expect(ratio, 'TRAIL_WIDTH_RATIO is gone or is no longer a plain number').toBeGreaterThan(0)
    expect(ratio, 'a wake at least as wide as its vehicle reads as a tyre mark, not as light')
      .toBeLessThan(1)
  })

  /*
   * The point of the whole change: a reader can tell the classes apart by their wake. Asserted as an
   * ordering rather than against fixed pixel figures, because `magnify` multiplies all of them
   * equally and so cancels -- which is also why the ladder holds at every zoom.
   */
  it('puts the classes in the same order as the vehicles themselves', () => {
    expect(CLASS_WIDTH.bike).toBeLessThan(CLASS_WIDTH.car)
    expect(CLASS_WIDTH.car).toBeLessThan(CLASS_WIDTH.van)
    expect(CLASS_WIDTH.van).toBeLessThan(CLASS_WIDTH.semiTruck)
  })

  /*
   * The specific thing the user reported, stated as a number. A wake wider than its vehicle is long
   * has no direction in it, which is what made a bicycle read as a smudge with a speck at the front.
   */
  it('never draws a wake wider than its vehicle is long', () => {
    const ratio = Number(code(source).match(/const TRAIL_WIDTH_RATIO\s*=\s*([\d.]+)/)?.[1])
    const lengths = (() => {
      const table = code(source).slice(code(source).indexOf('const VEHICLE_SIZE'))
      const body = table.slice(0, table.indexOf('\n  }'))
      const out: Record<string, number> = {}
      for (const m of body.matchAll(/(\w+):\s*\{[^}]*length:\s*([\d.]+)/g)) out[m[1]] = Number(m[2])
      return out
    })()
    for (const klass of Object.keys(CLASS_WIDTH)) {
      // `unknown` is a cube on purpose, so width equals length and only the ratio keeps it under.
      expect(CLASS_WIDTH[klass] * ratio, `a ${klass} trails a wake wider than it is long`)
        .toBeLessThan(lengths[klass])
    }
  })
})