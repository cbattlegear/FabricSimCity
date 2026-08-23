import { describe, expect, it } from 'vitest'
import {
  ATLAS_LABEL_MAX_CHARS,
  buildingLabelText,
  buildingLabelWorldHeight,
  createCityLabels,
  databaseLabelText,
  elideMiddle,
  isLabelLegible,
  labelAnchor,
  labelPixelHeight,
  labelWorldWidth,
  minimumLegibleWorldHeight,
  neighborhoodLabelText,
  LABEL_MAX_CHARS,
  LABEL_MIN_LEGIBLE_PX,
  LABEL_WORLD_HEIGHT,
  LABEL_WORLD_HEIGHT_MAX,
  NEIGHBORHOOD_LABEL_MAX_CHARS,
  NEIGHBORHOOD_LABEL_WORLD_HEIGHT,
} from './cityLabels'

describe('buildingLabelText', () => {
  it('names a building without its schema, because the neighbourhood it stands in already says that', () => {
    expect(buildingLabelText('Orders')).toBe('Orders')
  })

  it('elides a name that would rasterize into an unreadably wide plate', () => {
    const label = buildingLabelText('FactInventorySnapshotDailyRollupExtended')
    expect([...label]).toHaveLength(LABEL_MAX_CHARS)
    expect(label).toContain('…')
  })
})

describe('neighborhoodLabelText', () => {
  it('sets a schema name as a tracked uppercase place name, the way a basemap names a district', () => {
    expect(neighborhoodLabelText('Sales')).toBe('S\u2009A\u2009L\u2009E\u2009S')
  })

  it('elides before tracking, so the letter spacing never pushes the plate past its budget', () => {
    const label = neighborhoodLabelText('WarehouseStagingArchive')
    expect([...label.replace(/\u2009/g, '')]).toHaveLength(NEIGHBORHOOD_LABEL_MAX_CHARS)
    expect(label).toContain('…')
  })
})

describe('databaseLabelText', () => {
  it('names a database city without qualifying it, because nothing qualifies a database', () => {
    expect(databaseLabelText('sales')).toBe('sales')
  })

  it('elides a name that would spill across the grid pitch into a neighbouring city', () => {
    const label = databaseLabelText('WarehouseStagingArchive2024')
    expect([...label]).toHaveLength(ATLAS_LABEL_MAX_CHARS)
    expect(label).toContain('…')
  })

  it('stays narrower than a database-city label, since atlas labels are drawn larger', () => {
    expect(ATLAS_LABEL_MAX_CHARS).toBeLessThan(LABEL_MAX_CHARS)
  })
})

describe('elideMiddle', () => {
  it('leaves a name that already fits exactly untouched', () => {
    const text = 'a'.repeat(LABEL_MAX_CHARS)
    expect(elideMiddle(text, LABEL_MAX_CHARS)).toBe(text)
  })

  it('keeps the tail, because that is often the only thing distinguishing two names', () => {
    const archive = elideMiddle('dbo.orders_2024_q3_archive', 20)
    const current = elideMiddle('dbo.orders_2024_q3_current', 20)
    expect(archive).not.toBe(current)
    expect(archive.endsWith('archive')).toBe(true)
    expect(current.endsWith('current')).toBe(true)
  })

  it('never returns more characters than asked for', () => {
    for (const limit of [2, 3, 7, 12, 31]) {
      expect([...elideMiddle('x'.repeat(100), limit)]).toHaveLength(limit)
    }
  })

  it('degenerates safely rather than throwing at tiny limits', () => {
    expect(elideMiddle('abcdef', 1)).toBe('…')
    expect(elideMiddle('abcdef', 0)).toBe('')
    expect(elideMiddle('abcdef', -4)).toBe('')
  })

  it('counts astral characters as single glyphs so an emoji name is not cut in half', () => {
    const cut = elideMiddle('🏙🏙🏙🏙🏙🏙', 3)
    expect([...cut]).toHaveLength(3)
    expect(cut).not.toContain('\ufffd')
  })
})

