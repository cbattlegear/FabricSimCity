import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createFixtureSource } from './collect/fixtureSource'
import type { CapacitySource } from './collect/source'
import type { AtlasSnapshot } from './fabricContracts'
import App from './App'

const mocks = vi.hoisted(() => ({ load: vi.fn(), city: vi.fn() }))
vi.mock('./services/capacitySource', () => ({ loadConfiguredCapacitySource: mocks.load }))
vi.mock('./AtlasViewport', () => ({ AtlasViewport: () => null }))
vi.mock('./CapacityCityView', () => ({ CapacityCityView: mocks.city }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

let container: HTMLDivElement
let root: Root | null
let snapshot: AtlasSnapshot

function measuredSource(name = 'Measured SQL capacity') {
  const measured: AtlasSnapshot = {
    ...snapshot,
    capacities: [{ ...snapshot.capacities[0], displayName: name }],
  }
  return {
    ...createFixtureSource(),
    kind: 'SemanticModel',
    readAtlas: vi.fn<(signal?: AbortSignal) => Promise<AtlasSnapshot>>().mockResolvedValue(measured),
  } satisfies CapacitySource
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  snapshot = await createFixtureSource().readAtlas()
  vi.useFakeTimers()
  window.history.replaceState(null, '', '/')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocks.city.mockImplementation(() => <div>Measured city</div>)
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function mount(strict = false) {
  await act(async () => { root!.render(strict ? <StrictMode><App /></StrictMode> : <App />) })
}

describe('configured data in the rendered app', () => {
  it('waits for initialization and renders configured data, not the fixture roster', async () => {
    const pending = deferred<CapacitySource>()
    mocks.load.mockReturnValue(pending.promise)
    await mount()
    expect(container.querySelectorAll('.address-entry')).toHaveLength(0)
    await act(async () => { pending.resolve(measuredSource()) })
    expect(container.querySelectorAll('.address-entry')).toHaveLength(1)
    expect(container.textContent).toContain('Measured SQL capacity')
    expect(container.textContent).toContain('semantic model')
  })

  it('publishes a refreshed source and atlas together to a deep-linked city', async () => {
    const first = measuredSource('First ingest')
    const second = measuredSource('Second ingest')
    const pending = deferred<AtlasSnapshot>()
    second.readAtlas.mockReturnValue(pending.promise)
    mocks.load.mockResolvedValueOnce(first).mockResolvedValue(second)
    window.history.replaceState(null, '', `/?capacity=${snapshot.capacities[0].capacityId}`)
    await mount()
    expect(mocks.city.mock.calls.at(-1)![0].source).toBe(first)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(mocks.city.mock.calls.at(-1)![0].source).toBe(first)
    await act(async () => {
      pending.resolve({ ...snapshot, capacities: [{ ...snapshot.capacities[0], displayName: 'Second ingest' }] })
    })
    expect(mocks.city.mock.calls.at(-1)![0]).toMatchObject({
      source: second, capacity: { displayName: 'Second ingest' },
    })
  })

  it('surfaces startup errors instead of falling back to fixtures and recovers on refresh', async () => {
    mocks.load.mockRejectedValueOnce(new Error('Open this app inside the Fabric portal'))
      .mockResolvedValue(measuredSource())
    await mount()
    expect(container.textContent).toContain('Open this app inside the Fabric portal')
    expect(container.querySelectorAll('.address-entry')).toHaveLength(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(container.textContent).toContain('Measured SQL capacity')
    expect(container.textContent).not.toContain('Atlas unavailable')
  })

  it('keeps the last good snapshot when a later SQL read fails', async () => {
    const second = measuredSource()
    second.readAtlas.mockRejectedValue(new Error('SQL unavailable'))
    mocks.load.mockResolvedValueOnce(measuredSource()).mockResolvedValue(second)
    await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(container.textContent).toContain('Measured SQL capacity')
    expect(container.textContent).toContain('Refresh failed')
  })

  it('does not overlap reads and aborts the current one on unmount', async () => {
    const source = measuredSource()
    source.readAtlas.mockReturnValue(deferred<AtlasSnapshot>().promise)
    mocks.load.mockResolvedValue(source)
    await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
    expect(source.readAtlas).toHaveBeenCalledTimes(1)
    const signal = source.readAtlas.mock.calls[0][0]
    expect(signal?.aborted).toBe(false)
    await act(async () => { root!.unmount(); root = null })
    expect(signal?.aborted).toBe(true)
  })

  it('ignores the discarded StrictMode initialization before starting a data read', async () => {
    const pending = deferred<CapacitySource>()
    const source = measuredSource()
    mocks.load.mockReturnValue(pending.promise)
    await mount(true)
    await act(async () => { pending.resolve(source) })
    expect(source.readAtlas).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Measured SQL capacity')
  })

  it('does not reset city selections merely because a refreshed ingest replaced its source', () => {
    const source = readFileSync(resolve(process.cwd(), 'src', 'CapacityCityView.tsx'), 'utf8')
    const start = source.indexOf('// Reset per-capacity state')
    const end = source.indexOf('// Refresh source data', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const reset = source.slice(start, end)
    expect(reset).toContain('setSelectedId(null)')
    expect(reset).toContain('}, [capacityId])')
  })
})
