import { describe, expect, it } from 'vitest'
import { buildingColor, mapBuildingColor, mixColor, neighborhoodTint, tintPreservingLuma } from './cityBuildings'
import { neighborhoodHue, neighborhoodSwatch } from './cityPlan'

/** Channel-wise distance between two packed sRGB colours. */
function channelGap(left: number, right: number): number {
  let worst = 0
  for (let shift = 16; shift >= 0; shift -= 8) {
    worst = Math.max(worst, Math.abs(((left >> shift) & 0xff) - ((right >> shift) & 0xff)))
  }
  return worst
}

/** Rec. 709 relative luminance, mirroring what the tint is supposed to hold constant. */
function luma(color: number): number {
  return 0.2126 * ((color >> 16) & 0xff) + 0.7152 * ((color >> 8) & 0xff) + 0.0722 * (color & 0xff)
}

describe('neighborhoodHue', () => {
  it('gives one workspace the same hue every time, so a city never repaints itself between loads', () => {
    expect(neighborhoodHue(4)).toBe(neighborhoodHue(4))
    expect(neighborhoodTint(4)).toBe(neighborhoodTint(4))
  })

  it('stays on the wheel for every ordinal a catalogue could produce', () => {
    for (const ordinal of [0, 1, 7, 63, 500]) {
      expect(neighborhoodHue(ordinal)).toBeGreaterThanOrEqual(0)
      expect(neighborhoodHue(ordinal)).toBeLessThan(1)
    }
  })

  it('separates consecutive workspaces far enough to tell two neighbourhoods apart at a glance', () => {
    for (let ordinal = 0; ordinal < 24; ordinal += 1) {
      const step = Math.abs(neighborhoodHue(ordinal) - neighborhoodHue(ordinal + 1))
      expect(Math.min(step, 1 - step)).toBeGreaterThan(0.2)
    }
  })

  it('hands every workspace a distinct hue well past the number of workspaces a capacity usually has', () => {
    const hues = new Set(Array.from({ length: 64 }, (_, ordinal) => neighborhoodHue(ordinal).toFixed(4)))
    expect(hues.size).toBe(64)
  })

  it('paints the sidebar swatch from the same hue the map uses, so the key cannot drift', () => {
    expect(neighborhoodSwatch(3)).toBe(`hsl(${(neighborhoodHue(3) * 360).toFixed(1)} 52% 55%)`)
  })
})

describe('mixColor', () => {
  it('keeps the base untouched at zero weight and reaches the tint at full weight', () => {
    expect(mixColor(0x102030, 0xa0b0c0, 0)).toBe(0x102030)
    expect(mixColor(0x102030, 0xa0b0c0, 1)).toBe(0xa0b0c0)
  })

  it('clamps a weight outside the unit range rather than mixing past either colour', () => {
    expect(mixColor(0x102030, 0xa0b0c0, -3)).toBe(0x102030)
    expect(mixColor(0x102030, 0xa0b0c0, 4)).toBe(0xa0b0c0)
  })

  it('mixes each channel independently, so a tint cannot bleed across the byte boundaries', () => {
    expect(mixColor(0x000000, 0xff0000, 0.5)).toBe(0x800000)
  })
})

describe('tintPreservingLuma', () => {
  it('leaves a facade at the brightness it started with, which is what keeps the massing readable', () => {
    for (const base of [0xd8d2c4, 0x3a4450, 0x8f7f6a, 0xf2efe8]) {
      for (let ordinal = 0; ordinal < 8; ordinal += 1) {
        const tinted = tintPreservingLuma(base, neighborhoodTint(ordinal), 0.44)
        // Not exact, and cannot be: channels are 8-bit, so a fraction of one is unrecoverable.
        expect(Math.abs(luma(tinted) - luma(base))).toBeLessThan(1)
      }
    }
  })

  it('preserves the order of two facades, so a pale tower never outranks a dark one after tinting', () => {
    const tint = neighborhoodTint(3)
    const pale = tintPreservingLuma(0xd8d2c4, tint, 0.44)
    const dark = tintPreservingLuma(0x3a4450, tint, 0.44)
    expect(luma(pale)).toBeGreaterThan(luma(dark))
  })

  it('still moves the colour, so preserving brightness is not the same as doing nothing', () => {
    const base = 0xd8d2c4
    expect(tintPreservingLuma(base, neighborhoodTint(1), 0.44)).not.toBe(base)
  })

  it('holds the brightness of a near-white facade by paling the tint instead of clipping it', () => {
    const base = 0xf6f3ee
    const tinted = tintPreservingLuma(base, neighborhoodTint(6), 0.44)
    expect(Math.abs(luma(tinted) - luma(base))).toBeLessThan(1)
    expect(tinted).not.toBe(base)
  })

  it('keeps black black, because black is a brightness a tint has no business raising', () => {
    expect(tintPreservingLuma(0x000000, 0xff0000, 0.5)).toBe(0x000000)
  })
})

describe('buildingColor', () => {
  it('leaves a building alone when it stands in no neighbourhood', () => {
    expect(buildingColor('tower', 'commercial')).toBe(buildingColor('tower', 'commercial', undefined))
  })

  it('shifts a building towards its neighbourhood without changing how bright it is', () => {
    const plain = buildingColor('tower', 'commercial')
    const tinted = buildingColor('tower', 'commercial', neighborhoodTint(2))
    expect(tinted).not.toBe(plain)
    expect(Math.abs(luma(tinted) - luma(plain))).toBeLessThan(2)
  })

  it('separates two neighbourhoods of the same archetype enough to read as different places', () => {
    const first = buildingColor('house', 'residential', neighborhoodTint(0))
    const second = buildingColor('house', 'residential', neighborhoodTint(1))
    expect(channelGap(first, second)).toBeGreaterThan(24)
  })

  it('never tints a vacant parcel, because unmeasured ground must not look like a building', () => {
    const plain = buildingColor('vacant', 'industrial')
    expect(buildingColor('vacant', 'industrial', neighborhoodTint(5))).toBe(plain)
  })
})

describe('mapBuildingColor', () => {
  it('leaves the plate exactly as drawn when there is no neighbourhood to name', () => {
    expect(mapBuildingColor('tower', 0xcfc9bd)).toBe(0xcfc9bd)
  })

  it('carries the neighbourhood on paper, where flattened plates are all the map has left', () => {
    const first = mapBuildingColor('tower', 0xcfc9bd, neighborhoodTint(0))
    const second = mapBuildingColor('tower', 0xcfc9bd, neighborhoodTint(1))
    expect(first).not.toBe(0xcfc9bd)
    expect(channelGap(first, second)).toBeGreaterThan(16)
  })

  it('keeps the paper light, so a tinted quarter still reads as a basemap rather than a heat map', () => {
    const tinted = mapBuildingColor('tower', 0xcfc9bd, neighborhoodTint(4))
    expect(Math.abs(luma(tinted) - luma(0xcfc9bd))).toBeLessThan(2)
  })

  it('leaves a vacant parcel untinted on the basemap too', () => {
    expect(mapBuildingColor('vacant', 0xcfc9bd, neighborhoodTint(2))).toBe(0xcfc9bd)
  })
})
