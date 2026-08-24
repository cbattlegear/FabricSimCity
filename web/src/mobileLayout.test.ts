import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('./App.css', import.meta.url), 'utf8')
const tray = readFileSync(new URL('./MapTray.tsx', import.meta.url), 'utf8')
const city = readFileSync(new URL('./DatabaseCityViewport.tsx', import.meta.url), 'utf8')

/** The width below which the map overlays fold into the tray, read from the component itself. */
const NARROW = (() => {
  const match = tray.match(/NARROW_QUERY = '\(max-width: (\d+)px\)'/)
  if (!match) throw new Error('MapTray no longer declares NARROW_QUERY as a max-width query')
  return Number(match[1])
})()

/** Source offset of the last `@media (max-width: Npx)` block that mentions `selector`. */
function lastNarrowRuleFor(selector: string): number {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`@media \\(max-width: \\d+px\\)[\\s\\S]*?${escaped}\\s*\\{`, 'g')
  let last = -1
  for (const match of css.matchAll(pattern)) last = match.index ?? last
  return last
}

/**
 * Every `selector { … }` pair in the stylesheet, flattened.
 *
 * Regex over a whole stylesheet is what made the first version of these tests wrong twice: a
 * `[^{}]*` run walks straight past the rule it was aimed at into the next one, so `.map-tray` matched
 * a `display: none` that belonged to `.map-tray-panel .hud-legend > summary`. Splitting into rules
 * first means every assertion below is about one rule's own body.
 */
