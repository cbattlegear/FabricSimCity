import type { ThrottleState } from './fabricContracts'
import type { CapacitySourceCapabilities } from './collect/source'
import { isThrottleStageActive } from './powerGrid'

/*
 * The survey that decides what the weather is.
 *
 * In the SQL build this read compiled plans across the workload to find fires and burst mains. On
 * Fabric the weather has one honest driver — the capacity's own throttle state — because a Fabric
 * capacity *is* a power grid. The SKU is the plant's rated output, CU smoothing is a reservoir, and
 * carry-forward is accumulated debt. Throttling escalates through three gates, and that escalation
 * is a brownout -> rolling blackout ladder that fits weather-and-disaster far better than the SQL
 * health signals it replaces.
 *
 * The distinction the atlas holds in `isRejecting()` is the one that matters most here: an
 * interactive *delay* adds ~20s to a request — a busy city, not a broken one — so it is weather, not
 * a disaster. Only the rejection gates turn work away, and only those are drawn as a blackout.
 */

/**
 * The city's sky, driven by the capacity's throttle ladder.
 *
 * - `clear` — a measured capacity running clean under its SKU. A *positive* claim that nothing is
 *   wrong, and only ever returned from measured telemetry.
 * - `overcast` — a gathering storm: interactive requests are being delayed, or the capacity is
 *   burning carry-forward it has not paid down. The brownout rung. Weather, not a disaster.
 * - `rolling-blackout` — interactive work is being refused while background work still flows.
 * - `blackout` — the 24-hour gauge is over the line and every class of work is being refused.
 * - `unknown` — no throttle telemetry at all. Deliberately *not* `clear`: a paused capacity and a
 *   calm one produce identical zeroes and are completely different things, so an unmeasured sky is
 *   drawn overcast-and-unknown rather than as sunshine.
 */
export type CityWeather = 'clear' | 'overcast' | 'rolling-blackout' | 'blackout' | 'unknown'

/** Which measured gauge drove the verdict, so a renderer or panel can cite it rather than guess. */
export type WeatherDriver =
  | 'interactiveDelayPercent'
  | 'interactiveRejectionPercent'
  | 'backgroundRejectionPercent'
  | 'cumulativeCarryOverPercent'
  | null

/**
 * Whether the weather could be read at all, in the same three-state shape `cityTraffic.ts` uses for
 * roads — because it is the same problem. A source that cannot report throttle timepoints, and a
 * capacity that reports none because it is paused, both mean "cannot know", and neither is the same
 * claim as a measured-quiet capacity.
 *
 * - `unsupported` — the source cannot gauge throttle at all (`capabilities.timepoints` is false).
 * - `none` — the source can gauge throttle, but this capacity emitted none (paused/disconnected).
 * - `measured` — throttle gauges were reported, so a real weather rung is claimed.
 *
 * Both `unsupported` and `none` yield `unknown` weather. They are kept distinct so the disclosure
 * can say *why* it cannot know, exactly as the road layer does.
 */
export type WeatherEvidenceState = 'measured' | 'none' | 'unsupported'

export interface WeatherSurvey {
  weather: CityWeather
  evidence: WeatherEvidenceState
  /**
   * True only for the two rejection rungs. A delay or a gathering storm is weather; promoting either
   * to a disaster would cry wolf, which is the mistake `isRejecting()` exists to avoid.
   */
  readonly isDisaster: boolean
  readonly driver: WeatherDriver
  readonly headline: string
  readonly detail: string
}

/**
 * Whether the throttle carries a real measurement.
 *
 * A paused capacity reports `stage: 'None'` with every gauge null and `Disconnected` evidence —
 * byte-identical in `stage` to a genuinely clear capacity. So the stage cannot be trusted on its
 * own: the weather is measured only when the evidence reports a reading *and* at least one gauge is
 * a real number. Anything else is "cannot know", never "calm".
 */
function throttleMeasured(throttle: ThrottleState): boolean {
  const reports = throttle.evidence.status === 'Available' || throttle.evidence.status === 'Stale'
  const hasGauge =
    isFiniteNumber(throttle.interactiveDelayPercent) ||
    isFiniteNumber(throttle.interactiveRejectionPercent) ||
    isFiniteNumber(throttle.backgroundRejectionPercent) ||
    isFiniteNumber(throttle.cumulativeCarryOverPercent)
  return reports && hasGauge
}

function isFiniteNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value)
}

