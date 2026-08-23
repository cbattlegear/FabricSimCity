/**
 * Spreading the drawn traffic ribbons across the street network by loading them as measured demand.
 *
 * A co-reference ribbon is a journey the workload actually ran between two buildings, repeated as
 * often as Query Store recorded. Drawing each along its own shortest path stacks every ribbon between
 * the same two districts onto the one quickest street; loading them all through `assignTraffic`
 * instead lets a filling arterial push later ribbons onto parallel ways, which is what makes a busy
 * corridor read as several routes rather than one thick line.
 *
 * Keeping this apart from `gradeRoads` is the evidence boundary made structural. The demand -- each
 * ribbon's execution count -- is measured and handed to the assignment verbatim as the trip weight.
 * Only the *path* is decided here, and a path was always invented: SQL Server has no streets. Width,
 * colour and dash pattern stay exactly the measured quantities `gradeRoads` set, the road classes the
 * assignment routes over stay seed-derived, and nothing the assignment computes -- congestion, travel
 * time, the way each journey took -- is ever written back into what a street claims. The legend
 * disclaims the path and its congestion alongside the rest of the scenery.
 */

import { assignTraffic, tourDemands, type TravelDemand } from './cityAssignment'
import { dedupePoints, intersectionId, nearestIntersectionId, type CityPlan } from './cityPlan'
import type { RoadTraffic } from './cityTraffic'

/** A drawable street-following route: the ordered intersection ids it threads, and its centre line. */
export interface AssignedRoutePath {
  readonly nodeIds: string[]
  readonly points: Array<{ x: number; z: number }>
}

/**
 * The congestion-aware path for every on-map traffic ribbon, keyed by route id.
 *
 * A ribbon is absent from the result when it carries no measured executions, when either endpoint has
 * left the city on a cross-database ramp, or when its two buildings share a junction and so describe
 * no journey. The caller draws those the plain way; everything present here it draws along the
 * assigned path instead of a fresh shortest path.
 */
export function assignQueryRoutes(
  plan: CityPlan,
  roads: readonly RoadTraffic[],
): Map<string, AssignedRoutePath> {
  // The graph node nearest a building's frontage, resolved once per object however many ribbons name
  // it, so a hub table is not re-scanned against every intersection for each of its links.
  const nodeByObject = new Map<string, number>()
  const nodeFor = (objectId: string): number | null => {
    const cached = nodeByObject.get(objectId)
    if (cached !== undefined) return cached
    const lot = plan.lots.get(objectId)
    if (!lot) return null
    const nearest = plan.intersections.get(nearestIntersectionId(plan, lot.accessX, lot.accessZ))
    if (!nearest) return null
    nodeByObject.set(objectId, nearest.col)
    return nearest.col
  }

  const roadById = new Map<string, RoadTraffic>()
  const demands: TravelDemand[] = []
  for (const road of roads) {
    roadById.set(road.routeId, road)
    // A ribbon with no captured executions has no measured weight to spread, and one that leaves the
    // city on a ramp has no second junction on the network; neither belongs in the assignment.
    if (road.executions === null) continue
    if (!plan.lots.has(road.toId)) continue
    const from = nodeFor(road.fromObjectId)
    const to = nodeFor(road.toId)
    if (from === null || to === null) continue
    for (const demand of tourDemands(road.routeId, [from, to], road.executions)) demands.push(demand)
  }

  const assignment = assignTraffic(plan.graph, plan.roadProperties, demands)
  const paths = new Map<string, AssignedRoutePath>()
  for (const trip of assignment.trips) {
    const road = roadById.get(trip.key)
    if (!road) continue
    const from = plan.lots.get(road.fromObjectId)
    const to = plan.lots.get(road.toId)
    if (!from || !to) continue
    // The assigned route runs junction to junction; bookend it with the kerb each building is entered
    // from, exactly as `streetRoute` does, so the ribbon meets its doors and not the nearest corner.
    const points = dedupePoints([
      { x: from.accessX, z: from.accessZ },
      ...trip.route.path.map(point => ({ x: point.x, z: point.z })),
      { x: to.accessX, z: to.accessZ },
    ])
    const nodeIds = trip.route.nodeIds.map(id => intersectionId(id, 0))
    paths.set(trip.key, { nodeIds, points })
  }
  return paths
}
