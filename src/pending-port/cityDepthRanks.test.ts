import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import { GROUND_RANK, roadRank, sink } from './CapacityCityScene'

/**
 * The world height each ranked sheet is actually drawn at, read off the builders in
 * `CapacityCityScene`. The ladder exists to reproduce this ordering in depth-buffer units, so the
 * two have to agree — a sheet that is raised or lowered without moving its rank would be drawn in
 * one order and depth-tested in the other, which is the z-fighting the ladder is here to prevent.
 */
const DRAWN_AT: ReadonlyArray<readonly [keyof typeof GROUND_RANK, number]> = [
  ['sharedLane', 0.32],
  ['facilityLane', 0.2],
  ['road', 0.06],
  ['roadCasing', 0.052],
  ['traffic', 0.045],
  ['laneMark', -0.2],
  ['streetFill', -0.25],
  ['streetCasing', -0.3],
  ['riverBank', -0.46],
  ['districtWash', -0.5],
  ['riverWater', -0.5],
  ['landCover', -0.52],
  ['plate', -0.75],
]

describe('flat-stack depth ranks', () => {
  test('rank rises exactly as the sheets are drawn lower', () => {
    for (let i = 1; i < DRAWN_AT.length; i += 1) {
      const [aboveName, aboveY] = DRAWN_AT[i - 1]
      const [belowName, belowY] = DRAWN_AT[i]
      expect(aboveY, `${aboveName} must not be drawn below ${belowName}`).toBeGreaterThanOrEqual(belowY)
      expect(
        GROUND_RANK[aboveName],
        `${aboveName} must be pushed less far back than ${belowName}`,
      ).toBeLessThan(GROUND_RANK[belowName])
    }
  })

  test('every sheet has a rank of its own', () => {
    const ranks = Object.values(GROUND_RANK)
    expect(new Set(ranks).size).toBe(ranks.length)
  })

  test('nothing is pulled in front of the buildings standing on the ground', () => {
    for (const rank of Object.values(GROUND_RANK)) expect(rank).toBeGreaterThan(0)
  })

  test('sink pushes a material back by its rank in depth-buffer units', () => {
    const material = sink(new THREE.MeshBasicMaterial(), GROUND_RANK.streetFill)
    expect(material.polygonOffset).toBe(true)
    expect(material.polygonOffsetFactor).toBe(GROUND_RANK.streetFill)
    // Units have to buy more than the one step the buffer is ambiguous by, or the offset only moves
    // the fight rather than settling it.
    expect(material.polygonOffsetUnits).toBeGreaterThanOrEqual(2 * GROUND_RANK.streetFill)
  })

  test('road lanes refine the road rank without reaching its neighbours', () => {
    expect(roadRank(0)).toBe(GROUND_RANK.road)
    for (let lane = 0; lane < 12; lane += 1) {
      expect(roadRank(lane)).toBeLessThanOrEqual(GROUND_RANK.road)
      expect(roadRank(lane)).toBeGreaterThan(GROUND_RANK.facilityLane)
      // A higher lane is drawn higher, so it has to be pushed back less.
      if (lane > 0) expect(roadRank(lane)).toBeLessThanOrEqual(roadRank(lane - 1))
    }
    // Out-of-range lanes clamp rather than escaping the band.
    expect(roadRank(-3)).toBe(GROUND_RANK.road)
    expect(roadRank(999)).toBe(roadRank(8))
  })
})
