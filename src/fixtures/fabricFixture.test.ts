import { describe, expect, it } from 'vitest'
import {
  buildFixtureTenant,
  createThrottleReader,
  FIXTURE_PROFILES,
  NOW_INDEX,
  SERIES_LENGTH,
  carryOverSeries,
  stateForStage,
  throttleStageFor,
} from './fabricFixture'
import { canHoldStorage } from '../itemKind'
import { SKU_CAPACITY_UNITS, TIMEPOINT_SECONDS } from '../fabricContracts'
import type { ThrottleStage } from '../fabricContracts'

/**
 * The fixture's whole value is that it cannot lie.
 *
 * Every capacity's state is *derived* from its generated load series rather than declared, so
 * these tests check the derivation lands where the profiles intend — and, more importantly, that
 * it lands there no matter what time of day the fixture is built. A fixture whose Northwind is
 * throttled at 2pm and healthy at 3am would make every downstream test time-dependent, which is
 * the kind of flake that gets tests deleted rather than fixed.
 */

/** What each profile is built to demonstrate. Named, because that is what makes a failure legible. */
const EXPECTED_STAGE: Readonly<Record<string, ThrottleStage | 'Paused'>> = {
  'Contoso Analytics': 'None',
  'Adventure Works Platform': 'None',
  'Northwind Reporting': 'InteractiveDelay',
  'Litware Trading': 'InteractiveRejection',
  'Fabrikam Dev': 'BackgroundRejection',
  'Tailspin Archive': 'Paused',
}

/** A fixed instant, plus every third hour around the clock. */
const BASE = Date.UTC(2025, 4, 14, 9, 17, 42)
const CLOCK_SAMPLES = [0, 3, 6, 9, 12, 15, 18, 21].map(
  (hour) => new Date(Date.UTC(2025, 4, 14, hour, 11, 0)),
)

describe('fixture profiles', () => {
  it('covers every capacity state the city has to render', () => {
    const covered = new Set(Object.values(EXPECTED_STAGE))
    expect(covered).toEqual(
      new Set(['None', 'InteractiveDelay', 'InteractiveRejection', 'BackgroundRejection', 'Paused']),
    )
    expect(FIXTURE_PROFILES.map((profile) => profile.displayName).sort()).toEqual(
      Object.keys(EXPECTED_STAGE).sort(),
    )
  })

  it('generates 14 days of history plus 24 hours of committed future smoothing', () => {
    const tenant = buildFixtureTenant(new Date(BASE))
    for (const capacity of tenant.capacities) {
      expect(capacity.utilization).toHaveLength(SERIES_LENGTH)
      expect(capacity.nowIndex).toBe(NOW_INDEX)
      // The tail is what stops the forward-window gauges reading a one-element window at now.
      expect(SERIES_LENGTH - NOW_INDEX).toBe(2880)
    }
  })
})

describe('derived capacity state', () => {
  it.each(CLOCK_SAMPLES)('lands on the intended throttle stage at %s', (now) => {
    const tenant = buildFixtureTenant(now)

    for (const capacity of tenant.capacities) {
      const expected = EXPECTED_STAGE[capacity.displayName]

      if (expected === 'Paused') {
        expect(capacity.state).toBe('Suspended')
        expect(capacity.stateReason).toBe('ManuallyPaused')
        continue
      }

      const reading = createThrottleReader(capacity.utilization).at(NOW_INDEX)
      expect(reading.stage, `${capacity.displayName} at ${now.toISOString()}`).toBe(expected)
      expect(capacity.state).toBe(expected === 'None' ? 'Active' : 'Overloaded')
    }
  })

  it('agrees with the gauges it reports', () => {
    const tenant = buildFixtureTenant(new Date(BASE))

    for (const capacity of tenant.capacities) {
      if (capacity.state === 'Suspended') continue
      const reading = createThrottleReader(capacity.utilization).at(NOW_INDEX)

      /*
       * The stage must follow from the three percentages and nothing else. If these ever disagree
       * the fixture is asserting a state its own numbers do not support, and every test that
       * trusts the fixture is asserting against fiction.
       */
      expect(reading.stage).toBe(
        throttleStageFor(
          reading.interactiveDelayPercent,
          reading.interactiveRejectionPercent,
          reading.backgroundRejectionPercent,
        ),
      )
      expect(stateForStage(reading.stage, false)).toEqual({
        state: capacity.state,
        reason: capacity.stateReason,
      })
    }
  })

  it('keeps the stages ordered — a later stage implies every earlier one', () => {
    const tenant = buildFixtureTenant(new Date(BASE))

    for (const capacity of tenant.capacities) {
      if (capacity.state === 'Suspended') continue
      const reading = createThrottleReader(capacity.utilization).at(NOW_INDEX)

      if (reading.stage === 'BackgroundRejection') {
        expect(reading.interactiveRejectionPercent).toBeGreaterThan(100)
        expect(reading.interactiveDelayPercent).toBeGreaterThan(100)
      }
      if (reading.stage === 'InteractiveRejection') {
        expect(reading.interactiveDelayPercent).toBeGreaterThan(100)
        expect(reading.backgroundRejectionPercent).toBeLessThanOrEqual(100)
      }
      if (reading.stage === 'InteractiveDelay') {
        expect(reading.interactiveRejectionPercent).toBeLessThanOrEqual(100)
      }
    }
  })
})

