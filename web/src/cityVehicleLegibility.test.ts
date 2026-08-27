/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { labelScreenScale } from './cityLabels'

/**
 * Live vehicles have to be large enough on screen to be recognised, not merely large enough to exist.
 *
 * A user reported that the authored vehicle models "aren't being used and are just blocks". They
 * were being used: the kit loaded, all fourteen meshes were present, and every model drew correctly.
 * They were six pixels long. At that size a bicycle, a car and a modelled semi-trailer are the same
 * smudge, so the fix is a size floor rather than anything to do with the assets — and the guard
 * therefore has to be about projected size rather than about which geometry got bound.
 *
 * {@link labelScreenScale} returns `min(maxGrowth, minimumPx / projected)`, which is the whole
 * subtlety of this area: the two constants are alternatives, not a pair, so **raising one alone can
 * be completely neutralised by the other**. Which one binds depends only on how far the camera is
 * out, and both regimes really occur — a 60-object database frames from about 1,500 world units
 * where the floor binds, and a 4,000-object one pulls back past 4,000 units where the cap does. The
 * two framings below are one assertion each so that a change touching only one constant fails on the
 * other, instead of passing and quietly leaving half the databases with invisible traffic.
 */

const scene = readFileSync(new URL('./DatabaseCityScene.ts', import.meta.url), 'utf8')

function constant(name: string): number {
  const match = scene.match(new RegExp(`const ${name} = ([\\d.]+)`))
  expect(match, `${name} has been renamed and this guard now measures nothing`).not.toBeNull()
  return Number(match![1])
}

/**
 * Read from the scene rather than restated, so the ladder and the guard cannot drift apart.
 *
 * The slice ends at `VEHICLE_MIN_PX` and not, as it first did, at `VEHICLE_Y`. `VEHICLE_Y` was a
 * local sitting just below the ladder until the trail fix promoted it to a module-level constant
 * near the top of the file, at which point `indexOf` found it *before* `VEHICLE_SIZE` and the slice
 * inverted — `scene.slice(from, to)` with `to < from` returns the empty string, so every class would
 * have read as "no longer a rung on the ladder". Both bounds are now constants this file already
 * reads by name, so renaming either one fails loudly here instead of silently retargeting the slice.
 */
function vehicleLength(klass: string): number {
  const from = scene.indexOf('const VEHICLE_SIZE')
  const to = scene.indexOf('const VEHICLE_MIN_PX')
  expect(from, 'VEHICLE_SIZE has been renamed and this guard now measures nothing')
    .toBeGreaterThan(-1)
  expect(to, 'VEHICLE_MIN_PX no longer follows the ladder and this slice is unbounded')
    .toBeGreaterThan(from)
  const match = scene.slice(from, to).match(new RegExp(`${klass}: \\{[^}]*length: ([\\d.]+)`))
  expect(match, `${klass} is no longer a rung on the ladder`).not.toBeNull()
  return Number(match![1])
}

const MIN_PX = constant('VEHICLE_MIN_PX')
const MAX_GROWTH = constant('VEHICLE_MAX_GROWTH')
const BIKE = vehicleLength('bike')
const SEMI = vehicleLength('semiTruck')

/** The measured whole-city framing of the 60-object database, in a 1032x900 canvas at fov 46. */
const CLOSE = { distance: 1495, fov: 46, viewport: 900 } as const
/** A 4,000-object database, where the camera has pulled back far enough that the cap takes over. */
const FAR = { distance: 4000, fov: 46, viewport: 900 } as const

function bikePixels(framing: { distance: number; fov: number; viewport: number }): number {
  const span = 2 * framing.distance * Math.tan((framing.fov * Math.PI) / 360)
  const projected = (BIKE / span) * framing.viewport
  return projected * labelScreenScale(BIKE, framing.distance, framing.fov, framing.viewport,
    MIN_PX, MAX_GROWTH)
}

describe('a live vehicle is drawn large enough to be recognised', () => {
  /*
   * Pins VEHICLE_MIN_PX. Close in, `minimumPx / projected` is about 12.7 and the cap is 18, so the
   * floor is the term that binds and the cap could be raised to any number at all without moving
   * this. Measured in Chromium against the real scene: 5.7 px before the fix, 12.9 px after.
   */
  it('resolves a bicycle at the framing a small database opens at', () => {
    expect(bikePixels(CLOSE)).toBeGreaterThanOrEqual(12)
  })

  /*
   * Pins VEHICLE_MAX_GROWTH. Far out, `minimumPx / projected` is about 34 and the cap is 18, so the
   * cap binds and the floor is inert. This is the assertion a floor-only change fails.
   */
  it('resolves a bicycle once the camera has pulled back over a large database', () => {
    expect(bikePixels(FAR)).toBeGreaterThanOrEqual(8)
  })

  /*
   * And the ceiling, so this is a range rather than a direction of travel.
   *
   * Every class shares one magnification, so the semi-trailer is what limits how far the floor can
   * be pushed. 12.24 m at 18x is about 220 world units, against the ~234-unit trail already accepted
   * behind a moving vehicle; past that a truck is longer than the street it is on.
   */
  it('does not let the largest shell outgrow the trail behind it', () => {
    expect(SEMI * MAX_GROWTH).toBeLessThanOrEqual(234)
  })

  /*
   * The ladder is the measurement, and it survives magnification only because the factor is shared.
   * A per-class clamp would flatten it at exactly the wide framings where it is needed most.
   */
  it('magnifies every class by one shared factor', () => {
    const place = scene.slice(
      scene.indexOf('function placeVehicles()'),
      scene.indexOf('const written = writeTrails('),
    )
    expect(place.match(/labelScreenScale\(/g) ?? []).toHaveLength(1)
    expect(place).toMatch(/vehicleScale\.setScalar\(magnify\)/)
  })
})
