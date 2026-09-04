import { describe, expect, it } from 'vitest'
import { createFixtureSource } from './fixtureSource'
import { CITY_PAGE_SIZE } from './source'
import { NOW_INDEX } from '../fixtures/fabricFixture'
import { TIMEPOINT_SECONDS } from '../fabricContracts'
import type { CapacityAtlasItem } from '../fabricContracts'

const NOW = new Date(Date.UTC(2025, 4, 14, 9, 17, 42))

function source() {
  return createFixtureSource({ now: () => NOW })
}

async function atlas() {
  return source().readAtlas()
}

function byName(capacities: CapacityAtlasItem[], name: string): CapacityAtlasItem {
  const found = capacities.find((entry) => entry.displayName === name)
  if (!found) throw new Error(`No fixture capacity named ${name}`)
  return found
}

describe('atlas', () => {
  it('reports every capacity with its SKU budget', async () => {
    const snapshot = await atlas()

    expect(snapshot.capacities).toHaveLength(6)
    expect(byName(snapshot.capacities, 'Contoso Analytics').capacityUnits).toBe(64)
    expect(byName(snapshot.capacities, 'Fabrikam Dev').capacityUnits).toBe(2)
    expect(snapshot.collection?.state).toBe('Ready')
  })

  it('marks its evidence as fixture-sourced rather than pretending to be live', async () => {
    const snapshot = await atlas()
    for (const capacity of snapshot.capacities) {
      expect(capacity.storage.evidence.source).toBe('Fixture')
    }
    expect(snapshot.collection?.source).toBe('Fixture')
  })
})

describe('a paused capacity', () => {
  it('reports unknown CU rather than zero', async () => {
    const tailspin = byName((await atlas()).capacities, 'Tailspin Archive')

    /*
     * The whole evidence model exists for this case. A paused capacity and a completely idle one
     * both consumed no CU; only one of them was measured. Reporting zero would draw a quiet,
     * healthy, empty city over a capacity nobody has any information about.
     */
    expect(tailspin.cuConsumed.cuSeconds).toBeNull()
    expect(tailspin.cuConsumed.status).toBe('Unknown')
    expect(tailspin.cuConsumed.evidence.status).toBe('Disconnected')
    expect(tailspin.peakUtilizationPercent).toBeNull()
  })

  it('still reports storage, which survives the pause and is still billed', async () => {
    const tailspin = byName((await atlas()).capacities, 'Tailspin Archive')

    expect(tailspin.storage.status).toBe('Known')
    expect(Number(tailspin.storage.bytes)).toBeGreaterThan(0)
    expect(tailspin.storage.evidence.status).toBe('Available')
  })

  it('reports no throttle gauges at all', async () => {
    const tailspin = byName((await atlas()).capacities, 'Tailspin Archive')

    // Null, not 0. An unmeasured gauge rendered as 0% draws a healthy grid over an unknown one.
    expect(tailspin.throttle.interactiveDelayPercent).toBeNull()
    expect(tailspin.throttle.backgroundRejectionPercent).toBeNull()
    expect(tailspin.throttle.cumulativeCarryOverPercent).toBeNull()
  })

  it('returns no timepoints, because a paused capacity emits none', async () => {
    const feed = source()
    const tailspin = byName((await feed.readAtlas()).capacities, 'Tailspin Archive')

    const timepoints = await feed.readTimepoints({
      capacityId: tailspin.capacityId,
      start: new Date(NOW.getTime() - 3600_000).toISOString(),
      end: NOW.toISOString(),
    })
    expect(timepoints).toEqual([])

    const samples = await feed.readOperationSamples({
      capacityId: tailspin.capacityId,
      limit: 20,
    })
    expect(samples).toEqual([])
  })
})

