import { describe, expect, it } from 'vitest'
import { createFixtureSource } from './collect/fixtureSource'
import type { CapacityAtlasItem, CuMeasurement, Evidence, ThrottleState } from './fabricContracts'
import {
  POWER_GRID_FACILITY_ORDER,
  facilityForThrottleStage,
  isThrottleStageActive,
  projectPowerGrid,
} from './powerGrid'

const NOW = new Date(Date.UTC(2025, 4, 14, 9, 17, 42))

const evidence: Evidence = {
  source: 'Fixture',
  status: 'Available',
  observedAt: NOW.toISOString(),
  freshUntil: new Date(NOW.getTime() + 300_000).toISOString(),
}

const disconnectedEvidence: Evidence = {
  source: 'Fixture',
  status: 'Disconnected',
  observedAt: NOW.toISOString(),
  freshUntil: null,
}

function cu(value: string | null): CuMeasurement {
  return { cuSeconds: value, status: value === null ? 'Unknown' : 'Known', evidence }
}

function throttle(overrides: Partial<ThrottleState> = {}): ThrottleState {
  return {
    stage: 'None',
    interactiveDelayPercent: 12,
    interactiveRejectionPercent: 8,
    backgroundRejectionPercent: 3,
    cumulativeCarryOverPercent: 0,
    expectedBurndownMinutes: 0,
    surgeProtectionActive: false,
    evidence,
    ...overrides,
  }
}

function capacity(overrides: Partial<CapacityAtlasItem> = {}): CapacityAtlasItem {
  return {
    capacityId: 'capacity:1',
    displayName: 'Test Capacity',
    sku: 'F8',
    capacityUnits: 8,
    region: 'North Europe',
    state: 'Active',
    stateReason: 'NotOverloaded',
    cuConsumed: cu('1200'),
    meanUtilizationPercent: 42,
    peakUtilizationPercent: 55,
    storage: { bytes: '1024', status: 'Known', evidence },
    workspaceCount: 1,
    itemCount: 1,
    throttle: throttle(),
    ...overrides,
  }
}

async function fixtureCapacity(name: string): Promise<CapacityAtlasItem> {
  const list = (await createFixtureSource({ now: () => NOW }).readAtlas()).capacities
  const found = list.find((entry) => entry.displayName === name)
  if (!found) throw new Error(`No capacity named ${name}`)
  return found
}

function facility(capacityItem: CapacityAtlasItem, kind: (typeof POWER_GRID_FACILITY_ORDER)[number]) {
  const found = projectPowerGrid(capacityItem).find((entry) => entry.kind === kind)
  if (!found) throw new Error(`Missing facility ${kind}`)
  return found
}

describe('power grid roster', () => {
  it('keeps every facility in a stable order for later geometry attachment', () => {
    expect(projectPowerGrid(capacity()).map((entry) => entry.kind)).toEqual([
      'powerPlant',
      'reservoir',
      'carryForwardYard',
      'delayGate',
      'interactiveRejectionGate',
      'backgroundRejectionGate',
      'surgeSubstation',
    ])
  })

  it('maps throttle stages to the gate that cityFacilityTraffic can route lanes to later', () => {
    expect(facilityForThrottleStage('InteractiveDelay')).toBe('delayGate')
    expect(facilityForThrottleStage('InteractiveRejection')).toBe('interactiveRejectionGate')
    expect(facilityForThrottleStage('BackgroundRejection')).toBe('backgroundRejectionGate')
  })
})

