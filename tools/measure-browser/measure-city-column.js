/*
 * Measures the FabricSimCity *city* column at both breakpoints, plus the shadow pass and the three
 * evidence fixtures the port must not draw wrong. Runs against `npm run dev` (fixtures only, no API).
 *
 * The city is reached from the atlas: select a capacity, then "Explore this capacity as a city".
 * The rail carries an accordion now, so only one region is open at a time — that is the fix, so the
 * populated column is measured as: place card filled, one drawer open, plus the directory populated.
 */
import { launch, instrument, close } from './lib/city.js'

const URL = process.env.URL ?? 'http://localhost:5173/'

const VIEWPORTS = [
  ['rail (1115x800)', { width: 1115, height: 800 }],
  ['sheet (720x800)', { width: 720, height: 800 }],
]

const read = (sel) => {
  const el = document.querySelector(sel)
  if (!el) return null
  const cs = getComputedStyle(el)
  return {
    client: el.clientHeight,
    scroll: el.scrollHeight,
    overflowY: cs.overflowY,
    unreachable: Math.max(0, el.scrollHeight - el.clientHeight),
  }
}

const probe = () => {
  const readEl = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const cs = getComputedStyle(el)
    return {
      client: el.clientHeight,
      scroll: el.scrollHeight,
      overflowY: cs.overflowY,
      unreachable: Math.max(0, el.scrollHeight - el.clientHeight),
    }
  }
  return {
    sidebar: readEl('.map-sidebar'),
    placeCard: readEl('.sidebar-place-card'),
    feed: readEl('.sidebar-feed'),
    feedBody: readEl('.sidebar-feed-body'),
    directory: readEl('.sidebar-directory'),
    drawersWrapper: readEl('.sidebar-drawers'),
    drawers: [...document.querySelectorAll('.sidebar-drawer')].map((d) => ({
      summary: d.querySelector('summary')?.textContent?.trim().slice(0, 28) ?? '?',
      open: d.hasAttribute('open'),
      height: Math.round(d.getBoundingClientRect().height),
      summaryHeight: Math.round(d.querySelector('summary')?.getBoundingClientRect().height ?? 0),
      bodyClient: d.querySelector('.sidebar-drawer-body')?.clientHeight ?? null,
      bodyScroll: d.querySelector('.sidebar-drawer-body')?.scrollHeight ?? null,
      cap: getComputedStyle(d).maxHeight,
    })),
    scrollers: [...document.querySelectorAll('.sidebar-scroll')].map((el) => ({
      client: el.clientHeight,
      scroll: el.scrollHeight,
      unreachable: Math.max(0, el.scrollHeight - el.clientHeight),
    })),
    addressEntries: document.querySelectorAll('.address-entry').length,
    weather: document.querySelector('.city-weather-line')?.textContent?.trim() ?? null,
    clock: document.querySelector('.sidebar-feed-head strong')?.textContent?.trim() ?? null,
  }
}

async function enterCity(page, name) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.locator('.map-sidebar').waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForTimeout(800)
  await page.locator('.address-entry', { hasText: name }).first().click()
  await page.locator('.enter-city-button').click({ timeout: 10000 })
  await page.locator('.city-viewport').waitFor({ state: 'visible', timeout: 30000 })
  // The page fetch + scene build. Fixtures are synchronous-ish but the lazy chunk + WebGL take time.
  await page.waitForTimeout(3500)
}

async function openDirectory(page) {
  const dir = page.locator('.sidebar-directory > summary')
  if (await dir.count()) {
    const open = await page.locator('.sidebar-directory').getAttribute('open')
    if (open === null) await dir.click()
    await page.waitForTimeout(500)
  }
}

