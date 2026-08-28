import { describe, expect, it } from 'vitest'
import { planCity, type CityPlanOptions } from './cityPlan'
import { assignQueryRoutes } from './cityQueryTraffic'
import type { RoadTraffic } from './cityTraffic'
import type { DatabaseCityObject, DatabaseCitySchema } from './databaseCityContracts'
import type { Evidence } from './contracts'

const evidence: Evidence = {
  source: 'CatalogSnapshot',
  status: 'Available',
  observedAt: null,
  freshUntil: null,
  reason: 'test',
}

function object(objectId: string, schemaId: string, neighborhoodOrdinal: number, objectOrdinal: number): DatabaseCityObject {
  return {
    objectId,
    schemaId,
    schemaName: schemaId.replace('schema:', ''),
    name: objectId,
    kind: 'Table',
    reservedPages8KiB: '4096',
    usedPages8KiB: '2048',
    reservedBytes: String(4096n * 8192n),
    usedBytes: String(2048n * 8192n),
    sizeStatus: 'Known',
    sizeReason: null,
    layout: { neighborhoodOrdinal, objectOrdinal, x: 0, z: 0 },
    indexes: [],
    directActivity: { totalOperations: '1', resetEpochToken: null, evidence },
    attributedExposure: {
      executionCount: null,
      totalCpuMicroseconds: null,
      totalDurationMicroseconds: null,
      totalLogicalReads8KiBPages: null,
      confidence: 'Unknown',
      rationale: 'test',
      evidence,
    },
  }
}

function sampleCity(): DatabaseCityObject[] {
  const objects: DatabaseCityObject[] = []
  for (let index = 0; index < 11; index += 1) objects.push(object(`object:dbo:${100 + index}`, 'schema:dbo', 0, index))
  for (let index = 0; index < 5; index += 1) objects.push(object(`object:rep:${300 + index}`, 'schema:reporting', 1, index))
  return objects
}

function sampleSchemas(): DatabaseCitySchema[] {
  return [
    { schemaId: 'schema:dbo', name: 'dbo', neighborhoodOrdinal: 0, objectCount: '11', evidence },
    { schemaId: 'schema:reporting', name: 'reporting', neighborhoodOrdinal: 1, objectCount: '5', evidence },
  ]
}

function options(overrides: Partial<CityPlanOptions> = {}): CityPlanOptions {
  return { seed: 'db:sales', totalObjects: '16', schemas: sampleSchemas(), ...overrides }
}

function road(routeId: string, fromObjectId: string, toId: string, executions: number | null): RoadTraffic {
  return {
    routeId,
    fromObjectId,
    toId,
    kind: 'ObjectReference',
    confidence: 'Confirmed',
    pattern: 'solid',
    width: 2,
    grade: 'free',
    color: 0,
    executions,
    waitShare: null,
    delayPerExecution: null,
    recentExecutions: null,
    recentWindowMinutes: null,
    familyIds: [],
    rationale: 'test',
  }
}

describe('assignQueryRoutes', () => {
  const plan = planCity(sampleCity(), options())

  // Two buildings in different neighbourhoods sit far enough apart to enter the network at different
  // junctions, so this pair describes a real journey the assignment can route.
  const roads: RoadTraffic[] = [
    road('route:a', 'object:dbo:100', 'object:rep:300', 5000),
    road('route:b', 'object:dbo:101', 'object:rep:301', 1200),
    road('route:none', 'object:dbo:102', 'object:dbo:103', null),
    road('route:offmap', 'object:dbo:104', 'external:other:table', 800),
  ]

  it('routes at least one measured on-map ribbon', () => {
    const paths = assignQueryRoutes(plan, roads)
    expect(paths.size).toBeGreaterThan(0)
  })

  it('bookends every assigned path at the two buildings it joins', () => {
    const paths = assignQueryRoutes(plan, roads)
    for (const [routeId, path] of paths) {
      const source = roads.find(entry => entry.routeId === routeId)!
      const from = plan.lots.get(source.fromObjectId)!
      const to = plan.lots.get(source.toId)!
      expect(path.points.length).toBeGreaterThanOrEqual(2)
      const start = path.points[0]
      const end = path.points[path.points.length - 1]
      expect(start.x).toBeCloseTo(from.accessX, 3)
      expect(start.z).toBeCloseTo(from.accessZ, 3)
      expect(end.x).toBeCloseTo(to.accessX, 3)
      expect(end.z).toBeCloseTo(to.accessZ, 3)
    }
  })

  it('threads only real intersections', () => {
    const paths = assignQueryRoutes(plan, roads)
    for (const path of paths.values()) {
      for (const nodeId of path.nodeIds) expect(plan.intersections.has(nodeId)).toBe(true)
    }
  })

  it('spreads no traffic onto an unmeasured link', () => {
    const paths = assignQueryRoutes(plan, roads)
    expect(paths.has('route:none')).toBe(false)
  })

  it('leaves a cross-database ramp for the caller to draw', () => {
    const paths = assignQueryRoutes(plan, roads)
    expect(paths.has('route:offmap')).toBe(false)
  })

  it('is deterministic for one plan and one workload', () => {
    const first = assignQueryRoutes(plan, roads)
    const second = assignQueryRoutes(plan, roads)
    expect([...second.keys()].sort()).toEqual([...first.keys()].sort())
    for (const [routeId, path] of first) {
      expect(second.get(routeId)!.points).toEqual(path.points)
    }
  })
})
