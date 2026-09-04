/**
 * Shared assertions about the street network, used by more than one spec.
 *
 * Not a spec itself — the `.testkit.ts` suffix keeps it out of vitest's `*.test.ts` collection so
 * importing it doesn't register another file's suites a second time.
 */
import type { CityPlan } from './cityPlan'

/**
 * Shortest distance from a point to any street's drawn centre line.
 *
 * Routes used to be checked by asserting every segment was axis-aligned, which only worked while
 * every road was. Now that roads bow, follow embankments and cut diagonally, the invariant worth
 * defending is the one that assertion was always standing in for: a route drives on the road network
 * rather than across the blocks.
 */
export function distanceToStreetNetwork(plan: CityPlan, point: { x: number; z: number }): number {
  let best = Number.POSITIVE_INFINITY
  for (const street of plan.streets) {
    for (let index = 1; index < street.path.length; index += 1) {
      const a = street.path[index - 1]
      const b = street.path[index]
      const dx = b.x - a.x
      const dz = b.z - a.z
      const lengthSquared = dx * dx + dz * dz
      const t =
        lengthSquared < 1e-12
          ? 0
          : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared))
      best = Math.min(best, Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t)))
    }
  }
  return best
}