describe('labelPixelHeight', () => {
  it('projects a sprite to the share of the viewport its world height covers', () => {
    // At a 90 degree lens the vertical span equals twice the distance, so a 10-unit label on a
    // 100-unit span across 1000 pixels is exactly a tenth of the height.
    expect(labelPixelHeight(10, 50, 90, 1000)).toBeCloseTo(100)
  })

  it('shrinks with distance', () => {
    const near = labelPixelHeight(LABEL_WORLD_HEIGHT, 500, 46, 1115)
    const far = labelPixelHeight(LABEL_WORLD_HEIGHT, 2000, 46, 1115)
    expect(near).toBeGreaterThan(far)
    expect(near / far).toBeCloseTo(4)
  })

  it('reports the same size for the two lenses the city is viewed through, at their matching distances', () => {
    // Map mode fakes a parallel projection with a 13 degree lens and scales the orbit distance by
    // tan(23)/tan(6.5) to hold apparent size. A label has to survive that swap unchanged.
    const scale = Math.tan((23 * Math.PI) / 180) / Math.tan((6.5 * Math.PI) / 180)
    const oblique = labelPixelHeight(LABEL_WORLD_HEIGHT, 2233, 46, 1115)
    const flat = labelPixelHeight(LABEL_WORLD_HEIGHT, 2233 * scale, 13, 1115)
    expect(flat).toBeCloseTo(oblique, 5)
  })

  it('treats degenerate input as unmeasurable rather than returning NaN or Infinity', () => {
    expect(labelPixelHeight(0, 100, 46, 1000)).toBe(0)
    expect(labelPixelHeight(10, 0, 46, 1000)).toBe(0)
    expect(labelPixelHeight(10, 100, 0, 1000)).toBe(0)
    expect(labelPixelHeight(10, 100, 46, 0)).toBe(0)
    expect(labelPixelHeight(10, 100, 180, 1000)).toBe(0)
    expect(labelPixelHeight(Number.NaN, 100, 46, 1000)).toBe(0)
  })
})

describe('isLabelLegible', () => {
  /**
   * The bug this guards. A city frames at roughly 2,233 units under the 46 degree lens, and at the
   * previous 6.2-unit label height that projected to about 3.6 pixels -- of which only ~70% is
   * glyph. Names were being drawn at under three pixels of type.
   */
  it('rejects the size building names used to be drawn at when the whole city is framed', () => {
    expect(labelPixelHeight(6.2, 2233, 46, 1115)).toBeLessThan(4)
    expect(isLabelLegible(6.2, 2233, 46, 1115)).toBe(false)
  })

  it('draws a name once it clears the legibility threshold', () => {
    expect(isLabelLegible(LABEL_WORLD_HEIGHT, 500, 46, 1115)).toBe(true)
  })

  it('hides a name rather than drawing it too small to read', () => {
    expect(isLabelLegible(LABEL_WORLD_HEIGHT, 2233, 46, 1115)).toBe(false)
  })

  it('switches exactly at the threshold, in either lens', () => {
    for (const fov of [46, 13]) {
      const span = LABEL_WORLD_HEIGHT * 1115 / LABEL_MIN_LEGIBLE_PX
      const distance = span / (2 * Math.tan((fov * Math.PI) / 360))
      expect(isLabelLegible(LABEL_WORLD_HEIGHT, distance * 0.99, fov, 1115)).toBe(true)
      expect(isLabelLegible(LABEL_WORLD_HEIGHT, distance * 1.01, fov, 1115)).toBe(false)
    }
  })

  /**
   * Neighbourhood names are what holds the wide view together once building names drop out, so they
   * have to stay readable at exactly the framing where the others are hidden.
   */
  it('keeps neighbourhood names legible at the framing that hides building names', () => {
    expect(isLabelLegible(LABEL_WORLD_HEIGHT, 2233, 46, 1115)).toBe(false)
    expect(isLabelLegible(NEIGHBORHOOD_LABEL_WORLD_HEIGHT, 2233, 46, 1115)).toBe(true)
  })

  it('treats an unmeasurable label as not legible rather than drawing it', () => {
    expect(isLabelLegible(LABEL_WORLD_HEIGHT, 0, 46, 1115)).toBe(false)
  })
})

