import { describe, expect, it } from 'vitest'
import { EMPTY_PLAN_COST, planCostSplit, referenceKey, unquote } from './planCost'
import type { NormalizedShowplan, ShowplanNode, ShowplanObjectReference } from './contracts'

function reference(table: string, index: string | null = null): ShowplanObjectReference {
  return { database: '[sales]', schema: '[dbo]', table: `[${table}]`, index }
}

function node(
  nodeId: number,
  parentNodeId: number | null,
  overrides: Partial<ShowplanNode> = {},
): ShowplanNode {
  return {
    nodeId,
    parentNodeId,
    logicalOperation: 'Op',
    physicalOperation: 'Op',
    estimatedRows: null,
    estimatedCpuCost: null,
    estimatedIoCost: null,
    estimatedTotalSubtreeCost: null,
    parallel: false,
    objectReference: null,
    predicate: null,
    warnings: [],
    ...overrides,
  }
}

function showplan(nodes: ShowplanNode[]): NormalizedShowplan {
  return {
    planId: 'plan:1',
    showplanVersion: '1.0',
    cardinalityEstimatorVersion: null,
    serialDesiredMemoryKiB: null,
    serialRequiredMemoryKiB: null,
    optimization: 'None',
    dispatcherExpression: null,
    structuralFingerprint: 'fingerprint',
    runtimeOverlayCaveat: '',
    nodes,
  }
}

function costOf(split: ReturnType<typeof planCostSplit>, table: string): number {
  const match = split.objects.find(entry => entry.reference.table === `[${table}]`)
  return match ? match.cost : 0
}

describe('unquote', () => {
  it('strips showplan brackets', () => {
    expect(unquote('[dbo]')).toBe('dbo')
  })

  it('leaves an unbracketed name alone', () => {
    expect(unquote('dbo')).toBe('dbo')
  })

  it('treats blank and null as absent', () => {
    expect(unquote('   ')).toBeNull()
    expect(unquote(null)).toBeNull()
  })
})

describe('referenceKey', () => {
  it('merges two spellings of the same object', () => {
    const bracketed: ShowplanObjectReference = {
      database: '[sales]',
      schema: '[dbo]',
      table: '[Orders]',
      index: null,
    }
    const bare: ShowplanObjectReference = {
      database: 'sales',
      schema: 'dbo',
      table: 'orders',
      index: null,
    }
    expect(referenceKey(bracketed)).toBe(referenceKey(bare))
  })

  it('keeps two indexes on one table apart', () => {
    expect(referenceKey(reference('Orders', '[IX_A]'))).not.toBe(
      referenceKey(reference('Orders', '[IX_B]')),
    )
  })
})

