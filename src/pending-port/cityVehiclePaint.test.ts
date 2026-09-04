/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { vehiclePaintHue } from './cityVehicles'

/**
 * Live vehicles are painted from their id, and the ways that can silently stop working.
 *
 * Three of the four assertions below are about mechanism rather than appearance, because every one
 * of the mechanisms fails *invisibly to a screenshot taken in the wrong mode* — and two of them fail
 * by producing a plausible-looking scene rather than an error.
 */

const scene = readFileSync(new URL('./CapacityCityScene.ts', import.meta.url), 'utf8')
/** Comments describe the traps; matching against them would let a description pass as a fix. */
const code = scene.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/**
 * The body of `writeVehicleColors`, with a guard against the slice silently becoming empty.
 *
 * Every assertion about this function below is a negative — "does not mention `shadowMap`", "does
 * not mention `vehicleUnknown`" — and a negative against an empty string passes. Renaming the
 * function would therefore turn most of this file into a set of guarantees about nothing.
 */
function paintBody(): string {
  const start = code.indexOf('function writeVehicleColors()')
  expect(start, 'writeVehicleColors has been renamed and this file now guards nothing')
    .toBeGreaterThan(-1)
  const rest = code.slice(start)
  const body = rest.slice(0, rest.indexOf('\n  }'))
  expect(body.length, 'the writeVehicleColors slice came out empty').toBeGreaterThan(80)
  return body
}

describe('every live vehicle is painted from its own id', () => {
  /*
   * Deterministic, because the roster is rebuilt on every live sample — two to five seconds. Under
   * `Math.random()` the whole city would repaint on that cadence and a car would change colour while
   * you watched it, which reads as a different car rather than as the same one still running.
   */
  it('gives one id the same colour every time it is asked', () => {
    const first = vehiclePaintHue('req:42:0x9ab3')
    expect(vehiclePaintHue('req:42:0x9ab3')).toBe(first)
    expect(vehiclePaintHue('req:42:0x9ab3')).toBe(first)
  })

  it('derives the colour from nothing but the id', () => {
    const body = paintBody()
    expect(body).toMatch(/vehiclePaintHue\(batch\.vehicles\[index\]\.id\)/)
    expect(body).not.toMatch(/Math\.random/)
    expect(code).not.toMatch(/Math\.random\(\)[^)]*vehicle/i)
  })

  /*
   * Spread, not merely deterministic. A hash that returned a constant, or that clustered ids
   * differing in one character, would pass every determinism check above and still draw one colour.
   */
  it('separates ids that differ by a single character', () => {
    const hues = Array.from({ length: 64 }, (_, index) => vehiclePaintHue(`req:${index}`))
    expect(new Set(hues).size).toBe(hues.length)
    const sorted = [...hues].sort((left, right) => left - right)
    // Spread across the wheel rather than bunched into one arc.
    expect(sorted[0]).toBeLessThan(0.2)
    expect(sorted[sorted.length - 1]).toBeGreaterThan(0.8)
    for (const hue of hues) {
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(1)
    }
  })

  /*
   * Hue only, one fixed saturation and one fixed lightness.
   *
   * Length is the sole measured channel on this map. A colour that also varied in depth or
   * brightness would read as a second one, and a vehicle that came out dark would additionally be
   * harder to see than its neighbour for a reason that means nothing.
   */
  it('varies hue alone, so paint carries no magnitude', () => {
    const colors = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => {
      const color = new THREE.Color()
      color.setHSL(vehiclePaintHue(id), 0.68, 0.6, THREE.SRGBColorSpace)
      return color.getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace)
    })
    for (const hsl of colors) {
      expect(hsl.s).toBeCloseTo(colors[0].s, 5)
      expect(hsl.l).toBeCloseTo(colors[0].l, 5)
    }
    expect(new Set(colors.map(hsl => hsl.h)).size).toBe(colors.length)
    const source = code.slice(code.indexOf('const VEHICLE_PAINT_SATURATION'))
    expect(source).toMatch(/const VEHICLE_PAINT_SATURATION = [\d.]+/)
    expect(source).toMatch(/const VEHICLE_PAINT_LIGHTNESS = [\d.]+/)
  })
})

