import { summarize, round } from './stats.js'
import { addressCounts } from './city.js'

/**
 * How long a *trusted* click is given before it is called a failure.
 *
 * This was 5s, which was enough before vehicles and is not enough now -- and the reason is worth
 * writing down, because the failure it produced looked like a broken control rather than a tight
 * budget. `locator.click()` hit-tests and waits for actionability, and it can only re-check that
 * on a rendered frame. A city of 4,200 objects under live load renders at ~6fps (163 ms/frame
 * measured), so a handful of re-checks alone spends most of a 5s budget: trusted clicks on the
 * orbit buttons in the same run took 2.0-2.7s each, and the plan finder's submit timed out.
 *
 * Raising the budget is the right response *because* it keeps the click trusted, which is the
 * whole point of the pass. The tempting alternatives -- `force: true`, or `element.click()` via
 * `evaluate` -- both bypass the hit-test, so they would turn this into a green line while a
 * genuinely unreachable control stayed unreachable. AGENTS.md calls that out specifically: it is
 * how issue #65's column was found to be uninteractable rather than merely unreadable.
 */
const TRUSTED_CLICK_TIMEOUT_MS = 20000

/**
 * What a keystroke in the address-book search box costs.
 *
 * Typed with `pressSequentially`, which issues trusted key events one at a time through
 * the browser's input pipeline, so React sees exactly the sequence a person would produce.
 * Setting `input.value` from `evaluate` would change the DOM without ever running the
 * event path this is trying to measure.
 *
 * The reported latency is keydown to the paint that answers it. Each keystroke narrows the
 * list further, so the first keystroke of a term is the expensive one — it is the one that
 * filters, groups, sorts and re-renders the whole book — and the ones after it work on a
 * smaller list. Both ends are reported rather than averaged into a single number that
 * describes neither.
 */
export async function typeSearch(page, term, { perKeyDelayMs = 260 } = {}) {
  const field = page.getByRole('searchbox', { name: /Search queries, tables and infrastructure/i })
  await field.waitFor({ state: 'visible' })
  // Trusted click on the field itself: hit-tested, so a search box covered by the place
  // card or a drawer fails here rather than being typed into invisibly.
  const clickStartedAt = Date.now()
  await field.click({ timeout: TRUSTED_CLICK_TIMEOUT_MS })
  const trustedClickMs = Date.now() - clickStartedAt

  const before = await addressCounts(page)

  await page.evaluate(() => window.__measure.start())
  await field.pressSequentially(term, { delay: perKeyDelayMs })
  await page.waitForTimeout(600)
  const result = await page.evaluate(() => window.__measure.stop())

  const after = await addressCounts(page)

  const perKey = result.keys.map(entry => entry.toPaintMs)
  return {
    term,
    trustedClickMs,
    keystrokes: perKey.length,
    keyToPaintMs: summarize(perKey, 1),
    firstKeyToPaintMs: round(perKey[0] ?? null, 1),
    perKeyToPaintMs: perKey.map(value => round(value, 1)),
    slowEvents: result.events.map(entry => ({
      name: entry.name,
      durationMs: round(entry.durationMs, 1),
      handlerMs: round(entry.handlerMs, 1),
    })),
    longTasksMs: result.longTasks.map(entry => round(entry.durationMs, 1)),
    blockingMs: round(
      result.longTasks.reduce((sum, entry) => sum + Math.max(0, entry.durationMs - 50), 0),
      1,
    ),
    entriesBefore: before,
    entriesAfter: after,
  }
}

/**
 * Clearing the box back to the full list.
 *
 * The other half of the cost: emptying the term re-renders every entry the book has, which
 * is the largest single render the panel ever does.
 */
export async function clearSearch(page, { term }) {
  const field = page.getByRole('searchbox', { name: /Search queries, tables and infrastructure/i })
  await field.click({ timeout: TRUSTED_CLICK_TIMEOUT_MS })
  await page.evaluate(() => window.__measure.start())
  for (let index = 0; index < term.length; index += 1) {
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(260)
  }
  await page.waitForTimeout(600)
  const result = await page.evaluate(() => window.__measure.stop())
  const perKey = result.keys.map(entry => entry.toPaintMs)
  return {
    keystrokes: perKey.length,
    keyToPaintMs: summarize(perKey, 1),
    lastKeyToPaintMs: round(perKey[perKey.length - 1] ?? null, 1),
    perKeyToPaintMs: perKey.map(value => round(value, 1)),
    entriesAfter: await addressCounts(page),
  }
}

/**
 * A trusted click on an entry in the list.
 *
 * `locator.click()` hit-tests, so this fails when the entry is covered rather than passing
 * on an element that is technically in the DOM and unreachable in practice. That is the
 * check that caught the uninteractable column in #65, and it is reported as its own line.
 */
export async function clickFirstEntry(page) {
  const entry = page.locator('.address-entry').first()
  await entry.waitFor({ state: 'visible', timeout: 10000 })
  const startedAt = Date.now()
  try {
    await entry.click({ timeout: TRUSTED_CLICK_TIMEOUT_MS })
    return { ok: true, ms: Date.now() - startedAt }
  } catch (reason) {
    return { ok: false, ms: Date.now() - startedAt, error: String(reason).split('\n')[0] }
  }
}

