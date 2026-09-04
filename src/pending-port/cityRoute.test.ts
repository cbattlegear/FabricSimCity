import { describe, expect, it } from 'vitest'
import type { Evidence } from '../fabricContracts'
import type { NormalizedShowplan, ShowplanNode } from '../fabricContracts'
import type { CapacityCityItem } from '../capacityCityContracts'
import { STREET_WIDTH, planCity } from './cityPlan'
import { distanceToStreetNetwork } from '../cityPlan.testkit'
import {
  buildCityRoute,
  facilityForOperator,
  matchObject,
  operatorSequence,
  planStops,
  routeThroughStreets,
  unquote,
  type RouteContext,
} from './cityRoute'

const evidence: Evidence = {
  source: 'CatalogSnapshot',
  status: 'Available',
  observedAt: null,
  freshUntil: null,
  reason: 'test',
}

function object(
  itemId: string,
  workspaceName: string,
  name: string,
  neighborhoodOrdinal: number,
  itemOrdinal: number,
): CapacityCityItem {
  return {
    itemId,
    workspaceId: `schema:${workspaceName}`,
    workspaceName,
    name,
    kind: 'Table',
    storageBytes: '4096',
    cuSecondsRaw: '4000',
    reservedBytes: null,
    usedBytes: null,
    sizeStatus: 'Known',
    sizeReason: null,
    layout: { neighborhoodOrdinal, itemOrdinal, x: 0, z: 0 },
    indexes: [],
    directActivity: { totalOperations: null, resetEpochToken: null, evidence },
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

function node(overrides: Partial<ShowplanNode> & { nodeId: number }): ShowplanNode {
  return {
    parentNodeId: null,
    logicalOperation: 'Compute Scalar',
    physicalOperation: 'Compute Scalar',
    estimatedRows: 1,
    estimatedCpuCost: 0.0001,
    estimatedIoCost: 0,
    estimatedTotalSubtreeCost: 0.1,
    parallel: false,
    objectReference: null,
    predicate: null,
    warnings: [],
    ...overrides,
  }
}

function showplan(nodes: ShowplanNode[], overrides: Partial<NormalizedShowplan> = {}): NormalizedShowplan {
  return {
    planId: 'plan:1',
    showplanVersion: '1.539',
    cardinalityEstimatorVersion: '160',
    serialDesiredMemoryKiB: 1024,
    serialRequiredMemoryKiB: 512,
    optimization: 'None',
    dispatcherExpression: null,
    structuralFingerprint: 'fp',
    runtimeOverlayCaveat: 'Compiled plan shape only; never actual operator progress.',
    nodes,
    ...overrides,
  }
}

const objects = [
  object('object:dbo:1', 'dbo', 'Customer', 0, 0),
  object('object:dbo:2', 'dbo', 'OrderHeader', 0, 1),
  object('object:sales:3', 'sales', 'Invoice', 1, 0),
]

function context(overrides: Partial<RouteContext> = {}): RouteContext {
  const plan = planCity(objects, { seed: 'db:sales' })
  return {
    plan,
    objects,
    databaseName: 'sales',
    ...overrides,
  }
}

describe('operatorSequence', () => {
  it('walks children before parents so the route follows data flow', () => {
    const nodes = [
      node({ nodeId: 0 }),
      node({ nodeId: 1, parentNodeId: 0 }),
      node({ nodeId: 2, parentNodeId: 0 }),
      node({ nodeId: 3, parentNodeId: 1 }),
    ]
    expect(operatorSequence(nodes).map(n => n.nodeId)).toEqual([3, 1, 2, 0])
  })

  it('is independent of input row order', () => {
    const nodes = [
      node({ nodeId: 3, parentNodeId: 1 }),
      node({ nodeId: 0 }),
      node({ nodeId: 2, parentNodeId: 0 }),
      node({ nodeId: 1, parentNodeId: 0 }),
    ]
    expect(operatorSequence(nodes).map(n => n.nodeId)).toEqual([3, 1, 2, 0])
  })

  it('never loses an operator, even with a broken parent link', () => {
    const nodes = [
      node({ nodeId: 0 }),
      node({ nodeId: 1, parentNodeId: 99 }),
      node({ nodeId: 2, parentNodeId: 0 }),
    ]
    expect(operatorSequence(nodes)).toHaveLength(3)
  })

  it('handles an empty plan', () => {
    expect(operatorSequence([])).toEqual([])
  })
})

describe('unquote and matchObject', () => {
  it('strips showplan bracket quoting', () => {
    expect(unquote('[dbo]')).toBe('dbo')
    expect(unquote('dbo')).toBe('dbo')
    expect(unquote('  ')).toBeNull()
    expect(unquote(null)).toBeNull()
  })

  it('matches bracketed, case-varying references', () => {
    const matched = matchObject(
      { database: '[sales]', schema: '[DBO]', table: '[customer]', index: '[IX]' },
      objects,
      'sales',
    )
    expect(matched?.itemId).toBe('object:dbo:1')
  })

  it('refuses to match a reference from another database', () => {
    const matched = matchObject(
      { database: '[warehouse]', schema: '[dbo]', table: '[Customer]', index: null },
      objects,
      'sales',
    )
    expect(matched).toBeNull()
  })

  it('returns null for an object outside the loaded page', () => {
    expect(
      matchObject({ database: null, schema: '[dbo]', table: '[Missing]', index: null }, objects, 'sales'),
    ).toBeNull()
  })
})

describe('facilityForOperator', () => {
  it('marks memory-granting operators as leaning on the Memory Grant Office', () => {
    expect(facilityForOperator(node({ nodeId: 1, physicalOperation: 'Sort' }))).toBe('memory')
    expect(facilityForOperator(node({ nodeId: 1, physicalOperation: 'Hash Match' }))).toBe('memory')
  })

  it('marks spools as leaning on tempdb Works', () => {
    expect(facilityForOperator(node({ nodeId: 1, physicalOperation: 'Table Spool' }))).toBe('tempdb')
  })

  it('marks I/O-costed operators as leaning on the Storage & I/O Depot', () => {
    expect(
      facilityForOperator(node({ nodeId: 1, physicalOperation: 'Remote Scan', estimatedIoCost: 0.5 })),
    ).toBe('storage')
  })

  it('marks pure compute as leaning on the CPU Scheduler Yard', () => {
    expect(facilityForOperator(node({ nodeId: 1, physicalOperation: 'Compute Scalar' }))).toBe('cpu')
  })
})

describe('planStops', () => {
  it('stops at every table the plan reads, and at nothing else', () => {
    const stops = planStops(
      showplan([
        node({ nodeId: 0, physicalOperation: 'Hash Match', parentNodeId: null }),
        node({
          nodeId: 1,
          parentNodeId: 0,
          physicalOperation: 'Clustered Index Seek',
          objectReference: { database: '[sales]', schema: '[dbo]', table: '[Customer]', index: '[PK_Customer]' },
        }),
        node({
          nodeId: 2,
          parentNodeId: 0,
          physicalOperation: 'Index Scan',
          objectReference: { database: '[sales]', schema: '[dbo]', table: '[OrderHeader]', index: null },
        }),
      ]),
      context(),
    )
    expect(stops).toHaveLength(2)
    expect(stops.map(s => s.ordinal)).toEqual([1, 2])
    expect(stops.map(s => s.itemId)).toEqual(['object:dbo:1', 'object:dbo:2'])
    for (const stop of stops) expect(stop.kind).toBe('building')
  })

  it('drops no operator: a join is listed at the table it drew from', () => {
    const route = buildCityRoute(
      showplan([
        node({ nodeId: 0, physicalOperation: 'Hash Match', estimatedCpuCost: 4, estimatedIoCost: 0 }),
        node({
          nodeId: 1,
          parentNodeId: 0,
          physicalOperation: 'Clustered Index Seek',
          estimatedCpuCost: 9,
          estimatedIoCost: 0,
          objectReference: { database: null, schema: '[dbo]', table: '[Customer]', index: null },
        }),
        node({
          nodeId: 2,
          parentNodeId: 0,
          physicalOperation: 'Index Scan',
          estimatedCpuCost: 1,
          estimatedIoCost: 0,
          objectReference: { database: null, schema: '[dbo]', table: '[OrderHeader]', index: null },
        }),
      ]),
      context(),
    )
    const listed = route.stops.flatMap(stop => stop.operations.map(op => op.nodeId))
    expect(listed.concat(route.unplacedOperations.map(op => op.nodeId)).sort()).toEqual([0, 1, 2])
    // The join folds onto the heavier of its two inputs rather than becoming a place of its own.
    const customer = route.stops.find(stop => stop.itemId === 'object:dbo:1')!
    expect(customer.operations.map(op => op.physicalOperation)).toContain('Hash Match')
  })

  it('never emits a facility stop, so the route does not detour to the CPU yard', () => {
    const route = buildCityRoute(
      showplan([
        node({ nodeId: 0, physicalOperation: 'Sort' }),
        node({
          nodeId: 1,
          parentNodeId: 0,
          objectReference: { database: null, schema: '[dbo]', table: '[Customer]', index: null },
        }),
      ]),
      context(),
    )
    for (const stop of route.stops) expect(['building', 'offmap']).toContain(stop.kind)
    expect(route.stops.every(stop => stop.itemId !== null || stop.kind === 'offmap')).toBe(true)
  })

  it('records the resource an operator leans on without giving it a place', () => {
    const route = buildCityRoute(
      showplan([
        node({ nodeId: 0, physicalOperation: 'Sort' }),
        node({
          nodeId: 1,
          parentNodeId: 0,
          objectReference: { database: null, schema: '[dbo]', table: '[Customer]', index: null },
        }),
      ]),
      context(),
    )
    const sort = route.stops[0].operations.find(op => op.physicalOperation === 'Sort')!
    expect(sort.resource).toBe('memory')
    expect(sort.readsHere).toBe(false)
  })

  it('places a matched object at its building access point and names the index', () => {
    const ctx = context()
    const [stop] = planStops(
      showplan([
        node({
          nodeId: 0,
          physicalOperation: 'Clustered Index Seek',
          estimatedRows: 100,
          objectReference: { database: null, schema: '[dbo]', table: '[Customer]', index: '[PK_Customer]' },
        }),
      ]),
      ctx,
    )
    const lot = ctx.plan.lots.get('object:dbo:1')
    expect(stop.kind).toBe('building')
    expect(stop.itemId).toBe('object:dbo:1')
    expect(stop.indexNames).toEqual(['PK_Customer'])
    expect(stop.x).toBe(lot?.accessX)
    expect(stop.z).toBe(lot?.accessZ)
    expect(stop.instruction).toContain('dbo.Customer')
    expect(stop.instruction).toContain('PK_Customer')
    expect(stop.operations[0].instruction).toContain('100')
  })

  it('merges two reads of one table into a single stop', () => {
    const stops = planStops(
      showplan([
        node({ nodeId: 0, physicalOperation: 'Nested Loops' }),
        node({
          nodeId: 1,
          parentNodeId: 0,
          physicalOperation: 'Index Seek',
          objectReference: { database: null, schema: '[dbo]', table: '[Customer]', index: '[IX_A]' },
        }),
        node({
          nodeId: 2,
          parentNodeId: 0,
          physicalOperation: 'Key Lookup',
          objectReference: { database: null, schema: '[dbo]', table: '[Customer]', index: '[PK_Customer]' },
        }),
      ]),
      context(),
    )
    expect(stops).toHaveLength(1)
    expect(stops[0].indexNames).toEqual(['IX_A', 'PK_Customer'])
    expect(stops[0].operations).toHaveLength(3)
  })

  it('reports an unmatched reference as an off-map stop with a reason, never dropping it', () => {
    const route = buildCityRoute(
      showplan([
        node({
          nodeId: 0,
          physicalOperation: 'Index Scan',
          objectReference: { database: '[warehouse]', schema: '[dbo]', table: '[Fact]', index: null },
        }),
      ]),
      context(),
    )
    expect(route.stops).toHaveLength(1)
    expect(route.offMapStops).toHaveLength(1)
    expect(route.offMapStops[0].kind).toBe('offmap')
    expect(route.offMapStops[0].unresolvedReason).toContain('warehouse')
    expect(route.offMapStops[0].x).toBeNull()
  })

  it('explains an object that is simply not on the loaded page', () => {
    const [stop] = planStops(
      showplan([
        node({
          nodeId: 0,
          objectReference: { database: null, schema: '[dbo]', table: '[NotLoaded]', index: null },
        }),
      ]),
      context(),
    )
    expect(stop.unresolvedReason).toContain('not in the currently loaded page')
  })

  it('carries the plan-level memory grant onto the operation that wanted it', () => {
    const route = buildCityRoute(
      showplan(
        [
          node({ nodeId: 0, physicalOperation: 'Sort' }),
          node({
            nodeId: 1,
            parentNodeId: 0,
            objectReference: { database: null, schema: '[dbo]', table: '[Customer]', index: null },
          }),
        ],
        { serialDesiredMemoryKiB: 4096 },
      ),
      context(),
    )
    const sort = route.stops[0].operations.find(op => op.physicalOperation === 'Sort')!
    expect(sort.instruction).toContain('4,096 KiB')
  })

  it('says the grant is unreported rather than inventing a number', () => {
    const route = buildCityRoute(
      showplan(
        [
          node({ nodeId: 0, physicalOperation: 'Sort' }),
          node({
            nodeId: 1,
            parentNodeId: 0,
            objectReference: { database: null, schema: '[dbo]', table: '[Customer]', index: null },
          }),
        ],
        { serialDesiredMemoryKiB: null },
      ),
      context(),
    )
    const sort = route.stops[0].operations.find(op => op.physicalOperation === 'Sort')!
    expect(sort.instruction).toContain('unreported')
  })

  it('lists an operator belonging to no table rather than dropping or placing it', () => {
    const route = buildCityRoute(
      showplan([node({ nodeId: 0, physicalOperation: 'Compute Scalar' })]),
      context(),
    )
    expect(route.stops).toHaveLength(0)
    expect(route.unplacedOperations.map(op => op.nodeId)).toEqual([0])
  })

  it('surfaces operator warnings on the stop the operator belongs to', () => {
    const [stop] = planStops(
      showplan([
        node({ nodeId: 0, physicalOperation: 'Sort' }),
        node({
          nodeId: 1,
          parentNodeId: 0,
          objectReference: { database: null, schema: '[dbo]', table: '[Customer]', index: null },
          warnings: [{ kind: 'SpillToTempDb', detail: 'level 2' }, { kind: 'NoJoinPredicate', detail: null }],
        }),
      ]),
      context(),
    )
    expect(stop.warnings).toEqual(['SpillToTempDb: level 2', 'NoJoinPredicate'])
  })

  it('splits the estimated cost across its stops without exceeding the whole', () => {
    const route = buildCityRoute(
      showplan([
        node({ nodeId: 0, physicalOperation: 'Hash Match', estimatedCpuCost: 2, estimatedIoCost: 0 }),
        node({
          nodeId: 1,
          parentNodeId: 0,
          estimatedCpuCost: 6,
          estimatedIoCost: 0,
          objectReference: { database: null, schema: '[dbo]', table: '[Customer]', index: null },
        }),
        node({
          nodeId: 2,
          parentNodeId: 0,
          estimatedCpuCost: 2,
          estimatedIoCost: 0,
          objectReference: { database: null, schema: '[dbo]', table: '[OrderHeader]', index: null },
        }),
      ]),
      context(),
    )
    const total = route.stops.reduce((sum, stop) => sum + stop.estimatedCostShare, 0)
    expect(total).toBeCloseTo(1, 6)
    expect(route.estimatedCostUnattributed).toBeCloseTo(0, 6)
    expect(route.stops.find(s => s.itemId === 'object:dbo:1')!.estimatedCostShare).toBeCloseTo(0.75, 6)
  })

  it('reports the estimated cost that reached no building on this map', () => {
    const route = buildCityRoute(
      showplan([
        node({ nodeId: 0, physicalOperation: 'Concatenation', estimatedCpuCost: 0, estimatedIoCost: 0 }),
        node({
          nodeId: 1,
          parentNodeId: 0,
          estimatedCpuCost: 5,
          estimatedIoCost: 0,
          objectReference: { database: null, schema: '[dbo]', table: '[Customer]', index: null },
        }),
        node({
          nodeId: 2,
          parentNodeId: 0,
          estimatedCpuCost: 5,
          estimatedIoCost: 0,
          objectReference: { database: '[warehouse]', schema: '[dbo]', table: '[Fact]', index: null },
        }),
      ]),
      context(),
    )
    expect(route.estimatedCostUnattributed).toBeCloseTo(0.5, 6)
  })
})

describe('routeThroughStreets', () => {
  it('produces a continuous polyline that stays on the street network', () => {
    const ctx = context()
    const stops = planStops(
      showplan([
        node({ nodeId: 0, physicalOperation: 'Hash Match' }),
        node({
          nodeId: 1,
          parentNodeId: 0,
          objectReference: { database: null, schema: '[dbo]', table: '[Customer]', index: null },
        }),
        node({
          nodeId: 2,
          parentNodeId: 0,
          objectReference: { database: null, schema: '[sales]', table: '[Invoice]', index: null },
        }),
      ]),
      ctx,
    )
    const line = routeThroughStreets(stops, ctx.plan)
    expect(line.length).toBeGreaterThan(1)
    // No zero-length segment: every vertex advances the journey.
    for (let i = 1; i < line.length; i += 1) {
      expect(Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z)).toBeGreaterThan(1e-9)
    }
    // The route drives on roads rather than across the blocks. This used to be asserted as
    // "axis-aligned", which only held while every road was. Endpoints are excused because a stop sits
    // at its building's kerb, deliberately half a street width off the centre line.
    for (let i = 1; i < line.length - 1; i += 1) {
      expect(distanceToStreetNetwork(ctx.plan, line[i])).toBeLessThanOrEqual(STREET_WIDTH)
    }
  })

  it('returns an empty polyline when nothing could be placed', () => {
    const ctx = context()
    const stops = planStops(
      showplan([
        node({
          nodeId: 0,
          objectReference: { database: '[warehouse]', schema: '[dbo]', table: '[Fact]', index: null },
        }),
      ]),
      ctx,
    )
    expect(routeThroughStreets(stops, ctx.plan)).toEqual([])
  })
})

describe('buildCityRoute', () => {
  it('copies the runtime overlay caveat verbatim', () => {
    const plan = showplan([node({ nodeId: 0 })])
    expect(buildCityRoute(plan, context()).runtimeOverlayCaveat).toBe(plan.runtimeOverlayCaveat)
  })

  it('is deterministic for the same plan', () => {
    const plan = showplan([
      node({ nodeId: 0, physicalOperation: 'Sort' }),
      node({
        nodeId: 1,
        parentNodeId: 0,
        objectReference: { database: null, schema: '[dbo]', table: '[Customer]', index: null },
      }),
    ])
    const first = buildCityRoute(plan, context())
    const second = buildCityRoute(plan, context())
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })
})
