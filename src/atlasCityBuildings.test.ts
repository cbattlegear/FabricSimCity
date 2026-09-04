import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { planAtlasCity, UNKNOWN_SIDE, VACANT_HEIGHT } from './atlasCity'
import { buildAtlasCityGeometry, PAD_HEIGHT, STREET_FILL_WIDTH } from './atlasCityBuildings'
import { polygonArea } from './mapRibbon'
import { testCapacity } from './testing/capacityFixture'
import type { CapacityAtlasItem, FabricSku } from './fabricContracts'

/** A capacity reduced to the two measurements the atlas geometry actually reads. */
function capacity(sku: FabricSku | null, cuSeconds: string | null): CapacityAtlasItem {
  return testCapacity({ sku, cuSeconds })
}

const LARGE_SKU: FabricSku = 'F64'
const SMALL_SKU: FabricSku = 'F8'
const BUSY_CU = String(4_200_000)

function boundingBox(geometry: THREE.BufferGeometry): THREE.Box3 {
  geometry.computeBoundingBox()
  return geometry.boundingBox!
}

describe('buildAtlasCityGeometry', () => {
  it('draws only the nonquantitative pad when allocated size is unknown', () => {
    const geometry = buildAtlasCityGeometry(planAtlasCity(capacity(null, null)))
    const box = boundingBox(geometry.pad)

    expect(geometry.massing).toBeNull()
    expect(geometry.trim).toBeNull()
    expect(geometry.streetCasing).toBeNull()
    expect(geometry.streetFill).toBeNull()
    // The plate is an irregular town outline now, so its width varies; what is fixed is the ground
    // it covers, and that is still exactly the nonquantitative side squared.
    expect(box.max.x - box.min.x).toBeGreaterThan(UNKNOWN_SIDE)
    expect(box.max.y).toBeCloseTo(PAD_HEIGHT)
  })

  it('gives the town exactly the ground its allocated size paid for', () => {
    const plan = planAtlasCity(capacity(LARGE_SKU, BUSY_CU))
    expect(polygonArea(plan.outline)).toBeCloseTo(plan.side * plan.side, 5)
    expect(boundingBox(buildAtlasCityGeometry(plan).pad).max.y).toBeCloseTo(PAD_HEIGHT, 6)
  })

  it('tops the massing out at exactly the encoded tallest tower, above the pad it stands on', () => {
    const plan = planAtlasCity(capacity(LARGE_SKU, BUSY_CU))
    const geometry = buildAtlasCityGeometry(plan)

    expect(geometry.massing).not.toBeNull()
    expect(boundingBox(geometry.massing!).max.y).toBeCloseTo(PAD_HEIGHT + plan.towerHeight!, 4)
  })

  it('never lets a building cross the town the allocated size paid for', () => {
    const plan = planAtlasCity(capacity(LARGE_SKU, BUSY_CU))
    const box = boundingBox(buildAtlasCityGeometry(plan).massing!)

    expect(box.max.x).toBeLessThanOrEqual(plan.radius.max)
    expect(box.min.z).toBeGreaterThanOrEqual(-plan.radius.max)
  })

  it('fences every lot with no massing above it when used size is unknown', () => {
    const plan = planAtlasCity(capacity(LARGE_SKU, null))
    const box = boundingBox(buildAtlasCityGeometry(plan).massing!)

    expect(box.max.y).toBeCloseTo(PAD_HEIGHT + VACANT_HEIGHT + 0.12, 4)
  })

  it('paves a measured zero rather than raising anything on it', () => {
    const geometry = buildAtlasCityGeometry(planAtlasCity(capacity(SMALL_SKU, '0')))

    expect(geometry.massing).toBeNull()
    expect(boundingBox(geometry.trim!).max.y).toBeCloseTo(PAD_HEIGHT + 0.245, 4)
  })

  it('draws every street as a casing and a fill, the way both surfaces draw a road', () => {
    const plan = planAtlasCity(capacity(LARGE_SKU, BUSY_CU))
    const geometry = buildAtlasCityGeometry(plan)

    expect(plan.streets.length).toBeGreaterThan(0)
    const casing = boundingBox(geometry.streetCasing!)
    const fill = boundingBox(geometry.streetFill!)
    // The casing is the wider of the two and sits under the fill, which is the only thing that makes
    // a road read as a road rather than as a line.
    expect(casing.max.x - casing.min.x).toBeGreaterThan(fill.max.x - fill.min.x)
    expect(casing.max.y).toBeLessThan(fill.min.y)
    expect(fill.max.x).toBeLessThanOrEqual(plan.radius.max + STREET_FILL_WIDTH)
  })

  it('builds the same city twice, so a refresh cannot reshape a capacity that did not change', () => {
    const plan = planAtlasCity(capacity(LARGE_SKU, BUSY_CU))
    const first = buildAtlasCityGeometry(plan).massing!.getAttribute('position').array
    const second = buildAtlasCityGeometry(plan).massing!.getAttribute('position').array

    expect(Array.from(second)).toEqual(Array.from(first))
  })
})