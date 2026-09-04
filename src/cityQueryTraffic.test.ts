import { describe, expect, it } from 'vitest'
import { assignQueryRoutes } from './cityQueryTraffic'
import { gradeRoads } from './cityTraffic'
import { buildPlan, family, route } from './operationTraffic.testkit'

const plan = buildPlan()

describe('assignQueryRoutes', () => {
  it('assigns a street-following path to a measured road', () => {
    const roads = gradeRoads(
      [route('item:a:0', 'item:b:0')],
      [family({ itemIds: ['item:a:0', 'item:b:0'], operationCount: '10' })],
    )
    const paths = assignQueryRoutes(plan, roads)
    const path = paths.get(roads[0].routeId)
    expect(path).toBeDefined()
    expect(path!.points.length).toBeGreaterThanOrEqual(2)
    expect(path!.nodeIds.length).toBeGreaterThan(0)
  })

  it('does not route a road with no measured operations', () => {
    // roadVolume returns null operations for a pair no family names, so there is no measured weight to
    // spread and the ribbon is left for the plain drawer — it is never invented a path.
    const roads = gradeRoads([route('item:a:0', 'item:b:0')], [family({ itemIds: ['item:x'] })])
    expect(roads[0].operations).toBeNull()
    const paths = assignQueryRoutes(plan, roads)
    expect(paths.has(roads[0].routeId)).toBe(false)
  })

  it('does not route a road whose far endpoint left the city', () => {
    const roads = gradeRoads(
      [route('item:a:0', 'item:offmap')],
      [family({ itemIds: ['item:a:0', 'item:offmap'], operationCount: '10' })],
    )
    const paths = assignQueryRoutes(plan, roads)
    expect(paths.has(roads[0].routeId)).toBe(false)
  })
})
