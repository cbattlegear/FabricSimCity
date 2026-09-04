import { describe, expect, it } from 'vitest'
import { ATLAS_SPACING } from './atlasLayout'
import { planAtlasTerrain, TERRAIN_EXTENT } from './atlasTerrain'
import { polygonArea } from './mapRibbon'

describe('planAtlasTerrain', () => {
  it('draws the same country every session, so the ground never moves under a reader', () => {
    expect(planAtlasTerrain()).toEqual(planAtlasTerrain())
  })

  it('takes no argument that a measurement could reach, so nothing here can encode one', () => {
    // The landscape is a pure function of a fixed seed and a fixed extent. Adding, growing or
    // dropping a capacity cannot change one coordinate of it, which is what keeps it scenery.
    const before = planAtlasTerrain()
    const after = planAtlasTerrain(TERRAIN_EXTENT)
    expect(after).toEqual(before)
  })

  it('runs its river right across the sheet rather than stopping inside it', () => {
    const { river } = planAtlasTerrain()
    const first = river[0]
    const last = river[river.length - 1]

    expect(river.length).toBeGreaterThan(16)
    expect(Math.hypot(first.x, first.z)).toBeGreaterThan(TERRAIN_EXTENT)
    expect(Math.hypot(last.x, last.z)).toBeGreaterThan(TERRAIN_EXTENT)
  })

  it('covers enough ground to kill the void without burying the towns', () => {
    const { patches } = planAtlasTerrain()
    const sheet = Math.PI * TERRAIN_EXTENT * TERRAIN_EXTENT
    const covered = patches.reduce((total, patch) => total + polygonArea(patch.points), 0)

    expect(patches.length).toBeGreaterThan(20)
    expect(covered / sheet).toBeGreaterThan(0.02)
    expect(covered / sheet).toBeLessThan(0.35)
  })

  it('keeps water and woodland off the lattice the towns are placed on', () => {
    // Every patch centre is offset half a slot from the grid the layout hands out, so a lake can
    // never land on a town centre however many capacities the server turns out to have.
    for (const patch of planAtlasTerrain().patches) {
      let cx = 0
      let cz = 0
      for (const point of patch.points) {
        cx += point.x
        cz += point.z
      }
      cx /= patch.points.length
      cz /= patch.points.length
      const offX = Math.abs(((cx % ATLAS_SPACING) + ATLAS_SPACING) % ATLAS_SPACING)
      const offZ = Math.abs(((cz % ATLAS_SPACING) + ATLAS_SPACING) % ATLAS_SPACING)
      const nearSlotX = Math.min(offX, ATLAS_SPACING - offX)
      const nearSlotZ = Math.min(offZ, ATLAS_SPACING - offZ)
      expect(Math.hypot(nearSlotX, nearSlotZ)).toBeGreaterThan(ATLAS_SPACING * 0.25)
    }
  })

  it('uses only cover classes the city palette already knows how to draw', () => {
    const known = new Set(['water', 'woodland', 'park', 'orchard'])
    for (const patch of planAtlasTerrain().patches) expect(known.has(patch.kind)).toBe(true)
  })
})