describe('facility states', () => {
  it('sizes the power plant from SKU capacity units and grades load from measured utilization', () => {
    const plant = facility(capacity({ capacityUnits: 32, meanUtilizationPercent: 87 }), 'powerPlant')
    expect(plant.sizing?.value).toBe(32)
    expect(plant.measurement.kind).toBe('meanUtilizationPercent')
    expect(plant.measurement.status).toBe('Known')
    expect(plant.state).toBe('loaded')
  })

  it('grades the smoothing reservoir by the hottest reported smoothing gauge', () => {
    const grid = projectPowerGrid(
      capacity({
        throttle: throttle({
          interactiveDelayPercent: 65,
          interactiveRejectionPercent: 101,
          backgroundRejectionPercent: 72,
        }),
      }),
    )
    const reservoir = grid.find((entry) => entry.kind === 'reservoir')!
    expect(reservoir.measurement.value).toBe(101)
    expect(reservoir.state).toBe('brownout')
  })

  it('shows carry-forward debt as load and reports its burndown', () => {
    const yard = facility(
      capacity({ throttle: throttle({ cumulativeCarryOverPercent: 34, expectedBurndownMinutes: 75 }) }),
      'carryForwardYard',
    )
    expect(yard.state).toBe('loaded')
    expect(yard.measurement.detail).toContain('1.3 h')
  })

  it('preserves the delay-versus-rejection distinction: delay is load, not blackout', async () => {
    const northwind = await fixtureCapacity('Northwind Reporting')
    expect(northwind.throttle.stage).toBe('InteractiveDelay')

    const delayGate = facility(northwind, 'delayGate')
    expect(delayGate.measurement.status).toBe('Known')
    expect(delayGate.state).toBe('loaded')
    expect(delayGate.state).not.toBe('blackout')

    expect(facility(northwind, 'interactiveRejectionGate').state).not.toBe('blackout')
    expect(facility(northwind, 'backgroundRejectionGate').state).not.toBe('blackout')
  })

  it('turns only rejection gates into blackouts when their gauges are active', async () => {
    const litware = await fixtureCapacity('Litware Trading')
    expect(litware.throttle.stage).toBe('InteractiveRejection')
    expect(facility(litware, 'delayGate').state).toBe('loaded')
    expect(facility(litware, 'interactiveRejectionGate').state).toBe('blackout')
    expect(facility(litware, 'backgroundRejectionGate').state).not.toBe('blackout')

    const fabrikam = await fixtureCapacity('Fabrikam Dev')
    expect(fabrikam.throttle.stage).toBe('BackgroundRejection')
    expect(facility(fabrikam, 'interactiveRejectionGate').state).toBe('blackout')
    expect(facility(fabrikam, 'backgroundRejectionGate').state).toBe('blackout')
  })

  it('marks surge protection as a brownout, not a missing false, when evidence reports it', () => {
    const surge = facility(
      capacity({ throttle: throttle({ surgeProtectionActive: true }) }),
      'surgeSubstation',
    )
    expect(surge.measurement.status).toBe('Known')
    expect(surge.state).toBe('brownout')
  })
})

describe('measurements that are missing rather than zero', () => {
  it('renders every paused-capacity facility as unmeasured instead of healthy at zero load', async () => {
    const tailspin = await fixtureCapacity('Tailspin Archive')
    const grid = projectPowerGrid(tailspin)

    for (const entry of grid) {
      expect(entry.measurement.status).toBe('Unknown')
      expect(entry.measurement.value).toBeNull()
      expect(entry.state).toBeNull()
      expect(entry.load).toBeNull()
      expect(entry.reason).not.toMatch(/0\.0%/)
    }
  })

  it('keeps missing carry-forward distinct from zero carry-forward', () => {
    const missing = facility(
      capacity({ throttle: throttle({ cumulativeCarryOverPercent: null, expectedBurndownMinutes: null }) }),
      'carryForwardYard',
    )
    const zero = facility(
      capacity({ throttle: throttle({ cumulativeCarryOverPercent: 0, expectedBurndownMinutes: 0 }) }),
      'carryForwardYard',
    )

    expect(missing.measurement.status).toBe('Unknown')
    expect(missing.state).toBeNull()
    expect(zero.measurement.status).toBe('Known')
    expect(zero.state).toBe('healthy')
  })

  it('does not treat a disconnected false surge flag as measured inactive protection', () => {
    const surge = facility(
      capacity({ throttle: throttle({ evidence: disconnectedEvidence, surgeProtectionActive: false }) }),
      'surgeSubstation',
    )
    expect(surge.measurement.status).toBe('Unknown')
    expect(surge.measurement.value).toBeNull()
    expect(surge.state).toBeNull()
  })

  it('makes a missing gauge inactive status unknown rather than false', () => {
    const unknown = throttle({ interactiveDelayPercent: null })
    expect(isThrottleStageActive(unknown, 'InteractiveDelay')).toBeNull()
    expect(isThrottleStageActive(throttle({ interactiveDelayPercent: 0 }), 'InteractiveDelay')).toBe(false)
  })
})