describe('buildingLabelWorldHeight', () => {
  it('letters a large table larger than a small one, so its name survives to a wider zoom', () => {
    expect(buildingLabelWorldHeight(60)).toBeGreaterThan(buildingLabelWorldHeight(24))
  })

  it('clamps at both ends so one enormous table cannot flatten every other name', () => {
    expect(buildingLabelWorldHeight(24)).toBeCloseTo(LABEL_WORLD_HEIGHT)
    expect(buildingLabelWorldHeight(1)).toBeCloseTo(LABEL_WORLD_HEIGHT)
    expect(buildingLabelWorldHeight(60)).toBeCloseTo(LABEL_WORLD_HEIGHT_MAX)
    expect(buildingLabelWorldHeight(100_000)).toBeCloseTo(LABEL_WORLD_HEIGHT_MAX)
  })

  it('stays monotonic across the range it stretches over', () => {
    const heights = [24, 30, 36, 42, 48, 54, 60].map(buildingLabelWorldHeight)
    for (let i = 1; i < heights.length; i += 1) {
      expect(heights[i]).toBeGreaterThan(heights[i - 1])
    }
  })

  /**
   * The span is deliberately under a factor of two. Label width scales with height, so a wider
   * range would have big names sprawling across neighbouring lots -- and it would start to look
   * like a readable measurement, which it is not.
   */
  it('spans well under a factor of two, so no page count can be read off a label', () => {
    expect(LABEL_WORLD_HEIGHT_MAX / LABEL_WORLD_HEIGHT).toBeLessThan(2)
  })

  it('gives an unmeasured table the baseline height rather than lettering it as a small one', () => {
    expect(buildingLabelWorldHeight(null)).toBeCloseTo(LABEL_WORLD_HEIGHT)
    expect(buildingLabelWorldHeight(Number.NaN)).toBeCloseTo(LABEL_WORLD_HEIGHT)
    expect(buildingLabelWorldHeight(0)).toBeCloseTo(LABEL_WORLD_HEIGHT)
    expect(buildingLabelWorldHeight(-5)).toBeCloseTo(LABEL_WORLD_HEIGHT)
  })
})

