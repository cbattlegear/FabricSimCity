import { describe, expect, it } from 'vitest'
import { liveRejectionEdges } from './cityBlocking'
import { gradeRoads, LIVE_BLOCKING_GRADE } from './cityTraffic'
import { item, route } from './operationTraffic.testkit'
import type { OperationClass, OperationSample } from './capacityCityContracts'

function sample(overrides: Partial<OperationSample> = {}): OperationSample {
  return {
    operationId: 'op:1',
    operationName: 'Warehouse Query',
    itemId: 'item:a',
    workspaceId: 'ws:1',
    operationClass: 'Interactive',
    billingType: 'Billable',
    status: 'Success',
    startedAt: '2024-01-01T00:00:00Z',
    endedAt: null,
    durationSeconds: null,
    totalCuSeconds: null,
    timepointCuSeconds: null,
    throttlingSeconds: null,
    smoothingStart: null,
    smoothingEnd: null,
    user: null,
    ...overrides,
  }
}

function rejected(itemId: string, operationClass: OperationClass = 'Interactive', id = 'op'): OperationSample {
  return sample({ operationId: `${id}:${itemId}`, itemId, operationClass, status: 'Rejected' })
}

const items = [item('item:a', 'ws:1', 0, 0), item('item:b', 'ws:1', 0, 1)]

describe('liveRejectionEdges · a source that cannot see operations withholds the layer', () => {
  it('reports "unsupported" when the source cannot report operation samples', () => {
    // The Eventhouse feed reports operationSamples: false and returns an empty array rather than
    // throwing. An empty list from it is "cannot see rejections", not "nothing was rejected".
    const summary = liveRejectionEdges([rejected('item:a')], items, { operationSamples: false })
    expect(summary.state).toBe('unsupported')
    expect(summary.edges).toEqual([])
    expect(summary.items).toEqual([])
  })

  it('reports "none" when the source can report samples and none were rejected', () => {
    const summary = liveRejectionEdges([sample({ status: 'Success' })], items, { operationSamples: true })
    expect(summary.state).toBe('none')
    expect(summary.edges).toEqual([])
  })

  it('treats a null sample list from a capable source as measured-quiet, not unsupported', () => {
    const summary = liveRejectionEdges(null, items, { operationSamples: true })
    expect(summary.state).toBe('none')
    expect(summary.edges).toEqual([])
  })
})

describe('liveRejectionEdges · only a rejection is an edge', () => {
  it('resolves a rejected operation onto the loaded item it names', () => {
    const summary = liveRejectionEdges([rejected('item:a')], items, { operationSamples: true })
    expect(summary.state).toBe('measured')
    expect(summary.edges).toEqual([{ objectKey: 'item:a', blockedSessionCount: 1 }])
    expect(summary.items[0]).toMatchObject({ itemId: 'item:a', interactiveRejections: 1, totalRejections: 1 })
  })

  it('does not treat a delayed-but-succeeded operation as a rejection', () => {
    // An interactive operation that queued at the delay gate and then completed carries
    // status 'Success' with non-zero throttlingSeconds. A delay is a busy city, not a broken one,
    // and must never grade a road the way a rejection does. This is the severity ladder at source.
    const delayed = sample({ status: 'Success', throttlingSeconds: 20, operationClass: 'Interactive' })
    const summary = liveRejectionEdges([delayed], items, { operationSamples: true })
    expect(summary.state).toBe('none')
    expect(summary.edges).toEqual([])
  })

  it('splits rejections by the class that decides which gate refused them', () => {
    const summary = liveRejectionEdges(
      [rejected('item:a', 'Interactive', 'i'), rejected('item:a', 'Background', 'b'), rejected('item:a', 'Unknown', 'u')],
      items,
      { operationSamples: true },
    )
    expect(summary.items[0]).toMatchObject({
      itemId: 'item:a',
      interactiveRejections: 1,
      backgroundRejections: 1,
      unknownClassRejections: 1,
      totalRejections: 3,
    })
  })

  it('counts a rejection off this bounded page instead of pinning it to the wrong lot', () => {
    const summary = liveRejectionEdges([rejected('item:elsewhere')], items, { operationSamples: true })
    expect(summary.state).toBe('measured')
    expect(summary.edges).toEqual([])
    expect(summary.offPageCount).toBe(1)
  })

  it('sums rejections on the same item and sorts busiest first', () => {
    const summary = liveRejectionEdges(
      [rejected('item:b', 'Interactive', '1'), rejected('item:a', 'Interactive', '2'), rejected('item:a', 'Interactive', '3')],
      items,
      { operationSamples: true },
    )
    expect(summary.edges).toEqual([
      { objectKey: 'item:a', blockedSessionCount: 2 },
      { objectKey: 'item:b', blockedSessionCount: 1 },
    ])
  })
})

describe('liveRejectionEdges · the wire into gradeRoads survives', () => {
  it('upgrades a road whose endpoint has a live rejection to the blocking grade', () => {
    const roads = gradeRoads([route('item:a', 'item:b')], [], liveRejectionEdges([rejected('item:a')], items, { operationSamples: true }).edges)
    expect(roads[0].grade).toBe(LIVE_BLOCKING_GRADE)
  })

  it('leaves a road ungraded by blocking when no endpoint was rejected', () => {
    const roads = gradeRoads([route('item:a', 'item:b')], [], liveRejectionEdges([], items, { operationSamples: true }).edges)
    expect(roads[0].grade).not.toBe(LIVE_BLOCKING_GRADE)
  })
})