/**
 * Puts the sidebar into the state that has produced every layout defect this column has had.
 *
 * An empty plan finder is a short form, and a closed drawer costs its summary and nothing else,
 * so a column measured in its resting state hides the case that matters. The worst case is every
 * drawer open over real rows with a place card holding its own share of the same rail -- which is
 * exactly the arrangement #65 was measured in.
 *
 * Every interaction here is a trusted `locator.click()`. A summary that cannot be clicked because
 * its drawer was squeezed under it is the defect, so reaching this state has to fail loudly rather
 * than be forced through with `element.click()`.
 */
export async function openSidebarWorstCase(page, { populatePlanFinder = true } = {}) {
  const steps = []
  const drawers = page.locator('.sidebar-drawer')
  const count = await drawers.count()
  for (let index = 0; index < count; index += 1) {
    const drawer = drawers.nth(index)
    const summary = drawer.locator('> summary')
    const label = (await summary.textContent())?.trim() ?? `drawer ${index}`
    if (await drawer.evaluate(element => element.open)) {
      steps.push({ step: `open "${label}"`, ok: true, ms: 0, note: 'already open' })
      continue
    }
    const startedAt = Date.now()
    try {
      await summary.click({ timeout: TRUSTED_CLICK_TIMEOUT_MS })
      steps.push({ step: `open "${label}"`, ok: true, ms: Date.now() - startedAt })
    } catch (reason) {
      steps.push({ step: `open "${label}"`, ok: false, ms: Date.now() - startedAt, error: String(reason).split('\n')[0] })
    }
  }

  /*
   * An empty search term lists everything, which is the reliable way to fill the finder: Query
   * Store's capture mode decides whether any particular term matches anything, and a finder that
   * came back empty is a short form that hides every height defect in that drawer.
   */
  if (populatePlanFinder) {
    const submit = page.getByRole('button', { name: 'Route it' })
    const startedAt = Date.now()
    try {
      await submit.click({ timeout: TRUSTED_CLICK_TIMEOUT_MS })
      await page.locator('.hud-results li').first().waitFor({ state: 'visible', timeout: 30000 })
      steps.push({ step: 'populate plan finder', ok: true, ms: Date.now() - startedAt })
    } catch (reason) {
      steps.push({ step: 'populate plan finder', ok: false, ms: Date.now() - startedAt, error: String(reason).split('\n')[0] })
    }
  }

  return steps
}

/** Opens a place card by selecting an address, so the card competes for the rail like the rest. */
export async function openPlaceCard(page) {
  const entry = page.locator('.address-entry').first()
  const startedAt = Date.now()
  try {
    await entry.waitFor({ state: 'visible', timeout: 10000 })
    await entry.click({ timeout: TRUSTED_CLICK_TIMEOUT_MS })
    await page.locator('.sidebar-place-card').waitFor({ state: 'visible', timeout: TRUSTED_CLICK_TIMEOUT_MS })
    return { step: 'open place card', ok: true, ms: Date.now() - startedAt }
  } catch (reason) {
    return { step: 'open place card', ok: false, ms: Date.now() - startedAt, error: String(reason).split('\n')[0] }
  }
}

/** Heights of the sections that give way, so "no overflow" is never quoted on its own. */
export async function sidebarGeometry(page) {
  return page.evaluate(() => {
    const readElement = (element) => {
      if (!element) return null
      const style = getComputedStyle(element)
      const overflowY = style.overflowY
      const overshoot = Math.max(0, element.scrollHeight - element.clientHeight)
      /*
       * Overshoot is only *unreachable* when the box cannot scroll.
       *
       * `overflow: auto` on a 529px column holding 341,776px of list is a scroller doing its
       * job, not a defect; `overflow: hidden` on the same numbers is content the user can
       * never get to. Reporting both as one figure is how a scroll extent gets quoted as a
       * bug — and how a real clipping bug gets waved away as "it's just a long list".
       */
      const scrollable = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflowY,
        scrollExtentPx: scrollable ? overshoot : 0,
        unreachablePx: scrollable ? 0 : overshoot,
      }
    }
    const read = (selector) => readElement(document.querySelector(selector))

    /*
     * Each drawer separately, not just the wrapper.
     *
     * The wrapper's own overflow says nothing about how its budget was divided, and a division
     * that squeezes one drawer to its summary is the #63 defect wearing the wrapper's clean
     * numbers. The label is the summary text so a share can be attributed to the drawer that got
     * it, and `open` is recorded because a closed drawer costs its summary and nothing else.
     */
    const drawerList = [...document.querySelectorAll('.sidebar-drawer')].map((drawer, index) => {
      const summary = drawer.querySelector(':scope > summary')
      const body = drawer.querySelector(':scope > .sidebar-drawer-body')
      return {
        index,
        label: summary?.textContent?.trim() ?? `drawer ${index}`,
        open: drawer.open,
        summaryHeight: summary ? Math.round(summary.getBoundingClientRect().height) : null,
        maxHeight: getComputedStyle(drawer).maxHeight,
        ...readElement(drawer),
        body: readElement(body),
      }
    })
    return {
      sidebar: read('.map-sidebar'),
      /** The address list's scroller: the section that gave way to 0px in #65. */
      scroll: read('.sidebar-scroll'),
      placeCard: read('.sidebar-place-card'),
      drawers: read('.sidebar-drawers'),
      drawerCap: (() => {
        const wrapper = document.querySelector('.sidebar-drawers')
        if (!wrapper) return null
        const style = getComputedStyle(wrapper)
        return {
          budget: style.getPropertyValue('--sidebar-drawer-budget').trim() || null,
          cap: style.getPropertyValue('--sidebar-drawer-cap').trim() || null,
        }
      })(),
      eachDrawer: drawerList,
    }
  })
}
