// Measures the atlas sidebar column at both breakpoints: unreachable pixels, the height each
// section actually got, and a trusted click on a capacity entry. Run against `npm run dev`.
import { chromium } from 'playwright'

const URL = process.env.URL ?? 'http://localhost:5173/'

const probe = () => {
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
  const drawers = [...document.querySelectorAll('.sidebar-drawer')].map((d) => ({
    summary: d.querySelector('summary')?.textContent?.trim().slice(0, 24) ?? '?',
    open: d.hasAttribute('open'),
    height: Math.round(d.getBoundingClientRect().height),
    summaryHeight: Math.round(d.querySelector('summary')?.getBoundingClientRect().height ?? 0),
    cap: getComputedStyle(d).maxHeight,
  }))
  return {
    sidebar: read('.map-sidebar'),
    drawersWrapper: read('.sidebar-drawers'),
    scrollers: [...document.querySelectorAll('.sidebar-scroll')].map((el) => ({
      client: el.clientHeight,
      scroll: el.scrollHeight,
      overflowY: getComputedStyle(el).overflowY,
      unreachable: Math.max(0, el.scrollHeight - el.clientHeight),
    })),
    drawerBodies: [...document.querySelectorAll('.sidebar-drawer-body')].map((el) => ({
      client: el.clientHeight,
      scroll: el.scrollHeight,
      unreachable: Math.max(0, el.scrollHeight - el.clientHeight),
    })),
    addressList: read('.address-list'),
    capacities: document.querySelectorAll('.address-entry').length,
  }
}

const run = async () => {
  const browser = await chromium.launch()
  const results = {}

  for (const [label, size] of [['desktop rail (1115x800)', { width: 1115, height: 800 }],
                               ['narrow sheet (720x800)', { width: 720, height: 800 }]]) {
    const page = await browser.newPage({ viewport: size })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

    await page.goto(URL, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)

    // Measure the *populated* column. An empty detail region is a short form that hides
    // exactly the height defect this script exists to find.
    const first = page.locator('.address-entry').first()
    if (await first.count()) await first.click()
    await page.waitForTimeout(600)

    // Open every drawer -- the competing-caps case is the one that overflows.
    for (const d of await page.locator('.sidebar-drawer').all()) {
      if (!(await d.getAttribute('open'))) await d.locator('summary').click()
    }
    await page.waitForTimeout(400)

    const measured = await page.evaluate(probe)

    // A *trusted* click: hit-tested, so it fails when a sibling overlaps the target.
    let click = 'no entry found'
    const entry = page.locator('.address-entry').first()
    if (await entry.count()) {
      const started = Date.now()
      try {
        await entry.click({ timeout: 4000 })
        click = `PASS in ${Date.now() - started}ms`
      } catch (e) {
        click = `FAIL after ${Date.now() - started}ms -- ${String(e).split('\n')[0]}`
      }
    }

    results[label] = { ...measured, trustedClick: click, errors: errors.slice(0, 4) }
    await page.close()
  }

  await browser.close()
  console.log(JSON.stringify(results, null, 2))
}

run().catch((e) => { console.error(e); process.exit(1) })