describe('carry-forward', () => {
  it('accumulates on a capacity that never comes below the line and never burns down', () => {
    const tenant = buildFixtureTenant(new Date(BASE))
    const fabrikam = tenant.capacities.find((entry) => entry.displayName === 'Fabrikam Dev')!

    const debt = carryOverSeries(fabrikam.utilization)
    expect(debt[NOW_INDEX]).toBeGreaterThan(debt[NOW_INDEX - 2880])

    const reading = createThrottleReader(fabrikam.utilization).at(NOW_INDEX)
    expect(reading.carryOverBurndownPercent).toBe(0)
    /*
     * Null, not Infinity and not a number. "This will never clear at the current rate" is a real
     * state, and any number here would draw a burndown countdown that is not true.
     */
    expect(reading.expectedBurndownMinutes).toBeNull()
  })

  it('stays at zero for a capacity that never exceeds its SKU', () => {
    const tenant = buildFixtureTenant(new Date(BASE))
    const contoso = tenant.capacities.find((entry) => entry.displayName === 'Contoso Analytics')!

    expect(Math.max(...contoso.utilization)).toBeLessThan(1)
    expect(carryOverSeries(contoso.utilization)[NOW_INDEX]).toBe(0)
  })
})

describe('determinism', () => {
  it('draws the same tenant twice from the same clock and seed', () => {
    const first = buildFixtureTenant(new Date(BASE))
    const second = buildFixtureTenant(new Date(BASE))

    expect(second.tenantId).toBe(first.tenantId)
    expect(second.capacities.map((entry) => entry.capacityId)).toEqual(
      first.capacities.map((entry) => entry.capacityId),
    )
    expect(second.capacities[0].items.map((entry) => entry.cuSeconds)).toEqual(
      first.capacities[0].items.map((entry) => entry.cuSeconds),
    )
  })

  it('keeps ids stable across clocks, so a building does not move when the page refreshes', () => {
    const morning = buildFixtureTenant(new Date(BASE))
    const evening = buildFixtureTenant(new Date(BASE + 11 * 3600_000))

    expect(evening.capacities.map((entry) => entry.capacityId)).toEqual(
      morning.capacities.map((entry) => entry.capacityId),
    )
    expect(evening.capacities[0].items.map((entry) => entry.itemId)).toEqual(
      morning.capacities[0].items.map((entry) => entry.itemId),
    )
  })

  it('separates seeds', () => {
    const base = buildFixtureTenant(new Date(BASE))
    const other = buildFixtureTenant(new Date(BASE), 'another-tenant')
    expect(other.tenantId).not.toBe(base.tenantId)
  })
})

describe('item geometry inputs', () => {
  it('gives storage only to kinds that can hold it', () => {
    const tenant = buildFixtureTenant(new Date(BASE))

    for (const capacity of tenant.capacities) {
      for (const entry of capacity.items) {
        if (entry.storageBytes !== null) {
          /*
           * A Notebook with bytes would prove the wrong thing about the city: compute-only items
           * sit on a minimum lot because they store nothing, not because their footprint failed
           * to measure, and the two render differently on purpose.
           */
          expect(canHoldStorage(entry.kind), `${entry.name} (${entry.kind})`).toBe(true)
          expect(entry.storageBytes).toBeGreaterThan(0)
        }
      }
    }
  })

  it('has at least one compute-only item, so the minimum-lot path is exercised', () => {
    const tenant = buildFixtureTenant(new Date(BASE))
    const computeOnly = tenant.capacities
      .flatMap((capacity) => capacity.items)
      .filter((entry) => !canHoldStorage(entry.kind))

    expect(computeOnly.length).toBeGreaterThan(10)
    expect(computeOnly.every((entry) => entry.storageBytes === null)).toBe(true)
  })

  it('sums item CU to the area under the capacity own load curve', () => {
    const tenant = buildFixtureTenant(new Date(BASE))

    for (const capacity of tenant.capacities) {
      let historyFraction = 0
      for (let index = 0; index < NOW_INDEX; index += 1) historyFraction += capacity.utilization[index]
      const expected =
        historyFraction * SKU_CAPACITY_UNITS[capacity.sku] * TIMEPOINT_SECONDS

      const actual = capacity.items.reduce((sum, entry) => sum + entry.cuSeconds, 0)
      /*
       * The buildings and the power plant have to agree. If the towers summed to more CU than the
       * capacity's own curve contains, the city would be claiming work that never happened.
       */
      expect(actual).toBeCloseTo(expected, 3)
    }
  })

  it('numbers items across the whole capacity, not within each workspace', () => {
    const tenant = buildFixtureTenant(new Date(BASE))
    const contoso = tenant.capacities.find((entry) => entry.displayName === 'Contoso Analytics')!

    expect(contoso.items.map((entry) => entry.ordinal)).toEqual(
      contoso.items.map((_, index) => index),
    )
    // Ordinals must be unique across the capacity so a second page never renumbers page one.
    expect(new Set(contoso.items.map((entry) => entry.ordinal)).size).toBe(contoso.items.length)
  })
})

describe('paused capacity', () => {
  it('emits nothing at all rather than zeroes it did not measure', () => {
    const tenant = buildFixtureTenant(new Date(BASE))
    const tailspin = tenant.capacities.find((entry) => entry.displayName === 'Tailspin Archive')!

    expect(tailspin.state).toBe('Suspended')
    expect(tailspin.utilization.every((value) => value === 0)).toBe(true)
    // Storage survives a pause: the bytes are still there and still billed.
    expect(tailspin.items.some((entry) => (entry.storageBytes ?? 0) > 0)).toBe(true)
  })
})
