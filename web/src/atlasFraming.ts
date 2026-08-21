/**
 * Camera framing for the server atlas.
 *
 * The atlas reserves a hundred slots so a database keeps the same spot on the grid for as long as the
 * page is open, but a server rarely fills them. Framing the whole reservation grid would spend nearly
 * all of the viewport on ground nobody occupies and shrink every city — and every city's name — to the
 * point where the atlas can only be read by hovering. So the camera fits the cities that are actually
 * there.
 *
 * Nothing here is evidence. Distance and direction are presentation: they change what is legible, never
 * what is claimed. A city's plot and towers encode the same bytes whether the camera is near or far,
 * which is why fitting is safe to do automatically on every refresh.
 */

export type HalfExtents = Readonly<{ x: number; y: number; z: number }>

/**
 * The atlas view direction, as a unit vector pointing from the subject towards the camera. This is the
 * original fixed camera position normalised, so the atlas keeps its established three-quarter view and
 * only the distance is solved for.
 */
export const VIEW_DIRECTION = Object.freeze({ x: 0.469777, y: 0.5665, z: 0.67704 })

/**
 * The map-mode view direction: north-up and effectively straight down, the way a basemap is drawn.
 *
 * Not *exactly* straight down. A camera looking along its own up vector has no defined orientation,
 * and `lookAt` degenerates there, so the direction keeps a fraction of a degree of tilt. At atlas
 * distances that is a sub-pixel difference from a true plan view.
 */
export const MAP_VIEW_DIRECTION = Object.freeze({ x: 0, y: 0.99999988, z: 0.0005 })

/** Fraction of extra room left around the content, so cities never touch the viewport edge. */
export const FRAME_MARGIN = 1.12

/**
 * Smallest horizontal half-extent the camera will fit to. A lone small database would otherwise be
 * pushed into the viewer's face, which reads as a zoom bug rather than as a small database.
 */
export const MIN_FRAME_EXTENT = 90

/**
 * Distance at which an axis-aligned box centred on the look-at point fits inside the frustum.
 *
 * A bounding sphere would be far easier to solve and badly wrong here: the atlas is a wide, almost flat
 * slab of ground, and its sphere is nearly as large as its diagonal, so sphere-fitting stands the camera
 * off as if the content were a cube and wastes most of the viewport. Fitting the box corners instead
 * respects the fact that a low, wide subject seen from above needs far less distance than a tall one.
 *
 * Each corner is resolved into the camera basis: a depth along the view axis and two offsets in the
 * image plane. A corner is inside the frustum when its horizontal offset is within
 * `tan(halfHorizontal) x depth` and likewise vertically, and since depth grows one-for-one with
 * distance, the smallest distance satisfying one corner is a closed form. The answer is the largest of
 * those over all eight corners. Margin is applied by narrowing the half-angles rather than by scaling
 * the result, so the padding is an even border in the image rather than a fraction of a distance.
 *
 * `view` is the direction from the subject towards the camera; pass `MAP_VIEW_DIRECTION` to solve the
 * plan view. It must be a unit vector and must not be exactly world up.
 */
export function fitDistance(
  halfExtents: HalfExtents,
  fovDegrees: number,
  aspect: number,
  margin = FRAME_MARGIN,
  view: Vector = VIEW_DIRECTION,
): number {
  for (const axis of ['x', 'y', 'z'] as const) {
    const value = halfExtents[axis]
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`halfExtents.${axis} must be a non-negative finite number`)
    }
  }
  if (!Number.isFinite(fovDegrees) || fovDegrees <= 0 || fovDegrees >= 180) {
    throw new RangeError('fovDegrees must be between 0 and 180')
  }
  if (!Number.isFinite(aspect) || aspect <= 0) throw new RangeError('aspect must be a positive finite number')
  if (!Number.isFinite(margin) || margin < 1) throw new RangeError('margin must be at least 1')

  const tanVertical = Math.tan((fovDegrees * Math.PI) / 360) / margin
  const tanHorizontal = tanVertical * aspect

  // The camera basis. `right` is horizontal because it is perpendicular to world up.
  const right = normalize(cross(view, { x: 0, y: 1, z: 0 }))
  const up = cross(right, view)

  let distance = 0
  for (const signX of [-1, 1]) {
    for (const signY of [-1, 1]) {
      for (const signZ of [-1, 1]) {
        const corner = { x: halfExtents.x * signX, y: halfExtents.y * signY, z: halfExtents.z * signZ }
        const depthOffset = dot(corner, view)
        const across = Math.abs(dot(corner, right))
        const above = Math.abs(dot(corner, up))
        const needed = depthOffset + Math.max(across / tanHorizontal, above / tanVertical)
        if (needed > distance) distance = needed
      }
    }
  }
  return distance
}

type Vector = Readonly<{ x: number; y: number; z: number }>

function cross(a: Vector, b: Vector): Vector {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

function dot(a: Vector, b: Vector): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function normalize(a: Vector): Vector {
  const length = Math.sqrt(dot(a, a))
  return length === 0 ? { x: 1, y: 0, z: 0 } : { x: a.x / length, y: a.y / length, z: a.z / length }
}