describe('paint reaches the GPU by the one route that works', () => {
  /*
   * The trap this exists for.
   *
   * `vertexColors` is the flag usually named alongside `setColorAt`, and turning it on here would
   * look like the fix and render every vehicle *black*. In three 0.185 the vertex prefix defines
   * `USE_COLOR` from `material.vertexColors` alone while `USE_INSTANCING_COLOR` comes from
   * `instanceColor` being present, so instance colours already work without the flag — and with it,
   * the shader additionally multiplies in a `color` geometry attribute the kit meshes do not have.
   * An unbound attribute reads as zero.
   *
   * Asserted against three itself rather than restated, so a version bump that changed the rule
   * fails here instead of in a screenshot nobody takes.
   */
  it('needs no vertexColors flag, and would break under one', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    expect(geometry.attributes.color, 'kit geometry carries no vertex colours').toBeUndefined()

    const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial(), 2)
    expect(mesh.instanceColor).toBeNull()
    mesh.setColorAt(0, new THREE.Color(0xff0000))
    // Present without the flag, which is what defines USE_INSTANCING_COLOR.
    expect(mesh.instanceColor).not.toBeNull()
    expect(mesh.instanceColor!.itemSize).toBe(3)

    expect(code).not.toMatch(/vehicleBody[\s\S]{0,200}?vertexColors/)
    expect(code).not.toMatch(/vertexColors[\s\S]{0,200}?vehicleBody/)
  })

  /*
   * Body role only. Painting glass or metal turns a car into a solid lozenge, and painting the
   * unknown class puts a query that never stated a volume onto a ladder it was never measured onto.
   */
  it('paints the body material and leaves unknown, glass, trim and metal alone', () => {
    const body = paintBody()
    expect(body).toMatch(/mesh\.material !== materials\.vehicleBody\) continue/)
    expect(body).not.toMatch(/vehicleUnknown/)
    expect(body).not.toMatch(/vehicleGlass/)
    expect(body).not.toMatch(/vehicleTrim/)
    expect(body).not.toMatch(/vehicleMetal/)
  })

  /*
   * `instanceColor` multiplies the material colour, and map mode inverts the vehicle ladder to a
   * dark ink so it survives on a light basemap. A hue multiplied into that ink is near-black.
   */
  it('writes white in map mode, so the basemap ink is unchanged', () => {
    const body = paintBody()
    expect(body).toMatch(/const flat = viewMode === 'map'/)
    expect(body).toMatch(/if \(flat\) vehiclePaint\.setRGB\(1, 1, 1\)/)
    // A mode toggle rebuilds no vehicle, so the tints have to be rewritten where the palette is.
    const from = code.indexOf('function applyViewMode()')
    const to = code.indexOf('const groundGroup = new THREE.Group()')
    expect(from, 'applyViewMode has been renamed and this guard now covers nothing')
      .toBeGreaterThan(-1)
    expect(to, 'the layer groups have been renamed and this slice is unbounded')
      .toBeGreaterThan(from)
    expect(code.slice(from, to)).toMatch(/writeVehicleColors\(\)/)
  })

  /*
   * And the roster path, so a rebuilt city is painted before it is first drawn rather than one
   * sample later.
   */
  it('paints the roster as it is built', () => {
    const from = code.indexOf('function buildVehicles()')
    const to = code.indexOf('const vehicleMatrix')
    expect(from, 'buildVehicles has been renamed and this guard now covers nothing')
      .toBeGreaterThan(-1)
    expect(to, 'the vehicle scratch buffers have been renamed and this slice is unbounded')
      .toBeGreaterThan(from)
    expect(code.slice(from, to)).toMatch(/writeVehicleColors\(\)/)
  })

  /*
   * Vehicles animate every frame, so anything on this path that armed the shadow map would give
   * back the 948-draw-call pass issue #90 removed. `shadowInvalidation.test.ts` guards the loops
   * themselves; paint is new code on the same path and gets the same statement made about it.
   */
  it('arms no shadow pass', () => {
    const body = paintBody()
    expect(body).not.toMatch(/shadowMap/)
    expect(body).not.toMatch(/requestRender\(\)/)
    expect(body).not.toMatch(/scheduleFrame\(\)/)
  })
})