async function measureColumn() {
  const { browser, context } = await launch({ headed: false })
  const out = {}
  for (const [label, size] of VIEWPORTS) {
    const page = await context.newPage()
    await page.setViewportSize(size)
    await instrument(page)
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })

    await enterCity(page, 'Contoso Analytics')

    // Populate the place card by selecting an item from the directory.
    await openDirectory(page)
    const firstEntry = page.locator('.sidebar-directory .address-entry').first()
    let trustedClick = 'no entry'
    if (await firstEntry.count()) {
      const started = Date.now()
      try {
        await firstEntry.click({ timeout: 4000 })
        trustedClick = `PASS in ${Date.now() - started}ms`
      } catch (e) {
        trustedClick = `FAIL after ${Date.now() - started}ms -- ${String(e).split('\n')[0]}`
      }
      await page.waitForTimeout(400)
    }

    // Scenario A: place card + directory open (address list populated).
    await openDirectory(page)
    const withDirectory = await page.evaluate(probe)

    // Scenario B: place card + legend drawer open (closes the directory via the accordion).
    const legend = page.locator('.sidebar-drawer', { hasText: 'Legend' }).locator('summary').first()
    if (await legend.count()) { await legend.click(); await page.waitForTimeout(400) }
    const withLegendDrawer = await page.evaluate(probe)

    // Scenario C: place card + throttling-activity drawer open.
    const activity = page.locator('.sidebar-drawer', { hasText: 'Throttling activity' }).locator('summary').first()
    if (await activity.count()) { await activity.click(); await page.waitForTimeout(400) }
    const withActivityDrawer = await page.evaluate(probe)

    out[label] = { trustedClick, withDirectory, withLegendDrawer, withActivityDrawer, errors: errors.slice(0, 4) }
    await page.close()
  }
  await close({ browser })
  return out
}

function stats(values) {
  if (values.length === 0) return { n: 0, median: null, max: null }
  const sorted = [...values].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  return { n: sorted.length, median, max: sorted[sorted.length - 1] }
}

async function measureShadow() {
  const { browser, context } = await launch({ headed: false })
  const page = await context.newPage()
  await page.setViewportSize({ width: 1115, height: 800 })
  await instrument(page)
  await enterCity(page, 'Contoso Analytics')

  // Idle: nothing should be re-rendering, so the shadow pass should be silent.
  await page.evaluate(() => window.__measure.start())
  await page.waitForTimeout(1500)
  let idle = await page.evaluate(() => window.__measure.stop())

  // Camera movement: an orbit re-renders the visible scene every frame, but the shadow map is only
  // re-armed when a caster moves — so offCalls should stay ~0 with an occasional invalidation.
  await page.locator('.city-canvas').focus()
  await page.evaluate(() => window.__measure.start())
  for (let i = 0; i < 20; i += 1) {
    await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(60)
  }
  await page.waitForTimeout(500)
  const moving = await page.evaluate(() => window.__measure.stop())

  const summarise = (frames) => ({
    frames: frames.length,
    visibleCalls: stats(frames.map((f) => f.calls)),
    offscreenCalls: stats(frames.map((f) => f.offCalls)),
  })

  const result = {
    renderer: moving.renderer,
    idle: summarise(idle.frames),
    duringCameraMove: summarise(moving.frames),
  }
  await page.close()
  await close({ browser })
  return result
}

async function measureFixture(name) {
  const { browser, context } = await launch({ headed: false })
  const page = await context.newPage()
  await page.setViewportSize({ width: 1115, height: 800 })
  await instrument(page)
  await enterCity(page, name)
  // Open the activity drawer so the weather line is rendered.
  const activity = page.locator('.sidebar-drawer', { hasText: 'Throttling activity' }).locator('summary').first()
  if (await activity.count()) { await activity.click(); await page.waitForTimeout(500) }

  const info = await page.evaluate(() => {
    const text = document.body.innerText
    return {
      weather: document.querySelector('.city-weather-line')?.textContent?.trim() ?? null,
      incidentSummary: [...document.querySelectorAll('.drawer-badge')].map((b) => b.textContent?.trim()),
      vacantEntries: text.split('\n').filter((l) => /unmeasured|Vacant|not fully measured/i.test(l)).slice(0, 3),
      rejectingText: text.split('\n').filter((l) => /reject|blackout/i.test(l)).slice(0, 3),
    }
  })
  await page.locator('.city-canvas').screenshot({ path: `tools/measure-browser/city-${name.replace(/\s+/g, '-').toLowerCase()}.png` }).catch(() => {})
  await page.close()
  await close({ browser })
  return { name, ...info }
}

async function run() {
  const column = await measureColumn()
  const shadow = await measureShadow()
  const tailspin = await measureFixture('Tailspin Archive')
  const fabrikam = await measureFixture('Fabrikam Dev')
  console.log(JSON.stringify({ column, shadow, fixtures: [tailspin, fabrikam] }, null, 2))
}

run().catch((e) => { console.error(e); process.exit(1) })
