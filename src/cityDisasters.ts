import type { CapacityCityItem } from './capacityCityContracts'
import type { ThrottleState } from './fabricContracts'
import type { CapacitySourceCapabilities } from './collect/source'
import {
  surveyCapacityWeather,
  type CityWeather,
  type WeatherSurvey,
} from './cityDisasterSurvey'

/*
 * The disaster model.
 *
 * In the SQL build this combined a routed plan, deadlock graphs, missing-index suggestions and
 * showplan warnings into drawable disasters. None of those have a Fabric field behind them — the
 * showplan modules that fed them were deleted, not ported — so this is rebuilt on the one signal
 * Fabric does emit: the capacity throttle ladder, plus the per-item rejection counts that say which
 * buildings actually had work refused.
 *
 * Two levels of evidence, deliberately separate:
 *  - The capacity-wide weather (via `cityDisasterSurvey`), which is the sky over the whole city.
 *  - The buildings the blackout actually struck, drawn only from a *measured* rejected count. A
 *    building with a null rejected count was not measured, not proven clear, and is never struck.
 */

export type CityDisasterKey = 'rolling-blackout' | 'blackout' | 'struck-buildings'

export interface CityDisaster {
  readonly key: CityDisasterKey
  readonly headline: string
  readonly detail: string
}

export interface CityDisasterProjection {
  /** The sky over the whole city. `unknown` when the throttle could not be read — never `clear`. */
  readonly weather: CityWeather
  /** The full weather verdict, so a caller can render the sky and cite its driver. */
  readonly survey: WeatherSurvey
  /** Active disaster banners: the capacity-wide rejection, and the struck buildings if any. */
  readonly items: readonly CityDisaster[]
  /**
   * Items whose own work was refused, drawn from a measured `rejected` count greater than zero.
   * These are the buildings on fire; every other building is left alone.
   */
  readonly blackedOutItemIds: readonly string[]
  /**
   * True when at least one item reported a rejected count at all, measured or zero.
   *
   * Distinguishes "no building had work refused" from "no building's outcomes were measured", which
   * is the difference between a city with no fires and a city nobody surveyed — the same line the
   * SQL build drew with `missingIndexesObserved`.
   */
  readonly rejectionsObserved: boolean
}

/**
 * Combines the capacity weather with the items to say what is on fire and where.
 *
 * `throttle` is `CapacityCityPage.throttle`, which already carries the capacity-wide state. `items`
 * are the buildings the page drew. `capabilities` is optional and only used to tell "this source
 * cannot gauge throttle" from "this capacity reported none" — pass the source's own capabilities so
 * an Eventhouse-fed city says the sky is unknown rather than implying it is calm.
 */
export function projectCityDisasters(input: {
  throttle: ThrottleState
  items: readonly CapacityCityItem[]
  capabilities?: Pick<CapacitySourceCapabilities, 'timepoints'>
}): CityDisasterProjection {
  const survey = surveyCapacityWeather(input.throttle, input.capabilities)

  let rejectionsObserved = false
  const blackedOutItemIds: string[] = []
  for (const item of input.items) {
    const rejected = parseCount(item.operations.rejected)
    // A null count is unmeasured, not zero: the Eventhouse feed omits the column entirely. Skip it
    // rather than counting it as a building proven clear.
    if (rejected === null) continue
    rejectionsObserved = true
    if (rejected > 0) blackedOutItemIds.push(item.itemId)
  }

  const items: CityDisaster[] = []

  if (survey.isDisaster) {
    items.push({
      key: survey.weather === 'blackout' ? 'blackout' : 'rolling-blackout',
      headline: survey.headline,
      detail: survey.detail,
    })
  }

  if (blackedOutItemIds.length > 0) {
    const count = blackedOutItemIds.length
    items.push({
      key: 'struck-buildings',
      headline: `${count} building${count === 1 ? '' : 's'} had work refused`,
      detail:
        `${count} item${count === 1 ? ' has' : 's have'} a measured rejected-operation count above `
        + 'zero, so the blackout is drawn on those buildings specifically rather than washed over '
        + 'the whole city. A building with no measured rejection count is left alone — its outcomes '
        + 'were not read, which is not the same as none being refused.',
    })
  }

  return {
    weather: survey.weather,
    survey,
    items,
    blackedOutItemIds,
    rejectionsObserved,
  }
}

/**
 * A decimal operation count as a number, or null when it is absent or unparseable.
 *
 * Counts are decimal strings and any of them may be null, meaning the source did not report that
 * column. Null must stay null all the way through so an unmeasured building is never treated as one
 * measured at zero.
 */
export function parseCount(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null
  return Number(value)
}