describe('minimumLegibleWorldHeight', () => {
  it('inverts labelPixelHeight, so a label at exactly the threshold is legible', () => {
    const minimum = minimumLegibleWorldHeight(2233, 46, 1115)
    expect(labelPixelHeight(minimum, 2233, 46, 1115)).toBeCloseTo(LABEL_MIN_LEGIBLE_PX)
    expect(isLabelLegible(minimum, 2233, 46, 1115)).toBe(true)
  })

  it('agrees with isLabelLegible across a range of distances and both lenses', () => {
    for (const fov of [46, 13]) {
      for (const distance of [80, 400, 903, 1500, 2233, 6000]) {
        const minimum = minimumLegibleWorldHeight(distance, fov, 1115)
        expect(isLabelLegible(minimum * 1.01, distance, fov, 1115)).toBe(true)
        expect(isLabelLegible(minimum * 0.99, distance, fov, 1115)).toBe(false)
      }
    }
  })

  it('reveals the largest names before the smallest as the camera comes in', () => {
    const small = buildingLabelWorldHeight(24)
    const large = buildingLabelWorldHeight(60)
    // A distance where the large name clears the threshold and the small one does not.
    const distance = (LABEL_WORLD_HEIGHT_MAX * 1115) / LABEL_MIN_LEGIBLE_PX / (2 * Math.tan((46 * Math.PI) / 360)) * 0.99
    expect(isLabelLegible(large, distance, 46, 1115)).toBe(true)
    expect(isLabelLegible(small, distance, 46, 1115)).toBe(false)
  })

  it('hides every label rather than guessing when the view cannot be measured', () => {
    expect(minimumLegibleWorldHeight(0, 46, 1115)).toBe(Number.POSITIVE_INFINITY)
    expect(minimumLegibleWorldHeight(2233, 0, 1115)).toBe(Number.POSITIVE_INFINITY)
    expect(minimumLegibleWorldHeight(2233, 46, 0)).toBe(Number.POSITIVE_INFINITY)
    expect(minimumLegibleWorldHeight(2233, 180, 1115)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('labelWorldWidth', () => {
  it('preserves the rasterized aspect ratio at the fixed world height', () => {
    expect(labelWorldWidth(400, 80, 4)).toBeCloseTo(20)
  })

  it('defaults to the shared label height', () => {
    expect(labelWorldWidth(160, 80)).toBeCloseTo(LABEL_WORLD_HEIGHT * 2)
  })

  it('claims no width for a degenerate raster instead of producing NaN or Infinity', () => {
    expect(labelWorldWidth(0, 80)).toBe(0)
    expect(labelWorldWidth(400, 0)).toBe(0)
    expect(labelWorldWidth(Number.NaN, 80)).toBe(0)
  })
})

describe('createCityLabels', () => {
  /**
   * Minimal 2D canvas stub. Vitest runs in a node environment with no DOM, but the sprite decisions
   * worth locking down — depth behaviour, render order, world size — are settled at sprite creation
   * and need no GPU to observe.
   */
  function stubCanvas() {
    const context = {
      font: '',
      textAlign: '',
      textBaseline: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      measureText: (text: string) => ({ width: text.length * 30 }),
      beginPath: () => {},
      moveTo: () => {},
      arcTo: () => {},
      closePath: () => {},
      fill: () => {},
      stroke: () => {},
      fillText: () => {},
    }
    const previous = globalThis.document
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: () => ({
          width: 0,
          height: 0,
          getContext: (kind: string) => (kind === '2d' ? context : null),
        }),
      },
    })
    return () => {
      if (previous === undefined) delete (globalThis as { document?: unknown }).document
      else Object.defineProperty(globalThis, 'document', { configurable: true, value: previous })
    }
  }

  it('draws labels without depth testing, so a building never hides another building\'s name', () => {
    const restore = stubCanvas()
    try {
      const labels = createCityLabels()
      const sprite = labels.make('dbo.Customer')
      expect(sprite).not.toBeNull()
      // The whole point: identity survives every camera angle.
      expect(sprite!.material.depthTest).toBe(false)
      // Still never writes depth, so a label cannot occlude the geometry it floats over.
      expect(sprite!.material.depthWrite).toBe(false)
      // Above the road (1) and halo (2) render orders used by the scene.
      expect(sprite!.renderOrder).toBeGreaterThan(2)
      labels.dispose()
    } finally {
      restore()
    }
  })

  it('sizes a sprite to the shared world height, preserving its rasterized aspect', () => {
    const restore = stubCanvas()
    try {
      const labels = createCityLabels()
      const sprite = labels.make('dbo.Customer')!
      expect(sprite.scale.y).toBeCloseTo(LABEL_WORLD_HEIGHT)
      expect(sprite.scale.x).toBeGreaterThan(0)
      labels.dispose()
    } finally {
      restore()
    }
  })

  it('sizes to the height the asking scene needs, so the atlas is readable at its own scale', () => {
    const restore = stubCanvas()
    try {
      const labels = createCityLabels(11)
      const sprite = labels.make('sales')!
      expect(sprite.scale.y).toBeCloseTo(11)
      expect(sprite.scale.x).toBeCloseTo(labelWorldWidth(190, 80, 11))
      labels.dispose()
    } finally {
      restore()
    }
  })

  it('reuses one material per distinct string, so a rebuild does not churn textures', () => {
    const restore = stubCanvas()
    try {
      const labels = createCityLabels()
      const first = labels.make('dbo.Customer')!
      const second = labels.make('dbo.Customer')!
      const other = labels.make('dbo.OrderHeader')!
      expect(second.material).toBe(first.material)
      expect(other.material).not.toBe(first.material)
      labels.dispose()
    } finally {
      restore()
    }
  })
})

describe('labelAnchor', () => {
  it('pushes the label off the footprint toward the street the building fronts', () => {
    expect(labelAnchor(10, 10, 10, 30, 5)).toEqual({ x: 10, z: 15 })
    expect(labelAnchor(10, 10, 30, 10, 5)).toEqual({ x: 15, z: 10 })
  })

  it('moves exactly the requested distance along a diagonal frontage', () => {
    const anchor = labelAnchor(0, 0, 30, 40, 10)
    expect(anchor.x).toBeCloseTo(6)
    expect(anchor.z).toBeCloseTo(8)
    expect(Math.hypot(anchor.x, anchor.z)).toBeCloseTo(10)
  })

  it('stays at the centre when the access point coincides, rather than dividing by zero', () => {
    expect(labelAnchor(12, -4, 12, -4, 6)).toEqual({ x: 12, z: -4 })
  })
})
