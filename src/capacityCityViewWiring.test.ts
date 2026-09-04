import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/*
 * Source-text guards over the *wiring* the Fabric city view adds around the (separately unit-tested)
 * domain modules. The rules each one protects are the ones that render an unmeasured capacity as a
 * guess: a paused capacity must not draw as an idle one. The domain functions hold the rule; these
 * check the view actually calls them the honest way rather than re-deriving a zero. Each assertion
 * below was mutation-checked against the broken wiring before being committed.
 */
function sourcePath(name: string): string {
  const shipped = resolve(process.cwd(), 'src', name)
  return existsSync(shipped) ? shipped : resolve(process.cwd(), 'src', 'pending-port', name)
}

const view = readFileSync(sourcePath('CapacityCityView.tsx'), 'utf8')

/** Source with block and line comments stripped, for negative assertions. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('the city view wires the missing-rather-than-zero rules', () => {
  it('draws the fires from the measured rejected count, not a whole-city flag', () => {
    // `blackedOutItemIds` is only the items with a *measured* rejected count > 0 (cityDisasters skips
    // a null count rather than counting it clear). Feeding anything else to setFireObjects would burn
    // buildings whose outcomes were never measured.
    expect(code(view)).toMatch(/fireObjectIds\s*=\s*useMemo\(\(\)\s*=>\s*disasters\?\.blackedOutItemIds/)
    expect(code(view)).toContain('fireObjectIds={fireObjectIds}')
  })

  it('reads the sky from the survey, so unknown weather is never redrawn as clear', () => {
    // The WeatherLine renders survey.weather verbatim; `unknown` gets its own branch and never falls
    // through to the clear/sunshine wording.
    expect(view).toContain('weather={disasters.weather}')
    expect(view).toMatch(/weather === 'unknown'/)
    expect(view).toContain("Weather: unknown — not observed")
  })

  it('surfaces the incident evidence through the module that holds the "not observed" rule', () => {
    // incidentSummaryLabel returns "Not observed" for an unsupported source; the view must show that
    // label rather than inventing a "No throttling" of its own.
    expect(view).toContain('{incidentSummaryLabel(incidents)}')
    expect(code(view), 'the view hard-codes a clean bill of health of its own')
      .not.toMatch(/No throttling observed/)
  })

  it('mounts the timepoint clock and disposes it on unmount', () => {
    // startTimepointClock is a cancellable poller that returns a disposer; the effect must return it
    // or a tab left open leaks a clock per capacity opened.
    expect(view).toContain('startTimepointClock({ source, capacityId, onFeed: setFeed })')
    expect(view).toMatch(/const dispose = startTimepointClock[\s\S]*?return \(\) => dispose\(\)/)
  })

  it('withholds the road layer when the source cannot report families', () => {
    // gradeRoads is only called when describeTrafficEvidence says drawRoads; an unsupported source
    // gets an empty road set and a withheld-layer disclosure, not an empty-but-measured city.
    expect(code(view)).toMatch(/if \(!page \|\| !trafficEvidence\.drawRoads\) return \[\]/)
  })
})
