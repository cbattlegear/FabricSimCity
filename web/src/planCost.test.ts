import { describe, expect, it } from 'vitest'
import {
  EMPTY_PLAN_COST,
  EMPTY_PLAN_DATA_VOLUME,
  planCostSplit,
  planDataVolumeSplit,
  referenceKey,
  unquote,
} from './planCost'
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

function bytesOf(split: ReturnType<typeof planDataVolumeSplit>, table: string): number {
  const match = split.objects.find(entry => entry.reference.table === `[${table}]`)
  return match ? match.bytes : 0
}

describe('planDataVolumeSplit', () => {
  it('sizes a leaf scan by rows times row size', () => {
    const split = planDataVolumeSplit(showplan([
      node(1, null, { objectReference: reference('Customer'), estimatedRows: 1000, estimatedRowSizeBytes: 120 }),
    ]))

    expect(split.total).toBe(120_000)
    expect(bytesOf(split, 'Customer')).toBe(120_000)
    expect(split.operatorsMeasured).toBe(1)
    expect(split.operatorsMissingRowSize).toBe(0)
  })

  it('does not count the same rows again at every operator above the scan', () => {
    // This is the rule that separates the volume split from the cost split. The sort and the filter
    // re-emit rows the scan already produced; counting them would report three times the data.
    const split = planDataVolumeSplit(showplan([
      node(1, null, { estimatedRows: 1000, estimatedRowSizeBytes: 120 }),
      node(2, 1, { estimatedRows: 1000, estimatedRowSizeBytes: 120 }),
      node(3, 2, { objectReference: reference('Customer'), estimatedRows: 1000, estimatedRowSizeBytes: 120 }),
    ]))

    expect(split.total).toBe(120_000)
    expect(split.operatorsMeasured).toBe(1)
  })

  it('does not count an operator naming no object as a missing row size', () => {
    const split = planDataVolumeSplit(showplan([
      node(1, null, { estimatedRows: 1000, estimatedRowSizeBytes: 120 }),
      node(2, 1, { objectReference: reference('Customer'), estimatedRows: 10, estimatedRowSizeBytes: 10 }),
    ]))

    expect(split.operatorsMissingRowSize).toBe(0)
  })

  it('sizes each table in a join by its own rows', () => {
    const split = planDataVolumeSplit(showplan([
      node(1, null, { estimatedRows: 5000, estimatedRowSizeBytes: 200 }),
      node(2, 1, { objectReference: reference('Customer'), estimatedRows: 1000, estimatedRowSizeBytes: 120 }),
      node(3, 1, { objectReference: reference('OrderHeader'), estimatedRows: 50, estimatedRowSizeBytes: 40 }),
    ]))

    expect(bytesOf(split, 'Customer')).toBe(120_000)
    expect(bytesOf(split, 'OrderHeader')).toBe(2_000)
    expect(split.total).toBe(122_000)
  })

  it('accumulates repeated reads of one table onto that table', () => {
    // A self-join really does read the table twice, and the bytes really do move twice.
    const split = planDataVolumeSplit(showplan([
      node(1, null, {}),
      node(2, 1, { objectReference: reference('Customer'), estimatedRows: 400, estimatedRowSizeBytes: 100 }),
      node(3, 1, { objectReference: reference('Customer'), estimatedRows: 600, estimatedRowSizeBytes: 100 }),
    ]))

    expect(split.objects).toHaveLength(1)
    expect(bytesOf(split, 'Customer')).toBe(100_000)
  })

  it('discloses a missing row size instead of counting it as zero bytes', () => {
    const split = planDataVolumeSplit(showplan([
      node(1, null, { objectReference: reference('Customer'), estimatedRows: 1000, estimatedRowSizeBytes: 120 }),
      node(2, null, { objectReference: reference('Ledger'), estimatedRows: 5_000_000 }),
    ]))

    expect(split.operatorsMissingRowSize).toBe(1)
    expect(split.total).toBe(120_000)
    expect(bytesOf(split, 'Ledger')).toBe(0)
  })

  it('discloses a missing row count the same way', () => {
    const split = planDataVolumeSplit(showplan([
      node(1, null, { objectReference: reference('Customer'), estimatedRows: 1000, estimatedRowSizeBytes: 120 }),
      node(2, null, { objectReference: reference('Ledger'), estimatedRowSizeBytes: 400 }),
    ]))

    expect(split.operatorsMissingRowSize).toBe(1)
    expect(split.total).toBe(120_000)
  })

  it('treats zero estimated rows as a real estimate rather than a gap', () => {
    const split = planDataVolumeSplit(showplan([
      node(1, null, { objectReference: reference('Customer'), estimatedRows: 1000, estimatedRowSizeBytes: 120 }),
      node(2, null, { objectReference: reference('OrderHeader'), estimatedRows: 0, estimatedRowSizeBytes: 40 }),
    ]))

    expect(split.operatorsMissingRowSize).toBe(0)
    expect(split.operatorsMeasured).toBe(2)
    expect(bytesOf(split, 'OrderHeader')).toBe(0)
  })

  it('reports no volume rather than zero when no operator stated a row size', () => {
    // Zero would put the smallest vehicle on the map for a query that may move gigabytes.
    const split = planDataVolumeSplit(showplan([
      node(1, null, { objectReference: reference('Customer'), estimatedRows: 1000 }),
      node(2, null, { objectReference: reference('OrderHeader'), estimatedRows: 50 }),
    ]))

    expect(split.operatorsMeasured).toBe(0)
    expect(split.objects).toEqual([])
    expect(split.total).toBe(0)
    expect(split.operatorsMissingRowSize).toBe(2)
  })

  it('is empty with nothing missing for a plan that names no object', () => {
    const split = planDataVolumeSplit(showplan([
      node(1, null, { estimatedRows: 1, estimatedRowSizeBytes: 8 }),
    ]))

    expect(split).toEqual(EMPTY_PLAN_DATA_VOLUME)
  })

  it('is empty for an empty plan', () => {
    expect(planDataVolumeSplit(showplan([]))).toEqual(EMPTY_PLAN_DATA_VOLUME)
  })

  it('treats negative estimates as missing rather than subtracting them', () => {
    const split = planDataVolumeSplit(showplan([
      node(1, null, { objectReference: reference('Customer'), estimatedRows: 1000, estimatedRowSizeBytes: 120 }),
      node(2, null, { objectReference: reference('Ledger'), estimatedRows: -500, estimatedRowSizeBytes: 100 }),
      node(3, null, { objectReference: reference('Audit'), estimatedRows: 500, estimatedRowSizeBytes: -100 }),
    ]))

    expect(split.total).toBe(120_000)
    expect(split.operatorsMissingRowSize).toBe(2)
  })

  it('publishes a fixed object order rather than one taken from plan shape', () => {
    const forwards = planDataVolumeSplit(showplan([
      node(1, null, { objectReference: reference('Zulu'), estimatedRows: 10, estimatedRowSizeBytes: 10 }),
      node(2, null, { objectReference: reference('Alpha'), estimatedRows: 10, estimatedRowSizeBytes: 10 }),
      node(3, null, { objectReference: reference('Mike'), estimatedRows: 10, estimatedRowSizeBytes: 10 }),
    ]))
    const backwards = planDataVolumeSplit(showplan([
      node(1, null, { objectReference: reference('Mike'), estimatedRows: 10, estimatedRowSizeBytes: 10 }),
      node(2, null, { objectReference: reference('Alpha'), estimatedRows: 10, estimatedRowSizeBytes: 10 }),
      node(3, null, { objectReference: reference('Zulu'), estimatedRows: 10, estimatedRowSizeBytes: 10 }),
    ]))

    expect(forwards.objects.map(entry => entry.reference.table)).toEqual(['[Alpha]', '[Mike]', '[Zulu]'])
    expect(backwards.objects.map(entry => entry.reference.table)).toEqual(
      forwards.objects.map(entry => entry.reference.table),
    )
  })

  it('keeps the total equal to the sum of the published objects', () => {
    const split = planDataVolumeSplit(showplan([
      node(1, null, { objectReference: reference('Customer'), estimatedRows: 1000, estimatedRowSizeBytes: 120 }),
      node(2, null, { objectReference: reference('OrderHeader'), estimatedRows: 50, estimatedRowSizeBytes: 40 }),
      node(3, null, { objectReference: reference('Audit'), estimatedRows: 7, estimatedRowSizeBytes: 3 }),
    ]))

    expect(split.objects.reduce((sum, entry) => sum + entry.bytes, 0)).toBe(split.total)
  })

  it('agrees with the collector on an index being its own object', () => {
    // The city draws indexes as their own structures, so an index seek's bytes must not be folded
    // into the base table's.
    const split = planDataVolumeSplit(showplan([
      node(1, null, { objectReference: reference('Customer'), estimatedRows: 10, estimatedRowSizeBytes: 100 }),
      node(2, null, {
        objectReference: reference('Customer', '[IX_Customer_Name]'),
        estimatedRows: 10,
        estimatedRowSizeBytes: 20,
      }),
    ]))

    expect(split.objects).toHaveLength(2)
    expect(split.total).toBe(1_200)
  })
})
