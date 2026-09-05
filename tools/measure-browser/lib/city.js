import { chromium } from 'playwright'
import { INSTRUMENT_SOURCE } from './instrument.js'

/**
 * Opening a capacity city and getting it into the state the issue is about.
 *
 * The state that matters is the one the Fabric view reaches on its own: selecting a
 * capacity loads one capacity page, builds the city from the items in that page, and then
 * keeps the sidebar wired to the real controls a reader can use.
 */

/** The two sides of the 860px breakpoint. The sidebar is a rail above it and a sheet at or below. */
export const VIEWPORTS = {
  rail: { name: 'rail', width: 1440, height: 900 },
  sheet: { name: 'sheet', width: 820, height: 900 },
}

export async function launch({ headed = true, deviceScaleFactor = 1 } = {}) {
  /*
   * Headed by default, and worth a note.
   *
   * Headless Chromium falls back to SwiftShader on many machines, which rasterises in
   * software: frame times taken there measure a CPU renderer, not the GPU a user has. The
   * probe records the unmasked renderer string on every run so the report can say which one
   * served it, but the default is the arrangement that answers the question honestly.
   */
  const browser = await chromium.launch({
    headless: !headed,
    args: [
      '--use-angle=default',
      '--enable-gpu',
      // Long Tasks and Event Timing are on by default; this only ensures the
      // frame-rate limiter does not idle a backgrounded window mid-measurement.
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling',
    ],
  })
  const context = await browser.newContext({ deviceScaleFactor })
  return { browser, context }
}

/**
 * Installs the probe on one page.
 *
 * Deliberately per-page and deliberately last. Init scripts run in registration order, and
 * `page.clock` installs its own — which replaces `requestAnimationFrame` wholesale. Registered
 * on the context, the probe would be wrapped *underneath* the clock's replacement and would
 * silently stop seeing frames: the first run with `--clock` reported no frames at all rather
 * than failing. Registering here, after any clock, keeps the probe's wrapper outermost.
 */
export async function instrument(page) {
  await page.addInitScript(INSTRUMENT_SOURCE)
}

export function cityUrl(origin, capacityId) {
  return `${origin.replace(/\/$/, '')}/?capacity=${encodeURIComponent(capacityId)}`
}

/**
 * Loads a capacity city and waits for the Fabric fixture page to finish rendering.
 *
 * The city is ready when the viewport, canvas and directory disclosure all exist and the
 * rendered subtitle has reported a stable item count. The rendered count is deliberate:
 * it is the same number the reader sees, and the one the address book and scene were built
 * from.
 */
export async function openCity(page, url, { timeout = 900000 } = {}) {
  const startedAt = Date.now()
  await page.goto(url, { waitUntil: 'domcontentloaded' })

  await page.locator('.map-sidebar').waitFor({ state: 'visible', timeout })
  await page.locator('.city-viewport').waitFor({ state: 'visible', timeout })
  await page.locator('canvas.city-canvas').waitFor({ state: 'visible', timeout })
  await page.locator('.sidebar-directory > summary').waitFor({ state: 'visible', timeout })

  const settled = await page.waitForFunction(
    () => {
      const text = document.querySelector('.sidebar-subtitle')?.textContent ?? document.body.textContent ?? ''
      const match = text.match(/([\d,]+)\s+items/)
      const count = match ? Number(match[1].replace(/,/g, '')) : 0
      const previous = window.__cityCount ?? -1
      window.__cityCount = count
      const stableFor = count === previous ? (window.__cityStable ?? 0) + 1 : 0
      window.__cityStable = stableFor
      // Three consecutive identical readings with no loading screen up.
      return stableFor >= 3 ? count : false
    },
    undefined,
    { timeout, polling: 500 },
  )

  const itemCount = await settled.jsonValue()
  const buildings = await page.evaluate(() => {
    const measure = window.__measure
    return { renderer: measure?.rendererName ?? null, contexts: measure?.contexts ?? 0 }
  })

  return { itemCount, objectCount: itemCount, loadMs: Date.now() - startedAt, ...buildings }
}

/** Reads the number the address book was actually built from, straight off the rendered list. */
export async function addressCounts(page) {
  return page.evaluate(() => {
    const scroll = document.querySelector('.sidebar-scroll')
    return {
      entries: document.querySelectorAll('.address-entry').length,
      groups: document.querySelectorAll('.address-group').length,
      scrollNodes: scroll ? scroll.querySelectorAll('*').length : 0,
      documentNodes: document.querySelectorAll('*').length,
    }
  })
}

export async function close({ browser }) {
  await browser.close()
}