function unknownSurvey(evidence: 'none' | 'unsupported'): WeatherSurvey {
  return {
    weather: 'unknown',
    evidence,
    isDisaster: false,
    driver: null,
    headline:
      evidence === 'unsupported'
        ? 'This source cannot report the capacity throttle.'
        : 'The capacity reported no throttle telemetry.',
    detail:
      evidence === 'unsupported'
        ? 'The sky is drawn overcast-and-unknown rather than clear: a source that cannot gauge '
          + 'throttle has no basis to claim the capacity is running calm.'
        : 'The sky is drawn overcast-and-unknown rather than clear. A paused or disconnected '
          + 'capacity emits no telemetry, and an unmeasured capacity must never render as calm — '
          + 'calm is a positive claim that nothing is wrong, which is not what "no data" means.',
  }
}

/**
 * Reads the capacity's weather from its throttle state.
 *
 * Pure and synchronous: the driving telemetry already rides on every `CapacityCityPage.throttle` and
 * `CapacityAtlasItem.throttle`, so unlike the SQL survey this needs no network pass. Compose it with
 * the power-grid roster rather than re-deriving the gauges — `isThrottleStageActive` is the same
 * over-the-line test the gates use, so a gate and the sky above it can never disagree.
 *
 * The rungs are checked most-severe first because the stages are cumulative: a capacity over the
 * 24-hour line is over the other two as well, and the sky should read as the worst thing happening.
 */
export function surveyCapacityWeather(
  throttle: ThrottleState,
  capabilities?: Pick<CapacitySourceCapabilities, 'timepoints'>,
): WeatherSurvey {
  if (capabilities && !capabilities.timepoints) return unknownSurvey('unsupported')
  if (!throttleMeasured(throttle)) return unknownSurvey('none')

  if (isThrottleStageActive(throttle, 'BackgroundRejection') === true) {
    return {
      weather: 'blackout',
      evidence: 'measured',
      isDisaster: true,
      driver: 'backgroundRejectionPercent',
      headline: 'Blackout — the 24-hour gauge is over the line and every class of work is refused.',
      detail:
        `The background-rejection gauge reads ${percent(throttle.backgroundRejectionPercent)} of the `
        + 'SKU budget averaged over 24 hours. Past the line, even background work is turned away; '
        + 'this is the whole grid down, not a brownout.',
    }
  }

  if (isThrottleStageActive(throttle, 'InteractiveRejection') === true) {
    return {
      weather: 'rolling-blackout',
      evidence: 'measured',
      isDisaster: true,
      driver: 'interactiveRejectionPercent',
      headline: 'Rolling blackout — interactive work is being refused while background work flows.',
      detail:
        `The interactive-rejection gauge reads ${percent(throttle.interactiveRejectionPercent)} of the `
        + 'SKU budget averaged over 60 minutes. Interactive requests are refused outright, but the '
        + '24-hour gauge is still under the line, so background work continues — a rolling outage.',
    }
  }

  const delayActive = isThrottleStageActive(throttle, 'InteractiveDelay') === true
  const debt = isFiniteNumber(throttle.cumulativeCarryOverPercent) && throttle.cumulativeCarryOverPercent > 0
  if (delayActive || debt) {
    return {
      weather: 'overcast',
      evidence: 'measured',
      isDisaster: false,
      driver: delayActive ? 'interactiveDelayPercent' : 'cumulativeCarryOverPercent',
      headline: delayActive
        ? 'Gathering storm — interactive requests are being delayed but nothing is refused yet.'
        : 'Gathering storm — the capacity is carrying forward debt it has not paid down.',
      detail: delayActive
        ? `The interactive-delay gauge reads ${percent(throttle.interactiveDelayPercent)} of the SKU `
          + 'budget over the 10-minute window, so interactive requests wait about 20 seconds. That is '
          + 'a busy city, not a broken one — weather, and deliberately not drawn as a blackout.'
        : `Carry-forward debt stands at ${percent(throttle.cumulativeCarryOverPercent)} of the SKU `
          + 'budget. Overage the reservoir could not absorb is being burned down against future '
          + 'capacity; while it stands, the storm is gathering even if no gate is over the line yet.',
    }
  }

  return {
    weather: 'clear',
    evidence: 'measured',
    isDisaster: false,
    driver: null,
    headline: 'Clear — the capacity is running clean under its SKU.',
    detail:
      'Every throttle gauge is under its line and no carry-forward debt is outstanding. This is a '
      + 'measured "nothing is wrong", not the absence of data — an unmeasured capacity is drawn '
      + 'overcast-and-unknown instead.',
  }
}

function percent(value: number | null): string {
  return isFiniteNumber(value) ? `${value.toFixed(1)}%` : 'an unreported share'
}

/** Where each rung sits on the ladder, so a renderer can pick a sky gradient without a switch. */
export const WEATHER_SEVERITY: Readonly<Record<CityWeather, number>> = Object.freeze({
  clear: 0,
  overcast: 1,
  'rolling-blackout': 2,
  blackout: 3,
  // Unknown is off the severity scale on purpose: it is not "worse than clear", it is "not known".
  unknown: -1,
})
