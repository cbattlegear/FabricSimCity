import { describe, expect, it } from 'vitest'
import { FRAME_MARGIN, fitDistance, MIN_FRAME_EXTENT, VIEW_DIRECTION } from './atlasFraming'

const box = (x: number, y: number, z: number) => ({ x, y, z })

describe('fitDistance', () => {
  it('stands much closer to a flat slab than to a cube of the same footprint', () => {
    const slab = fitDistance(box(400, 20, 400), 36, 16 / 9)
    const cube = fitDistance(box(400, 400, 400), 36, 16 / 9)
    expect(slab).toBeLessThan(cube * 0.75)
  })

  it('stands further back when the viewport is narrower than it is tall', () => {
    const wide = fitDistance(box(400, 20, 400), 36, 2)
    const narrow = fitDistance(box(400, 20, 400), 36, 0.5)
    expect(narrow).toBeGreaterThan(wide)
  })

  it('scales linearly, so an atlas twice as wide is framed the same way', () => {
    const near = fitDistance(box(200, 15, 200), 36, 16 / 9)
    const far = fitDistance(box(400, 30, 400), 36, 16 / 9)
    expect(far).toBeCloseTo(near * 2, 8)
  })

  it('stands closer as the field of view widens', () => {
    const narrowLens = fitDistance(box(400, 20, 400), 25, 16 / 9)
    const wideLens = fitDistance(box(400, 20, 400), 55, 16 / 9)
    expect(wideLens).toBeLessThan(narrowLens)
  })

  it('leaves room around the content', () => {
    const padded = fitDistance(box(400, 20, 400), 36, 16 / 9)
    const tight = fitDistance(box(400, 20, 400), 36, 16 / 9, 1)
    expect(padded).toBeGreaterThan(tight)
    expect(FRAME_MARGIN).toBeGreaterThan(1)
  })

  it('keeps every corner of the box inside the frustum', () => {
    const extents = box(430, 60, 380)
    const fov = 36
    const aspect = 16 / 9
    const distance = fitDistance(extents, fov, aspect, 1)

    const tanVertical = Math.tan((fov * Math.PI) / 360)
    const tanHorizontal = tanVertical * aspect
    const view = VIEW_DIRECTION
    const right = normalize(cross(view, { x: 0, y: 1, z: 0 }))
    const up = cross(right, view)

    let touched = false
    for (const signX of [-1, 1]) {
      for (const signY of [-1, 1]) {
        for (const signZ of [-1, 1]) {
          const corner = { x: extents.x * signX, y: extents.y * signY, z: extents.z * signZ }
          const depth = distance - dot(corner, view)
          const across = Math.abs(dot(corner, right))
          const above = Math.abs(dot(corner, up))
          expect(depth).toBeGreaterThan(0)
          expect(across).toBeLessThanOrEqual(tanHorizontal * depth + 1e-6)
          expect(above).toBeLessThanOrEqual(tanVertical * depth + 1e-6)
          if (across >= tanHorizontal * depth - 1e-6 || above >= tanVertical * depth - 1e-6) touched = true
        }
      }
    }
    // The fit must be tight: at least one corner sits on the frustum wall, or it is not a fit.
    expect(touched).toBe(true)
  })

  it('rejects inputs that cannot describe a box or a viewport', () => {
    expect(() => fitDistance(box(-1, 10, 10), 36, 1)).toThrow(RangeError)
    expect(() => fitDistance(box(10, Number.NaN, 10), 36, 1)).toThrow(RangeError)
    expect(() => fitDistance(box(10, 10, Number.POSITIVE_INFINITY), 36, 1)).toThrow(RangeError)
    expect(() => fitDistance(box(10, 10, 10), 0, 1)).toThrow(RangeError)
    expect(() => fitDistance(box(10, 10, 10), 180, 1)).toThrow(RangeError)
    expect(() => fitDistance(box(10, 10, 10), 36, 0)).toThrow(RangeError)
    expect(() => fitDistance(box(10, 10, 10), 36, 1, 0.5)).toThrow(RangeError)
  })
})

describe('VIEW_DIRECTION', () => {
  it('is a unit vector, so the fitted distance is the actual distance', () => {
    expect(Math.sqrt(dot(VIEW_DIRECTION, VIEW_DIRECTION))).toBeCloseTo(1, 4)
  })

  it('looks down on the grid from one corner, keeping the atlas three-quarter view', () => {
    expect(VIEW_DIRECTION.x).toBeGreaterThan(0)
    expect(VIEW_DIRECTION.y).toBeGreaterThan(0)
    expect(VIEW_DIRECTION.z).toBeGreaterThan(0)
  })
})

describe('MIN_FRAME_EXTENT', () => {
  it('keeps a single small city from being pushed into the viewer', () => {
    expect(MIN_FRAME_EXTENT).toBeGreaterThan(48)
  })
})

type Vector = Readonly<{ x: number; y: number; z: number }>

function cross(a: Vector, b: Vector): Vector {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}

function dot(a: Vector, b: Vector): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function normalize(a: Vector): Vector {
  const length = Math.sqrt(dot(a, a))
  return { x: a.x / length, y: a.y / length, z: a.z / length }
}
