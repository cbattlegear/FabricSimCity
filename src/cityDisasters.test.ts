import { describe, expect, it } from 'vitest'
import { createFixtureSource } from './collect/fixtureSource'
import type {
  CapacityCityItem,
  CapacityCityPage,
  ItemOperationCounts,
} from './capacityCityContracts'
import type { Evidence, ThrottleState } from './fabricContracts'
import { parseCount, projectCityDisasters } from './cityDisasters'

const NOW = new Date(Date.UTC(2025, 4, 14, 9, 17, 42))

const available: Evidence = {
  source: 'Fixture',
  status: 'Available',
  observedAt: NOW.toISOString(),
  freshUntil: new Date(NOW.getTime() + 300_000).toISOString(),
}

const measuredThrottle: ThrottleState = {
  stage: 'None',
  interactiveDelayPercent: 20,
  interactiveRejectionPercent: 15,
  backgroundRejectionPercent: 10,
  cumulativeCarryOverPercent: 0,
  expectedBurndownMinutes: 0,
  surgeProtectionActive: false,
  evidence: available,
}

function counts(overrides: Partial<ItemOperationCounts> = {}): ItemOperationCounts {
  return {
    total: null,
    successful: null,
    rejected: null,
    failed: null,
    invalid: null,
    cancelled: null,
    ...overrides,
  }
}

function item(itemId: string, operations: ItemOperationCounts): CapacityCityItem {
  return {
    itemId,
    workspaceId: 'ws:1',
    workspaceName: 'Workspace',
    name: itemId,
    kind: 'Warehouse',
    archetype: 'Storage',
    storage: { bytes: '1024', status: 'Known', evidence: available },
    cuConsumed: { cuSeconds: '100', status: 'Known', evidence: available },
    durationSeconds: 60,
    operations,
    distinctUsers: '3',
    throttlingMinutes: 0,
    performanceDeltaPercent: null,
    layout: { neighborhoodOrdinal: 0, itemOrdinal: 0 },
    sizeStatus: 'Known',
    evidence: available,
  }
}

async function fixturePage(name: string): Promise<CapacityCityPage> {
  const source = createFixtureSource({ now: () => NOW })
  const atlas = await source.readAtlas()
  const found = atlas.capacities.find((entry) => entry.displayName === name)
  if (!found) throw new Error(`No capacity named ${name}`)
  return source.readCityPage({ capacityId: found.capacityId, metric: 'Cu', pageSize: 50 })
}

describe('the city stands lit by its own capacity state', () => {
  it('draws Fabrikam Dev as a disaster: a blacked-out sky over struck buildings', async () => {
    const page = await fixturePage('Fabrikam Dev')
    const projection = projectCityDisasters({ throttle: page.throttle, items: page.items })

    expect(projection.weather).toBe('blackout')
    expect(projection.survey.isDisaster).toBe(true)
    // Its interactive items had work refused, so the blackout is pinned to real buildings.
    expect(projection.rejectionsObserved).toBe(true)
    expect(projection.blackedOutItemIds.length).toBeGreaterThan(0)
    expect(projection.items.some((disaster) => disaster.key === 'blackout')).toBe(true)
    expect(projection.items.some((disaster) => disaster.key === 'struck-buildings')).toBe(true)
  })

  it('does not read paused Tailspin Archive as clear', async () => {
    const page = await fixturePage('Tailspin Archive')
    const projection = projectCityDisasters({ throttle: page.throttle, items: page.items })

    expect(projection.weather).toBe('unknown')
    expect(projection.weather).not.toBe('clear')
    // A paused capacity reports no outcome counts at all, so no building is proven clear or struck.
    expect(projection.rejectionsObserved).toBe(false)
    expect(projection.blackedOutItemIds).toEqual([])
    expect(projection.items).toEqual([])
  })

  it('leaves a healthy capacity with clear skies and no disasters', async () => {
    const page = await fixturePage('Contoso Analytics')
    const projection = projectCityDisasters({ throttle: page.throttle, items: page.items })

    expect(projection.weather).toBe('clear')
    expect(projection.items).toEqual([])
    expect(projection.blackedOutItemIds).toEqual([])
  })
})

describe('a struck building needs a measured rejection, never a guessed zero', () => {
  it('strikes only buildings with a measured rejected count above zero', () => {
    const items = [
      item('measured-hit', counts({ total: '100', rejected: '12' })),
      item('measured-clean', counts({ total: '100', rejected: '0' })),
      item('unmeasured', counts({ rejected: null })),
    ]
    const projection = projectCityDisasters({ throttle: measuredThrottle, items })

    expect(projection.blackedOutItemIds).toEqual(['measured-hit'])
    // Two of three items reported a count, so rejections were observed even though one read zero.
    expect(projection.rejectionsObserved).toBe(true)
  })

  it('distinguishes "no building was struck" from "no building was measured"', () => {
    const noneMeasured = projectCityDisasters({
      throttle: measuredThrottle,
      items: [item('a', counts({ rejected: null })), item('b', counts({ rejected: null }))],
    })
    const allClean = projectCityDisasters({
      throttle: measuredThrottle,
      items: [item('a', counts({ total: '10', rejected: '0' }))],
    })

    expect(noneMeasured.blackedOutItemIds).toEqual([])
    expect(noneMeasured.rejectionsObserved).toBe(false)
    expect(allClean.blackedOutItemIds).toEqual([])
    expect(allClean.rejectionsObserved).toBe(true)
  })

  it('parses counts, keeping null and non-numeric distinct from zero', () => {
    expect(parseCount('42')).toBe(42)
    expect(parseCount('0')).toBe(0)
    expect(parseCount(null)).toBeNull()
    expect(parseCount('not-a-number')).toBeNull()
  })
})