describe('planCostSplit', () => {
  it('returns nothing for an empty plan', () => {
    expect(planCostSplit(showplan([]))).toBe(EMPTY_PLAN_COST)
  })

  it('keeps a leaf scan\u2019s own cost on the object it reads', () => {
    const split = planCostSplit(
      showplan([
        node(1, null, { estimatedCpuCost: 0.5, estimatedIoCost: 1.5, objectReference: reference('Orders') }),
      ]),
    )
    expect(split.total).toBeCloseTo(2, 9)
    expect(costOf(split, 'Orders')).toBeCloseTo(2, 9)
    expect(split.unattributed).toBe(0)
  })

  it('pushes a join\u2019s cost down in proportion to what its inputs cost', () => {
    const split = planCostSplit(
      showplan([
        node(0, null, { estimatedCpuCost: 4 }),
        node(1, 0, { estimatedCpuCost: 3, objectReference: reference('Orders') }),
        node(2, 0, { estimatedCpuCost: 1, objectReference: reference('Customers') }),
      ]),
    )
    expect(split.total).toBeCloseTo(8, 9)
    expect(costOf(split, 'Orders')).toBeCloseTo(6, 9)
    expect(costOf(split, 'Customers')).toBeCloseTo(2, 9)
  })

  it('never sums the cumulative subtree cost', () => {
    // Every operator also reports a subtree total; adding those would claim far more than the plan cost.
    const split = planCostSplit(
      showplan([
        node(0, null, { estimatedCpuCost: 1, estimatedTotalSubtreeCost: 10 }),
        node(1, 0, { estimatedCpuCost: 2, estimatedTotalSubtreeCost: 9, objectReference: reference('Orders') }),
        node(2, 1, { estimatedCpuCost: 7, estimatedTotalSubtreeCost: 7, objectReference: reference('Orders') }),
      ]),
    )
    expect(split.total).toBeCloseTo(10, 9)
  })

  it('falls back to subtree deltas when no operator reports cpu or io', () => {
    const split = planCostSplit(
      showplan([
        node(0, null, { estimatedTotalSubtreeCost: 10 }),
        node(1, 0, { estimatedTotalSubtreeCost: 6, objectReference: reference('Orders') }),
        node(2, 0, { estimatedTotalSubtreeCost: 2, objectReference: reference('Customers') }),
      ]),
    )
    // Root keeps 10 - 8 = 2, pushed down 6:2.
    expect(split.total).toBeCloseTo(10, 9)
    expect(costOf(split, 'Orders')).toBeCloseTo(7.5, 9)
    expect(costOf(split, 'Customers')).toBeCloseTo(2.5, 9)
  })

  it('leaves compute over no object unattributed', () => {
    const split = planCostSplit(showplan([node(0, null, { estimatedCpuCost: 3 })]))
    expect(split.unattributed).toBeCloseTo(3, 9)
    expect(split.objects).toHaveLength(0)
  })

  it('keeps an off-object branch\u2019s cost out of the objects beside it', () => {
    const split = planCostSplit(
      showplan([
        node(0, null, {}),
        node(1, 0, { estimatedCpuCost: 4, objectReference: reference('Orders') }),
        node(2, 0, { estimatedCpuCost: 6 }),
      ]),
    )
    expect(costOf(split, 'Orders')).toBeCloseTo(4, 9)
    expect(split.unattributed).toBeCloseTo(6, 9)
  })

  it('divides an expensive operator evenly over free reads below it', () => {
    const split = planCostSplit(
      showplan([
        node(0, null, { estimatedCpuCost: 8 }),
        node(1, 0, { objectReference: reference('Orders') }),
        node(2, 0, { objectReference: reference('Customers') }),
      ]),
    )
    expect(costOf(split, 'Orders')).toBeCloseTo(4, 9)
    expect(costOf(split, 'Customers')).toBeCloseTo(4, 9)
    expect(split.unattributed).toBe(0)
  })

  it('takes the unattributed pool\u2019s share when pushing down over a half-attributed subtree', () => {
    const split = planCostSplit(
      showplan([
        node(0, null, { estimatedCpuCost: 10 }),
        node(1, 0, { estimatedCpuCost: 5, objectReference: reference('Orders') }),
        node(2, 0, { estimatedCpuCost: 5 }),
      ]),
    )
    expect(costOf(split, 'Orders')).toBeCloseTo(10, 9)
    expect(split.unattributed).toBeCloseTo(10, 9)
  })

  it('loses no cost when parent links form a cycle', () => {
    const split = planCostSplit(
      showplan([
        node(1, 2, { estimatedCpuCost: 3, objectReference: reference('Orders') }),
        node(2, 1, { estimatedCpuCost: 5, objectReference: reference('Customers') }),
      ]),
    )
    expect(split.total).toBeCloseTo(8, 9)
  })

  it('publishes objects in a stable order whatever order the nodes arrive in', () => {
    const nodes = [
      node(0, null, { estimatedCpuCost: 1 }),
      node(1, 0, { estimatedCpuCost: 2, objectReference: reference('Zebra') }),
      node(2, 0, { estimatedCpuCost: 3, objectReference: reference('Alpha') }),
    ]
    const forwards = planCostSplit(showplan(nodes)).objects.map(entry => entry.reference.table)
    const backwards = planCostSplit(showplan([...nodes].reverse())).objects.map(
      entry => entry.reference.table,
    )
    expect(forwards).toEqual(backwards)
    expect(forwards).toEqual(['[Alpha]', '[Zebra]'])
  })

  it('merges two operators that read the same object', () => {
    const split = planCostSplit(
      showplan([
        node(0, null, {}),
        node(1, 0, { estimatedCpuCost: 2, objectReference: reference('Orders') }),
        node(2, 0, { estimatedCpuCost: 3, objectReference: reference('Orders') }),
      ]),
    )
    expect(split.objects).toHaveLength(1)
    expect(costOf(split, 'Orders')).toBeCloseTo(5, 9)
  })

  it('returns nothing when a plan carries no cost estimate at all', () => {
    const split = planCostSplit(
      showplan([node(0, null, { objectReference: reference('Orders') })]),
    )
    expect(split).toBe(EMPTY_PLAN_COST)
  })
})
