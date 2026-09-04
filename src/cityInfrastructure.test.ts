import { describe, expect, it } from 'vitest'
import type { CapacityAtlasItem, CuMeasurement, Evidence, ThrottleState } from './fabricContracts'
import {
  CONDITIONAL_FACILITY_ORDER,
  FACILITY_ORDER,
  projectFacilities,
  shouldRenderFacility,
} from './cityInfrastructure'
import { POWER_GRID_FACILITY_ORDER, projectPowerGrid } from './powerGrid'
import { createFixtureSource } from './collect/fixtureSource'

const NOW = new Date(Date.UTC(2025, 4, 14, 9, 17, 42))

const evidence: Evidence = {
  source: 'Fixture',
  status: 'Available',
  observedAt: NOW.toISOString(),
  freshUntil: new Date(NOW.getTime() + 300_000).toISOString(),
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

describe('power-grid facility placement roster', () => {
  it('reserves one deterministic site for every canonical power-grid facility kind', () => {
    expect(FACILITY_ORDER).toEqual([...POWER_GRID_FACILITY_ORDER])
    expect(FACILITY_ORDER).toEqual([
      'powerPlant',
      'reservoir',
      'carryForwardYard',
      'delayGate',
      'interactiveRejectionGate',
      'backgroundRejectionGate',
      'surgeSubstation',
    ])
    expect(CONDITIONAL_FACILITY_ORDER).toEqual(['surgeSubstation'])
  })

  it('draws only the non-conditional facilities before a grid projection exists', () => {
    const facilities = projectFacilities(null)
    expect(facilities.map(facility => facility.kind)).toEqual([
      'powerPlant',
      'reservoir',
      'carryForwardYard',
      'delayGate',
      'interactiveRejectionGate',
      'backgroundRejectionGate',
    ])
    for (const facility of facilities) {
      expect(facility.known).toBe(false)
      expect(facility.state).toBeNull()
      expect(facility.load).toBeNull()
      expect(facility.units[0]?.fill).toBeNull()
      expect(facility.reason).toMatch(/no claim/i)
    }
  })

  it('omits the surge substation unless surge protection is explicitly reported active', () => {
    const normal = projectFacilities(projectPowerGrid(capacity()))
    expect(normal.map(facility => facility.kind)).not.toContain('surgeSubstation')

    const surgeGrid = projectPowerGrid(capacity({
      stateReason: 'SurgeProtectionActive',
      throttle: throttle({ surgeProtectionActive: true }),
    }))
    const surge = surgeGrid.find(facility => facility.kind === 'surgeSubstation')!
    expect(shouldRenderFacility(surge)).toBe(true)

    const withSurge = projectFacilities(surgeGrid)
    expect(withSurge.map(facility => facility.kind)).toEqual([...FACILITY_ORDER])
    expect(withSurge.at(-1)?.state).toBe('brownout')
  })

  it('projects facility state and load without reordering landmarks by severity', () => {
    const facilities = projectFacilities(projectPowerGrid(capacity({
      meanUtilizationPercent: 104,
      throttle: throttle({
        stage: 'InteractiveRejection',
        interactiveDelayPercent: 135,
        interactiveRejectionPercent: 122,
        backgroundRejectionPercent: 44,
        cumulativeCarryOverPercent: 37,
      }),
    })))

    expect(facilities.map(facility => facility.kind)).toEqual(FACILITY_ORDER.filter(kind => kind !== 'surgeSubstation'))
    expect(facilities.find(facility => facility.kind === 'powerPlant')?.state).toBe('brownout')
    expect(facilities.find(facility => facility.kind === 'interactiveRejectionGate')?.state).toBe('blackout')
    expect(facilities.find(facility => facility.kind === 'delayGate')?.state).toBe('loaded')
    expect(facilities.find(facility => facility.kind === 'carryForwardYard')?.load).toBeCloseTo(0.37, 10)
  })
})

describe('measurements that are missing rather than zero', () => {
  it('renders a paused capacity as unbuilt/wireframe infrastructure, not a healthy empty grid', async () => {
    const tailspin = await fixtureCapacity('Tailspin Archive')
    const facilities = projectFacilities(projectPowerGrid(tailspin))

    expect(facilities.map(facility => facility.kind)).not.toContain('surgeSubstation')
    for (const facility of facilities) {
      expect(facility.known).toBe(false)
      expect(facility.measurement?.status).toBe('Unknown')
      expect(facility.measurement?.value).toBeNull()
      expect(facility.state).toBeNull()
      expect(facility.load).toBeNull()
      expect(facility.units[0]?.fill).toBeNull()
      expect(facility.headline).not.toMatch(/0\.0%/)
    }
  })
})
