import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { CapacityTimepoint } from './capacityCityContracts'
import type { CapacitySource, TimepointRequest } from './collect/source'
import { TIMEPOINT_SECONDS } from './fabricContracts'
import { startTimepointClock } from './timepointClock'
import type { TimepointFeed } from './timepointFeed'

const BASE = Date.parse('2024-05-01T00:10:00Z')

function tp(atMs: number): CapacityTimepoint {
  return {
    timepoint: new Date(atMs).toISOString(),
    cuLimit: null,
    interactiveBillablePercent: null,
    backgroundBillablePercent: null,
    interactiveNonBillablePercent: null,
    backgroundNonBillablePercent: null,
    interactiveDelayPercent: null,
    interactiveRejectionPercent: null,
    backgroundRejectionPercent: null,
    carryOverAddPercent: null,
    carryOverBurndownPercent: null,
    cumulativeCarryOverPercent: null,
    expectedBurndownMinutes: null,
  }
}

interface FakeSourceOptions {
  timepoints: boolean
  latencySeconds: number
  read?: (request: TimepointRequest) => Promise<CapacityTimepoint[]>
}

function fakeSource(options: FakeSourceOptions): {
  source: CapacitySource
  readMock: ReturnType<typeof vi.fn>
} {
  const readMock = vi.fn(
    options.read
      // The newest landed timepoint sits `latencySeconds` behind the current clock by default.
      ?? (async () => [tp(Date.now() - options.latencySeconds * 1000)]),
  )
  const source = {
    kind: 'Fixture',
    capabilities: {
      perItemBreakdown: true,
      operationFamilies: true,
      operationSamples: true,
      timepoints: options.timepoints,
      latencySeconds: options.latencySeconds,
      retentionDays: 14,
    },
    readTimepoints: readMock,
  } as unknown as CapacitySource
  return { source, readMock }
}

let errorSpy: MockInstance<(...args: unknown[]) => void>

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(BASE)
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  errorSpy.mockRestore()
})

describe('a source without the capability schedules no loop', () => {
  it('emits one unsupported feed and never reads or polls', async () => {
    const { source, readMock } = fakeSource({ timepoints: false, latencySeconds: 0 })
    const feeds: TimepointFeed[] = []
    const dispose = startTimepointClock({ source, capacityId: 'c1', onFeed: f => feeds.push(f) })

    expect(feeds).toHaveLength(1)
    expect(feeds[0].state).toBe('unsupported')
    expect(readMock).not.toHaveBeenCalled()

    // Nothing is scheduled: advancing the clock a long way does no further work.
    await vi.advanceTimersByTimeAsync(TIMEPOINT_SECONDS * 1000 * 100)
    expect(readMock).not.toHaveBeenCalled()
    expect(feeds).toHaveLength(1)
    dispose()
  })
})

describe('a capable source polls on the derived cadence', () => {
  it('polls immediately and reports a measured, aged feed', async () => {
    const { source, readMock } = fakeSource({ timepoints: true, latencySeconds: 90 })
    const feeds: TimepointFeed[] = []
    const dispose = startTimepointClock({ source, capacityId: 'c1', onFeed: f => feeds.push(f) })

    await vi.advanceTimersByTimeAsync(0)
    expect(readMock).toHaveBeenCalledTimes(1)
    expect(feeds.at(-1)?.state).toBe('measured')
    // The newest timepoint is the source's declared latency behind live, and the feed says so.
    expect(feeds.at(-1)?.ageSeconds).toBe(90)
    dispose()
  })

  it('does not poll faster than the source declares it runs behind', async () => {
    // latency 600s → cadence 600s, not the 30-second timepoint beat.
    const { source, readMock } = fakeSource({ timepoints: true, latencySeconds: 600 })
    const dispose = startTimepointClock({ source, capacityId: 'c1', onFeed: () => {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(readMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(TIMEPOINT_SECONDS * 1000)
    expect(readMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(600 * 1000 - TIMEPOINT_SECONDS * 1000)
    expect(readMock).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('polls again on each 30-second beat for a zero-latency source', async () => {
    const { source, readMock } = fakeSource({ timepoints: true, latencySeconds: 0 })
    const dispose = startTimepointClock({ source, capacityId: 'c1', onFeed: () => {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(readMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(TIMEPOINT_SECONDS * 1000)
    expect(readMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(TIMEPOINT_SECONDS * 1000)
    expect(readMock).toHaveBeenCalledTimes(3)
    dispose()
  })
})

describe('the clock stops on teardown', () => {
  it('cancels the interval so no further poll or callback happens', async () => {
    const { source, readMock } = fakeSource({ timepoints: true, latencySeconds: 0 })
    const feeds: TimepointFeed[] = []
    const dispose = startTimepointClock({ source, capacityId: 'c1', onFeed: f => feeds.push(f) })
    await vi.advanceTimersByTimeAsync(0)

    const readsAtDispose = readMock.mock.calls.length
    const feedsAtDispose = feeds.length
    dispose()

    await vi.advanceTimersByTimeAsync(TIMEPOINT_SECONDS * 1000 * 20)
    expect(readMock.mock.calls.length).toBe(readsAtDispose)
    expect(feeds).toHaveLength(feedsAtDispose)
  })

  it('drops a read that resolves after disposal instead of calling back into an unmounted view', async () => {
    let resolveRead: (value: CapacityTimepoint[]) => void = () => {}
    const { source } = fakeSource({
      timepoints: true,
      latencySeconds: 0,
      read: () => new Promise<CapacityTimepoint[]>(resolve => { resolveRead = resolve }),
    })
    const feeds: TimepointFeed[] = []
    const dispose = startTimepointClock({ source, capacityId: 'c1', onFeed: f => feeds.push(f) })
    await vi.advanceTimersByTimeAsync(0)

    dispose()
    resolveRead([tp(Date.now())])
    await vi.advanceTimersByTimeAsync(0)

    expect(feeds).toHaveLength(0)
  })

  it('is idempotent and safe to dispose twice', async () => {
    const { source } = fakeSource({ timepoints: true, latencySeconds: 0 })
    const dispose = startTimepointClock({ source, capacityId: 'c1', onFeed: () => {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(() => {
      dispose()
      dispose()
    }).not.toThrow()
  })
})

describe('a failed read does not stop the clock', () => {
  it('ages the held feed and keeps polling after a rejected read', async () => {
    let attempt = 0
    const { source, readMock } = fakeSource({
      timepoints: true,
      latencySeconds: 0,
      read: async () => {
        attempt += 1
        if (attempt === 2) throw new Error('read failed')
        return [tp(Date.now())]
      },
    })
    const feeds: TimepointFeed[] = []
    const dispose = startTimepointClock({ source, capacityId: 'c1', onFeed: f => feeds.push(f) })
    await vi.advanceTimersByTimeAsync(0)
    expect(feeds.at(-1)?.state).toBe('measured')

    await vi.advanceTimersByTimeAsync(TIMEPOINT_SECONDS * 1000)
    // The second read failed: the feed still updates (its age climbs) rather than the clock dying.
    expect(errorSpy).toHaveBeenCalled()
    expect(feeds.at(-1)?.ageSeconds).toBe(TIMEPOINT_SECONDS)

    await vi.advanceTimersByTimeAsync(TIMEPOINT_SECONDS * 1000)
    expect(readMock.mock.calls.length).toBeGreaterThanOrEqual(3)
    dispose()
  })
})