describe('city pages', () => {
  it('walks every item across pages without repeating or dropping one', async () => {
    const feed = source()
    const contoso = byName((await feed.readAtlas()).capacities, 'Contoso Analytics')

    const seen: string[] = []
    let token: string | null = null
    let guard = 0

    do {
      const page = await feed.readCityPage({
        capacityId: contoso.capacityId,
        metric: 'Cu',
        pageSize: 5,
        pageToken: token,
      })
      seen.push(...page.items.map((entry) => entry.itemId))
      token = page.nextPageToken
      guard += 1
    } while (token && guard < 50)

    expect(token).toBeNull()
    expect(seen).toHaveLength(contoso.itemCount!)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('ranks by the requested metric', async () => {
    const feed = source()
    const contoso = byName((await feed.readAtlas()).capacities, 'Contoso Analytics')

    const byStorage = await feed.readCityPage({
      capacityId: contoso.capacityId,
      metric: 'Storage',
      pageSize: CITY_PAGE_SIZE,
    })
    const sizes = byStorage.items.map((entry) => Number(entry.storage.bytes ?? 0))
    expect([...sizes].sort((left, right) => right - left)).toEqual(sizes)
  })

  it('accounts for the work that did not make the page', async () => {
    const feed = source()
    const contoso = byName((await feed.readAtlas()).capacities, 'Contoso Analytics')

    const page = await feed.readCityPage({
      capacityId: contoso.capacityId,
      metric: 'Cu',
      pageSize: 3,
    })

    /*
     * Without this a city drawn from the top three items would silently claim to be the whole
     * capacity. The off-page totals are what let the map say how much load is out of frame.
     */
    expect(Number(page.otherWorkload.familyCount)).toBeGreaterThan(0)
    expect(Number(page.otherWorkload.cuSeconds)).toBeGreaterThan(0)
    expect(page.totalItems).toBe(String(contoso.itemCount))
    expect(page.nextPageToken).not.toBeNull()
  })

  it('only returns workspaces for items actually on the page', async () => {
    const feed = source()
    const contoso = byName((await feed.readAtlas()).capacities, 'Contoso Analytics')

    const page = await feed.readCityPage({
      capacityId: contoso.capacityId,
      metric: 'Cu',
      pageSize: 2,
    })

    const workspaceIds = new Set(page.workspaces.map((entry) => entry.workspaceId))
    for (const entry of page.items) expect(workspaceIds.has(entry.workspaceId)).toBe(true)
    expect(page.workspaces.length).toBeLessThanOrEqual(page.items.length)
  })

  it('keeps item ordinals stable across page boundaries', async () => {
    const feed = source()
    const contoso = byName((await feed.readAtlas()).capacities, 'Contoso Analytics')

    const first = await feed.readCityPage({
      capacityId: contoso.capacityId,
      metric: 'Cu',
      pageSize: 4,
    })
    const second = await feed.readCityPage({
      capacityId: contoso.capacityId,
      metric: 'Cu',
      pageSize: 4,
      pageToken: first.nextPageToken,
    })

    // Loading page two must never renumber a building already on screen and move it.
    const firstOrdinals = new Map(first.items.map((entry) => [entry.itemId, entry.layout.itemOrdinal]))
    const reloaded = await feed.readCityPage({
      capacityId: contoso.capacityId,
      metric: 'Cu',
      pageSize: 4,
    })
    for (const entry of reloaded.items) {
      expect(entry.layout.itemOrdinal).toBe(firstOrdinals.get(entry.itemId))
    }
    for (const entry of second.items) expect(firstOrdinals.has(entry.itemId)).toBe(false)
  })
})

describe('items', () => {
  it('separates "stores nothing" from "storage not measured"', async () => {
    const feed = source()
    const contoso = byName((await feed.readAtlas()).capacities, 'Contoso Analytics')
    const page = await feed.readCityPage({
      capacityId: contoso.capacityId,
      metric: 'Cu',
      pageSize: CITY_PAGE_SIZE,
    })

    const notebook = page.items.find((entry) => entry.kind === 'Notebook')!
    expect(notebook.archetype).toBe('Compute')
    expect(notebook.storage.bytes).toBeNull()
    expect(notebook.sizeStatus).toBe('Unknown')

    const lakehouse = page.items.find((entry) => entry.kind === 'Lakehouse')!
    expect(lakehouse.archetype).toBe('Storage')
    expect(Number(lakehouse.storage.bytes)).toBeGreaterThan(0)
    expect(lakehouse.sizeStatus).toBe('Known')
  })

  it('leaves the performance delta null for items with no comparable window', async () => {
    const feed = source()
    const contoso = byName((await feed.readAtlas()).capacities, 'Contoso Analytics')
    const page = await feed.readCityPage({
      capacityId: contoso.capacityId,
      metric: 'Cu',
      pageSize: CITY_PAGE_SIZE,
    })

    /*
     * Null and 0 mean different things here: "no window to compare against" versus "compared and
     * unchanged". A fixture that never produced the first would leave that path untested.
     */
    expect(page.items.some((entry) => entry.performanceDeltaPercent === null)).toBe(true)
    expect(page.items.some((entry) => entry.performanceDeltaPercent !== null)).toBe(true)
  })
})

describe('throttling and rejections', () => {
  it('produces rejections only where the capacity is actually rejecting', async () => {
    const feed = source()
    const capacities = (await feed.readAtlas()).capacities

    const healthy = byName(capacities, 'Contoso Analytics')
    const rejecting = byName(capacities, 'Fabrikam Dev')

    const healthyPage = await feed.readCityPage({
      capacityId: healthy.capacityId,
      metric: 'Cu',
      pageSize: CITY_PAGE_SIZE,
    })
    const rejectingPage = await feed.readCityPage({
      capacityId: rejecting.capacityId,
      metric: 'Cu',
      pageSize: CITY_PAGE_SIZE,
    })

    expect(healthyPage.throttle.stage).toBe('None')
    expect(
      healthyPage.items.every((entry) => Number(entry.operations.rejected ?? '0') === 0),
    ).toBe(true)

    expect(rejectingPage.throttle.stage).toBe('BackgroundRejection')
    /*
     * A rejection count is the only evidence that throttling actually turned work away, as
     * opposed to the gauges merely running hot. Without at least one, the incident-pin path is
     * never exercised.
     */
    expect(rejectingPage.items.some((entry) => Number(entry.operations.rejected ?? '0') > 0)).toBe(
      true,
    )
  })

  it('only delays interactive work on a capacity in the interactive stages', async () => {
    const feed = source()
    const litware = byName((await feed.readAtlas()).capacities, 'Litware Trading')
    const page = await feed.readCityPage({
      capacityId: litware.capacityId,
      metric: 'Cu',
      pageSize: CITY_PAGE_SIZE,
    })

    expect(page.throttle.stage).toBe('InteractiveRejection')

    const background = page.topOperationFamilies.filter(
      (family) => family.operationClass === 'Background',
    )
    expect(background.length).toBeGreaterThan(0)
    // Background work survives until the 24-hour threshold, which this capacity has not crossed.
    expect(background.every((family) => Number(family.counts.rejected ?? '0') === 0)).toBe(true)
  })
})

describe('timepoints', () => {
  it('returns one every 30 seconds across the requested window', async () => {
    const feed = source()
    const contoso = byName((await feed.readAtlas()).capacities, 'Contoso Analytics')

    const start = new Date(NOW.getTime() - 30 * 60_000)
    const timepoints = await feed.readTimepoints({
      capacityId: contoso.capacityId,
      start: start.toISOString(),
      end: NOW.toISOString(),
    })

    expect(timepoints.length).toBeGreaterThan(50)
    for (let index = 1; index < timepoints.length; index += 1) {
      const delta = Date.parse(timepoints[index].timepoint) - Date.parse(timepoints[index - 1].timepoint)
      expect(delta).toBe(TIMEPOINT_SECONDS * 1000)
    }
    expect(timepoints[0].cuLimit).toBe(64 * TIMEPOINT_SECONDS)
  })

  it('never returns a timepoint from the future tail the gauges are averaged over', async () => {
    const feed = source()
    const contoso = byName((await feed.readAtlas()).capacities, 'Contoso Analytics')

    const timepoints = await feed.readTimepoints({
      capacityId: contoso.capacityId,
      start: new Date(NOW.getTime() - 3600_000).toISOString(),
      // Ask well past now: the series has 24 more hours, but none of it has happened.
      end: new Date(NOW.getTime() + 12 * 3600_000).toISOString(),
    })

    const last = Date.parse(timepoints[timepoints.length - 1].timepoint)
    const nowFloor = Math.floor(NOW.getTime() / (TIMEPOINT_SECONDS * 1000)) * TIMEPOINT_SECONDS * 1000
    expect(last).toBeLessThanOrEqual(nowFloor)
  })

  it('covers the whole retained history', async () => {
    const feed = source()
    const contoso = byName((await feed.readAtlas()).capacities, 'Contoso Analytics')

    const timepoints = await feed.readTimepoints({
      capacityId: contoso.capacityId,
      start: new Date(NOW.getTime() - 15 * 86_400_000).toISOString(),
      end: NOW.toISOString(),
    })
    expect(timepoints).toHaveLength(NOW_INDEX + 1)
  })
})

describe('operation samples', () => {
  it('carries the smoothing window, not just the cost', async () => {
    const feed = source()
    const contoso = byName((await feed.readAtlas()).capacities, 'Contoso Analytics')

    const samples = await feed.readOperationSamples({
      capacityId: contoso.capacityId,
      limit: 40,
    })
    expect(samples).toHaveLength(40)

    for (const sample of samples) {
      expect(sample.smoothingStart).not.toBeNull()
      expect(sample.smoothingEnd).not.toBeNull()
      const span = Date.parse(sample.smoothingEnd!) - Date.parse(sample.smoothingStart!)
      /*
       * Interactive work smooths over 5–64 minutes and background over 24 hours. This is the
       * mechanism behind every throttle the city draws, so a sample that lost its window would
       * make the reservoirs unexplainable.
       */
      if (sample.operationClass === 'Background') {
        expect(span).toBe(24 * 3600_000)
      } else {
        expect(span).toBeGreaterThanOrEqual(5 * 60_000)
        expect(span).toBeLessThanOrEqual(64 * 60_000)
      }
    }
  })

  it('charges a timepoint only its smoothed share of an operation', async () => {
    const feed = source()
    const contoso = byName((await feed.readAtlas()).capacities, 'Contoso Analytics')

    const samples = await feed.readOperationSamples({
      capacityId: contoso.capacityId,
      limit: 20,
    })
    for (const sample of samples) {
      expect(sample.timepointCuSeconds!).toBeLessThan(sample.totalCuSeconds!)
    }
  })

  it('is stable within a timepoint and moves between them', async () => {
    const feed = source()
    const contoso = byName((await feed.readAtlas()).capacities, 'Contoso Analytics')

    const at = new Date(NOW.getTime() - 5 * 60_000).toISOString()
    const first = await feed.readOperationSamples({
      capacityId: contoso.capacityId,
      timepoint: at,
      limit: 10,
    })
    const again = await feed.readOperationSamples({
      capacityId: contoso.capacityId,
      timepoint: at,
      limit: 10,
    })
    expect(again.map((entry) => entry.operationId)).toEqual(first.map((entry) => entry.operationId))

    const later = await feed.readOperationSamples({
      capacityId: contoso.capacityId,
      timepoint: new Date(NOW.getTime() - 4 * 60_000).toISOString(),
      limit: 10,
    })
    expect(later.map((entry) => entry.operationName)).not.toEqual(
      first.map((entry) => entry.operationName),
    )
  })
})

describe('capabilities', () => {
  it('declares what it can answer up front', () => {
    const feed = source()
    expect(feed.kind).toBe('Fixture')
    expect(feed.capabilities.perItemBreakdown).toBe(true)
    expect(feed.capabilities.timepoints).toBe(true)
    expect(feed.capabilities.retentionDays).toBe(14)
  })
})
