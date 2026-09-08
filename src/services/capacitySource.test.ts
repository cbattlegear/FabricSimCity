import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConfiguredCapacitySource } from './capacitySource'
import { isFixtureMode } from './bootstrap'
import { CapacitySourceError } from '../collect/source'

afterEach(() => {
  vi.unstubAllEnvs()
})

/*
 * These stub every variable they depend on rather than relying on the suite-wide neutralization in
 * `vitest.config.ts`. A successful `rayfin up` writes a real `.env.local`, and a test that reads
 * ambient configuration passes on a fresh clone and fails on a machine that has deployed.
 */
describe('fixture mode selection', () => {
  it('runs on fixtures when no backend is configured', () => {
    vi.stubEnv('VITE_FABRIC_SOURCE', '')
    vi.stubEnv('VITE_RAYFIN_API_URL', '')
    expect(isFixtureMode()).toBe(true)
    expect(createConfiguredCapacitySource().kind).toBe('Fixture')
  })

  it('leaves fixture mode once a backend URL exists', () => {
    vi.stubEnv('VITE_FABRIC_SOURCE', '')
    vi.stubEnv('VITE_RAYFIN_API_URL', 'https://example.invalid/api/')
    expect(isFixtureMode()).toBe(false)
  })

  it('honours an explicit fixture request even against a configured backend', () => {
    vi.stubEnv('VITE_FABRIC_SOURCE', 'fixture')
    vi.stubEnv('VITE_RAYFIN_API_URL', 'https://example.invalid/api/')
    expect(isFixtureMode()).toBe(true)
    expect(createConfiguredCapacitySource().kind).toBe('Fixture')
  })
})

describe('semantic-model source wiring', () => {
  it('builds the source when a dataset id is configured', () => {
    vi.stubEnv('VITE_FABRIC_SOURCE', 'semantic-model')
    vi.stubEnv('VITE_RAYFIN_API_URL', 'https://example.invalid/api/')
    vi.stubEnv('VITE_FABRIC_METRICS_DATASET_ID', '11111111-2222-3333-4444-555555555555')

    const source = createConfiguredCapacitySource()
    expect(source.kind).toBe('SemanticModel')
    expect(source.capabilities.perItemBreakdown).toBe(true)
  })

  /*
   * The dataset id is the one thing that cannot be inferred — `rayfin env` writes the workspace and
   * item ids, but the Capacity Metrics model lives outside the app's own workspace. Failing with
   * `NotConfigured` names the variable instead of producing a 404 from the transport.
   */
  it('reports NotConfigured, naming the variable, when the dataset id is missing', () => {
    vi.stubEnv('VITE_FABRIC_SOURCE', 'semantic-model')
    vi.stubEnv('VITE_RAYFIN_API_URL', 'https://example.invalid/api/')
    vi.stubEnv('VITE_FABRIC_METRICS_DATASET_ID', '')

    try {
      createConfiguredCapacitySource()
      expect.unreachable('expected a CapacitySourceError')
    } catch (error) {
      expect(error).toBeInstanceOf(CapacitySourceError)
      expect((error as CapacitySourceError).failure).toBe('NotConfigured')
      expect((error as CapacitySourceError).sourceKind).toBe('SemanticModel')
      expect((error as Error).message).toMatch(/VITE_FABRIC_METRICS_DATASET_ID/)
    }
  })

  it('still reports the eventhouse source as unconfigured', () => {
    vi.stubEnv('VITE_FABRIC_SOURCE', 'eventhouse')
    vi.stubEnv('VITE_RAYFIN_API_URL', 'https://example.invalid/api/')
    expect(() => createConfiguredCapacitySource()).toThrow(CapacitySourceError)
  })
})
