import { describe, expect, it } from 'vitest'
import { createFixtureSource } from './collect/fixtureSource'
import type { CapacityAtlasItem, Evidence, ThrottleState } from './fabricContracts'
import { surveyCapacityWeather, WEATHER_SEVERITY } from './cityDisasterSurvey'

const NOW = new Date(Date.UTC(2025, 4, 14, 9, 17, 42))

const available: Evidence = {
  source: 'Fixture',
  status: 'Available',
  observedAt: NOW.toISOString(),
  freshUntil: new Date(NOW.getTime() + 300_000).toISOString(),
}

const disconnected: Evidence = {
  source: 'Fixture',
  status: 'Disconnected',
  observedAt: NOW.toISOString(),
  freshUntil: null,
}

function throttle(overrides: Partial<ThrottleState> = {}): ThrottleState {
  return {
    stage: 'None',
    interactiveDelayPercent: 20,
    interactiveRejectionPercent: 15,
    backgroundRejectionPercent: 10,
    cumulativeCarryOverPercent: 0,
    expectedBurndownMinutes: 0,
    surgeProtectionActive: false,
    evidence: available,
    ...overrides,
  }
}

async function fixtureThrottle(name: string): Promise<ThrottleState> {
  const list = (await createFixtureSource({ now: () => NOW }).readAtlas()).capacities
  const found = list.find((entry: CapacityAtlasItem) => entry.displayName === name)
  if (!found) throw new Error(`No capacity named ${name}`)
  return found.throttle
}

describe('the weather ladder is driven by the capacity throttle', () => {
  it('reads a capacity running clean under its SKU as clear', async () => {
    const survey = surveyCapacityWeather(await fixtureThrottle('Contoso Analytics'))
    expect(survey.weather).toBe('clear')
    expect(survey.evidence).toBe('measured')
    expect(survey.isDisaster).toBe(false)
  })

  it('reads interactive delay as a gathering storm, not a disaster', async () => {
    const survey = surveyCapacityWeather(await fixtureThrottle('Northwind Reporting'))
    expect(survey.weather).toBe('overcast')
    // A delay adds ~20s to a request: weather, deliberately not a blackout, matching isRejecting().
    expect(survey.isDisaster).toBe(false)
  })

  it('reads interactive rejection as a rolling blackout', async () => {
    const survey = surveyCapacityWeather(await fixtureThrottle('Litware Trading'))
    expect(survey.weather).toBe('rolling-blackout')
    expect(survey.isDisaster).toBe(true)
    expect(survey.driver).toBe('interactiveRejectionPercent')
  })

  it('reads background rejection as a full blackout', async () => {
    const survey = surveyCapacityWeather(await fixtureThrottle('Fabrikam Dev'))
    expect(survey.weather).toBe('blackout')
    expect(survey.isDisaster).toBe(true)
    expect(survey.driver).toBe('backgroundRejectionPercent')
  })

  it('grades the rungs in ascending severity, with unknown off the scale', () => {
    expect(WEATHER_SEVERITY.clear).toBeLessThan(WEATHER_SEVERITY.overcast)
    expect(WEATHER_SEVERITY.overcast).toBeLessThan(WEATHER_SEVERITY['rolling-blackout'])
    expect(WEATHER_SEVERITY['rolling-blackout']).toBeLessThan(WEATHER_SEVERITY.blackout)
    expect(WEATHER_SEVERITY.unknown).toBeLessThan(WEATHER_SEVERITY.clear)
  })

  it('drives the gathering storm from carry-forward debt even with no gate over the line', () => {
    const survey = surveyCapacityWeather(
      throttle({ cumulativeCarryOverPercent: 220 }),
    )
    expect(survey.weather).toBe('overcast')
    expect(survey.isDisaster).toBe(false)
    expect(survey.driver).toBe('cumulativeCarryOverPercent')
  })

  it('checks the most severe rung first, so a fully overloaded capacity reads as blackout', () => {
    // Litware-shaped except every gauge is over the line: the sky is the worst thing happening.
    const survey = surveyCapacityWeather(
      throttle({
        stage: 'BackgroundRejection',
        interactiveDelayPercent: 150,
        interactiveRejectionPercent: 140,
        backgroundRejectionPercent: 130,
        cumulativeCarryOverPercent: 5000,
      }),
    )
    expect(survey.weather).toBe('blackout')
  })
})

describe('an unmeasured capacity is never drawn as calm', () => {
  it('reads a paused capacity as unknown, not clear, though its stage is None like a clear one', async () => {
    const paused = await fixtureThrottle('Tailspin Archive')
    // The trap: a paused capacity has stage 'None', identical to a clear capacity's stage.
    expect(paused.stage).toBe('None')
    expect(paused.evidence.status).toBe('Disconnected')

    const survey = surveyCapacityWeather(paused)
    expect(survey.weather).toBe('unknown')
    expect(survey.weather).not.toBe('clear')
    expect(survey.evidence).toBe('none')
    expect(survey.isDisaster).toBe(false)
    // The words have to say "unknown", not imply calm.
    expect(survey.headline.toLowerCase()).not.toContain('clear')
  })

  it('reads disconnected evidence with null gauges as unknown', () => {
    const survey = surveyCapacityWeather(
      throttle({
        evidence: disconnected,
        interactiveDelayPercent: null,
        interactiveRejectionPercent: null,
        backgroundRejectionPercent: null,
        cumulativeCarryOverPercent: null,
      }),
    )
    expect(survey.weather).toBe('unknown')
    expect(survey.evidence).toBe('none')
  })

  it('withholds a verdict entirely when the source cannot gauge throttle', () => {
    const survey = surveyCapacityWeather(throttle(), { timepoints: false })
    expect(survey.weather).toBe('unknown')
    expect(survey.evidence).toBe('unsupported')
  })

  it('still reads clear from a measured healthy throttle when timepoints are supported', () => {
    const survey = surveyCapacityWeather(throttle(), { timepoints: true })
    expect(survey.weather).toBe('clear')
    expect(survey.evidence).toBe('measured')
  })
})