function rules(): { selector: string; body: string }[] {
  const flat = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@media[^{]*\{/g, '')
  const out: { selector: string; body: string }[] = []
  for (const match of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().replace(/\s+/g, ' ')
    if (selector.length > 0) out.push({ selector, body: match[2] })
  }
  return out
}

/** The body of the last rule whose selector list targets exactly `selector`, optionally in a state. */
function ownRule(selector: string): string | null {
  const own = rules().filter((rule) => rule.selector
    .split(',')
    .some((one) => new RegExp(`(^|\\s)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:[a-z-]+(\\([^)]*\\))?)?$`)
      .test(one.trim())))
  return own.length === 0 ? null : own[own.length - 1].body
}

describe('map overlays on a narrow viewport', () => {
  /**
   * The tray and the stylesheet have to agree on one width, or there is a band of viewports where
   * the component thinks the panels are still in their corners and the CSS has already moved them.
   * The first attempt at this shipped an 861-900px band where the legend rendered and was then
   * hidden by a rule written for a different breakpoint.
   */
  it('shares one breakpoint between MapTray and the stylesheet', () => {
    expect(css).toContain(`@media (max-width: ${NARROW}px)`)
    expect(lastNarrowRuleFor('.view-mode-tile')).toBeGreaterThan(-1)
  })

  /**
   * A media query and the base rule it overrides have the same specificity, so source order decides.
   * These rules were originally written above the overlay definitions and silently lost every one of
   * their overrides -- the phone kept the desktop sizes and the screenshot looked untouched.
   */
  it('declares its narrow overrides after the rules they override', () => {
    for (const selector of ['.view-mode-tile', '.hud-camera', '.status-chip', '.hud-bottom-right']) {
      const base = css.indexOf(`\n${selector} {`)
      expect(base, `${selector} base rule`).toBeGreaterThan(-1)
      expect(lastNarrowRuleFor(selector), `${selector} narrow override`).toBeGreaterThan(base)
    }
  })

  /**
   * The rule the whole layout is written to: a warning a narrow screen hides is a warning that was
   * not given. Folding a panel into a chip is allowed; deleting it is not.
   */
  it('never hides a map overlay outright', () => {
    for (const selector of ['.hud-bottom-left', '.map-tray', '.map-tray-chips', '.incident-summary']) {
      const body = ownRule(selector)
      expect(body, `${selector} has no rule at all`).not.toBeNull()
      expect(body, `${selector} is switched off`).not.toMatch(/display:\s*none/)
    }
  })

  /** Every overlay that leaves its corner has to turn up in the tray, not simply stop rendering. */
  it('moves the legend and the finder into the tray rather than dropping them', () => {
    expect(city).toContain('{!narrow && <div className="hud hud-bottom-left">{legend}</div>}')
    expect(city).toContain('{!narrow && finder && <div className="hud hud-top-left">{finder}</div>}')
    expect(city).toMatch(/narrow \? \[\{ id: 'legend'/)
    expect(city).toMatch(/narrow && finder \? \[\{ id: 'find'/)
  })

  /**
   * A folded tray must never read as all-clear. The chip's own label carries the finding, and a
   * genuine incident opens its panel without being asked.
   */
  it('states the incident finding on the chip and opens a real incident unasked', () => {
    expect(city).toContain('label: incidentSummaryLabel(incidents)')
    expect(city).toContain('alert: incidentDemandsAttention(incidents)')
    expect(tray).toContain('if (alerting) setOpenId(alerting)')
  })

  /** Touch targets. Anything smaller than this is a control you aim at rather than press. */
  it('keeps the compacted controls tappable', () => {
    const camera = css.slice(lastNarrowRuleFor('.hud-camera button'))
    const size = camera.match(/min-width:\s*(\d+)px;\s*min-height:\s*(\d+)px/)
    expect(size).not.toBeNull()
    expect(Number(size?.[1])).toBeGreaterThanOrEqual(36)
    expect(Number(size?.[2])).toBeGreaterThanOrEqual(36)
    expect(css).toMatch(/\.map-tray-chip\s*\{[^}]*min-height:\s*3[4-9]px/)
  })

  /**
   * The feed chip is centred at the top on a wide screen, which is exactly where the tray chips go
   * on a narrow one. Measured on a phone they overlapped, so the narrow layout stacks them.
   */
  it('stacks the feed chip above the tray chips instead of over them', () => {
    const status = css.slice(lastNarrowRuleFor('.status-chip'))
    expect(status).toMatch(/\.status-chip\s*\{[^}]*transform:\s*none/)
    expect(css.slice(lastNarrowRuleFor('.hud-top-right'))).toMatch(/\.hud-top-right\s*\{[^}]*top:\s*46px/)
  })

  /**
   * An open tray panel has to stop short of the camera controls in the opposite corner. The cap goes
   * on the tray container, and the container has to be flex there: an auto grid row overflows a
   * capped parent instead of shrinking into it, which put the last legend rows under the zoom
   * buttons the first time this was written.
   */
  it('bounds an open tray panel inside the map', () => {
    const rule = ownRule('.hud-top-right')
    expect(rule).not.toBeNull()
    expect(rule).toMatch(/max-height:\s*calc\(100% - \d+px\)/)
    expect(rule).toMatch(/display:\s*flex/)
    expect(rule).toMatch(/min-height:\s*0/)
    expect(ownRule('.map-tray')).toMatch(/min-height:\s*0/)
    expect(ownRule('.map-tray-panel')).toMatch(/overflow:\s*auto/)
  })

  /**
   * A schema-qualified object name is a single unbreakable word and some run past fifty characters.
   * Measured on a phone they ran off the side of the sidebar and were clipped: no ellipsis, no
   * scroll, no way to read the end of the name you were searching for.
   */
  it('wraps long object names in the address list instead of clipping them', () => {
    const rule = ownRule('.address-text > \\*')
    expect(css).toMatch(/\.address-text > \*\s*\{[^}]*overflow-wrap:\s*anywhere/)
    expect(css).toMatch(/\.address-text > \*\s*\{[^}]*min-width:\s*0/)
    expect(rule === null || rule.length > 0).toBe(true)
  })

  /** The narrow overrides only take effect at the narrow width, so the desktop layout is untouched. */
  it('leaves the wide layout as a grid with the panels in their own corners', () => {
    const all = rules().filter((rule) => rule.selector === '.hud-top-right')
    expect(all.length).toBeGreaterThanOrEqual(2)
    // The base rule keeps the grid and never caps its own height; only the narrow override does.
    expect(all[0].body).toMatch(/justify-items:\s*end/)
    expect(all[0].body).not.toMatch(/max-height/)
    expect(all[0].body).not.toMatch(/display:\s*flex/)
    // display: contents, so on a wide screen the tray wrapper leaves no trace in the grid.
    expect(ownRule('.tray-open')).toMatch(/display:\s*contents/)
  })
})

/**
 * A folded panel is only honest if the chip in front of it carries the finding. These pin the two
 * ways that can fail: a chip that softens a warning into a name, and a dismissal that a live warning
 * makes impossible.
 */
describe('the tray cannot fold a warning away', () => {
  const view = readFileSync(new URL('./DatabaseCityView.tsx', import.meta.url), 'utf8')

  it('says the feed connection on the chip, so a dead feed is not just "Feed"', () => {
    expect(city).toContain('`Feed · ${feedState}`')
    expect(city).toMatch(/alert:\s*feedState !== undefined && feedState !== 'connected'/)
    expect(city).toMatch(/tone:\s*feedState && feedState !== 'connected' \? 'is-unknown' : ''/)
  })

  it('is actually handed the feed state by the view that owns it', () => {
    expect(city).toMatch(/feedState\?:\s*LiveFeedConnectionState/)
    expect(view).toContain('feedState={feedState}')
  })

  it('delegates the incident wording to the module that holds the evidence', () => {
    expect(city).toContain('label: incidentSummaryLabel(incidents)')
    expect(city).toContain('tone: incidentSummaryTone(incidents)')
    expect(city).toContain('alert: incidentDemandsAttention(incidents)')
    // No local copy left behind to drift out of step with the projection.
    expect(city).not.toContain('function incidentChipLabel')
  })

  it('lets Escape close the tray outright rather than bouncing back to the alert', () => {
    expect(tray).toMatch(/event\.key === 'Escape'\) setOpenId\(null\)/)
    // Bouncing back would be a no-op whenever the alerting panel is the open one.
    expect(tray).not.toMatch(/Escape'\) setOpenId\(alerting\)/)
  })

  it('orders incidents ahead of the feed, so the self-opening panel is the blocking probe', () => {
    expect(city.indexOf("id: 'incidents'")).toBeLessThan(city.indexOf("id: 'live'"))
  })

  it('no longer claims neighbourhood names are always drawn, because declutter drops some', () => {
    expect(city).not.toContain('Neighbourhood names are always drawn')
    expect(city).toContain('the smaller neighbourhood’s name is dropped')
  })
})
