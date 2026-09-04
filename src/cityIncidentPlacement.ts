/**
 * Where an incident pin goes.
 *
 * A block is a relationship between two things, and the old pin drew it as a property of one: a
 * cone on the roof of whichever object the lock resource named. That reads as "this building is
 * broken", which is not what was measured — what was measured is that traffic between two places
 * has stopped moving. So the pin goes on the **road**, at the point on the network where the two
 * parties meet, in the same way a traffic app pins an accident to the carriageway rather than to
 * the nearest house.
 *
 * The evidence for "which two places" is not always there, so the placement falls back down a
 * ladder and **records which rung it used**. That rung is stated in the popup, because a pin placed
 * on a guessed road and a pin placed on the measured road between two named objects are different
 * claims, and a reader who cannot tell them apart is being misled by the more confident one.
 *
 * - `sharedRoad` — both parties are loaded objects and a drawn road runs between them. The pin sits
 *   at the midpoint of that road, which is the only placement here that is *about* the relationship.
 * - `objectRoad` — only the contended object is known, so the pin sits on the busiest road that
 *   object is an endpoint of, at the point nearest its frontage. Still on the road; the road is
 *   chosen by captured executions rather than by what is blocking.
 * - `frontage` — no road touches the object at all, so the pin sits at its kerb: the access point
 *   the address book and the route already use. Never the roof.
 *
 * All of this is pure geometry over inputs the caller measured. Nothing here reads a DMV.
 */

export type IncidentPlacementBasis = 'sharedRoad' | 'objectRoad' | 'frontage'

export interface PlacementPoint {
  readonly x: number
  readonly z: number
}

/** One drawn road, as the scene actually laid it out. */
export interface PlacementRoad {
  readonly routeId: string
  readonly fromItemId: string
  readonly toId: string
  /** Captured executions, or null when no family named the pair. Only used to break ties. */
  readonly executions: number | null
  readonly polyline: readonly PlacementPoint[]
}

export interface IncidentPlacement extends PlacementPoint {
  readonly basis: IncidentPlacementBasis
  /** The road the pin was put on, when it was put on one. */
  readonly routeId: string | null
  /** One sentence naming the rung of the ladder, for the popup. Never omitted. */
  readonly rationale: string
}

const BASIS_RATIONALE: Readonly<Record<IncidentPlacementBasis, string>> = {
  sharedRoad:
    'Pinned to the midpoint of the road between the two objects this wait names, which is the road the block is on.',
  objectRoad:
    'Only the contended object could be resolved, so the pin sits on the busiest road that object is an endpoint of, at the point nearest its frontage. The road is chosen by captured executions, not by what is blocking.',
  frontage:
    'No drawn road reaches this object, so the pin sits at its frontage — the same access point the route uses. No road is being claimed.',
}

/**
 * Chooses the pin position for one incident.
 *
 * `counterpartObjectIds` are the *other* loaded objects the same incident named — the object a
 * blocking session was itself waiting on, or the second resource in a recorded deadlock. Empty is
 * the normal case for a plain block, because a session that holds a lock and waits for nothing does
 * not appear in the waiting DMVs at all and therefore names no object.
 *
 * Returns null only when the object has neither a road nor a frontage, which means the caller asked
 * about an object this page has not placed. A caller must drop the pin rather than invent one.
 */
export function placeIncident(
  itemId: string,
  counterpartObjectIds: readonly string[],
  frontage: PlacementPoint | null,
  roads: readonly PlacementRoad[],
): IncidentPlacement | null {
  const counterparts = new Set(counterpartObjectIds.filter(id => id !== itemId))

  const shared = roads
    .filter(road => road.polyline.length >= 2)
    .filter(
      road =>
        (road.fromItemId === itemId && counterparts.has(road.toId))
        || (road.toId === itemId && counterparts.has(road.fromItemId)),
    )
    .sort(byBusiest)[0]
  if (shared) {
    const point = midpoint(shared.polyline)
    if (point) return { ...point, basis: 'sharedRoad', routeId: shared.routeId, rationale: BASIS_RATIONALE.sharedRoad }
  }

  if (frontage) {
    const touching = roads
      .filter(road => road.polyline.length >= 2)
      .filter(road => road.fromItemId === itemId || road.toId === itemId)
      .sort(byBusiest)[0]
    if (touching) {
      const point = nearestPointOnPolyline(touching.polyline, frontage)
      if (point) {
        return { ...point, basis: 'objectRoad', routeId: touching.routeId, rationale: BASIS_RATIONALE.objectRoad }
      }
    }
    return { x: frontage.x, z: frontage.z, basis: 'frontage', routeId: null, rationale: BASIS_RATIONALE.frontage }
  }

  return null
}

/** Busiest first, then by route id so the same inputs always choose the same road. */
function byBusiest(left: PlacementRoad, right: PlacementRoad): number {
  const delta = (right.executions ?? -1) - (left.executions ?? -1)
  return delta !== 0 ? delta : left.routeId.localeCompare(right.routeId)
}

/**
 * The point half way along a polyline **by arc length**, not the middle vertex. A road that bends
 * around a block has most of its vertices at the bend, so the middle vertex can sit at one end.
 */
export function midpoint(points: readonly PlacementPoint[]): PlacementPoint | null {
  if (points.length === 0) return null
  if (points.length === 1) return { x: points[0].x, z: points[0].z }
  const total = length(points)
  if (total <= 0) return { x: points[0].x, z: points[0].z }

  let walked = 0
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]
    const to = points[index]
    const segment = distance(from, to)
    if (walked + segment >= total / 2) {
      const t = segment === 0 ? 0 : (total / 2 - walked) / segment
      return { x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t }
    }
    walked += segment
  }
  const last = points[points.length - 1]
  return { x: last.x, z: last.z }
}

/** Closest point to `target` anywhere on the polyline, including part way along a segment. */
export function nearestPointOnPolyline(
  points: readonly PlacementPoint[],
  target: PlacementPoint,
): PlacementPoint | null {
  if (points.length === 0) return null
  let best: PlacementPoint = { x: points[0].x, z: points[0].z }
  let bestDistance = Number.POSITIVE_INFINITY
  for (let index = 1; index < points.length; index += 1) {
    const candidate = nearestOnSegment(points[index - 1], points[index], target)
    const measured = distance(candidate, target)
    if (measured < bestDistance) {
      bestDistance = measured
      best = candidate
    }
  }
  return best
}

function nearestOnSegment(from: PlacementPoint, to: PlacementPoint, target: PlacementPoint): PlacementPoint {
  const dx = to.x - from.x
  const dz = to.z - from.z
  const lengthSquared = dx * dx + dz * dz
  if (lengthSquared === 0) return { x: from.x, z: from.z }
  const t = Math.min(1, Math.max(0, ((target.x - from.x) * dx + (target.z - from.z) * dz) / lengthSquared))
  return { x: from.x + dx * t, z: from.z + dz * t }
}

function length(points: readonly PlacementPoint[]): number {
  let total = 0
  for (let index = 1; index < points.length; index += 1) total += distance(points[index - 1], points[index])
  return total
}

function distance(from: PlacementPoint, to: PlacementPoint): number {
  return Math.hypot(to.x - from.x, to.z - from.z)
}
