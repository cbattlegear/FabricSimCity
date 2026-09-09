import { writeFileSync } from 'node:fs'
import { launch, instrument, openCity, cityUrl, close, VIEWPORTS } from './lib/city.js'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const origin = option('--url', 'http://localhost:5173')
const capacity = option('--capacity', '005cdd71-3dbd-4484-0060-17041100c991')
const result = { label: option('--label', 'refresh'), viewports: {} }
const session = await launch({ headed: !args.includes('--headless') })

try {
  for (const [name, size] of Object.entries(VIEWPORTS)) {
    const page = await session.context.newPage()
    await page.setViewportSize({ width: size.width, height: size.height })
    await instrument(page)
    await page.addInitScript(() => {
      window.__refreshPolls = 0
      const interval = window.setInterval.bind(window)
      window.setInterval = (callback, delay, ...args) => {
        if (delay !== 30_000 || typeof callback !== 'function') return interval(callback, delay, ...args)
        return interval(() => {
          window.__refreshPolls += 1
          callback.apply(window, args)
        }, delay)
      }
    })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const opened = await openCity(page, cityUrl(origin, capacity), { timeout: 60_000 })
    const read = () => ({
      contextRequests: window.__measure.contexts,
      polls: window.__refreshPolls,
      heading: document.querySelector('.hud-compass')?.textContent?.trim() ?? null,
      canvasWidth: document.querySelector('.city-canvas')?.clientWidth ?? 0,
      canvasHeight: document.querySelector('.city-canvas')?.clientHeight ?? 0,
      unavailable: document.querySelector('.viewport-fallback') !== null,
    })
    const initial = await page.evaluate(read)
    const started = Date.now()
    await page.locator('.sidebar-directory > summary').click({ timeout: 4000 })
    const trustedClickMs = Date.now() - started
    await page.locator('.city-canvas').press(']')
    await page.waitForTimeout(200)
    const before = await page.evaluate(read)
    const waiting = Date.now()
    await page.waitForFunction(polls => window.__refreshPolls > polls, before.polls, { timeout: 45_000 })
    await page.waitForTimeout(1800)
    const after = await page.evaluate(read)
    result.viewports[name] = {
      opened, initial, before, after, trustedClick: `PASS in ${trustedClickMs}ms`,
      waitedMs: Date.now() - waiting,
      rendererRestartsOnInput: before.contextRequests - initial.contextRequests,
      rendererRestartsOnRefresh: after.contextRequests - before.contextRequests,
      errors,
    }
    await page.close()
  }
} finally {
  await close(session)
}

const report = JSON.stringify(result, null, 2)
console.log(report)
const output = option('--json', null)
if (output) writeFileSync(output, `${report}\n`)
if (Object.values(result.viewports).some(value =>
  value.rendererRestartsOnInput !== 0 || value.rendererRestartsOnRefresh !== 0 ||
  value.before.heading === null || value.after.heading !== value.before.heading ||
  value.after.canvasWidth <= 0 || value.after.canvasHeight <= 0 ||
  value.after.unavailable || value.errors.length > 0)) process.exitCode = 1
