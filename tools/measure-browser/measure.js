#!/usr/bin/env node
/**
 * The browser workbench.
 *
 * Answers three questions about a large city that reading the code cannot: what a frame
 * costs while orbiting it, how many draw calls that frame submits and how many of them are
 * the shadow pass, and what one keystroke in the address book costs.
 *
 * Nothing here runs in CI, and nothing in `web/` knows it exists.
 *
 *   node measure.js --database "primary/database/SimCityLoad"
 *   node measure.js --viewport sheet --json out.json
 */

import { writeFileSync } from 'node:fs'
import { VIEWPORTS, launch, cityUrl, openCity, addressCounts, instrument } from './lib/city.js'
import { orbit, nudgeOrbit } from './lib/orbit.js'
import { vehicleCensus, idlePass, vehicleFramePass } from './lib/vehicles.js'
import {
  typeSearch,
  clearSearch,
  clickFirstEntry,
  sidebarGeometry,
  openSidebarWorstCase,
  openPlaceCard,
  openDirectory,
} from './lib/address.js'

function parseArgs(argv) {
  const args = {
    origin: 'http://127.0.0.1:5080',
    database: 'primary/database/SimCityLoad',
    viewport: 'both',
    mode: 'city',
    term: 'orders',
    headed: true,
    json: null,
    orbitSeconds: 4,
    label: null,
    screenshot: null,
    clock: null,
    size: null,
    skipOrbit: false,
    vehicles: false,
    idleSeconds: 5,
    reducedMotion: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    switch (flag) {
      case '--origin': args.origin = value; index += 1; break
      case '--database': args.database = value; index += 1; break
      case '--viewport': args.viewport = value; index += 1; break
      case '--mode': args.mode = value; index += 1; break
      case '--term': args.term = value; index += 1; break
      case '--json': args.json = value; index += 1; break
      case '--label': args.label = value; index += 1; break
      case '--screenshot': args.screenshot = value; index += 1; break
      case '--clock': args.clock = value; index += 1; break
      case '--orbit-seconds': args.orbitSeconds = Number(value); index += 1; break
      case '--size': args.size = value; index += 1; break
      case '--skip-orbit': args.skipOrbit = true; break
      case '--vehicles': args.vehicles = true; break
      case '--idle-seconds': args.idleSeconds = Number(value); index += 1; break
      case '--reduced-motion': args.reducedMotion = true; break
      case '--headless': args.headed = false; break
      case '--headed': args.headed = true; break
      case '--help':
        console.log(`Usage: node measure.js [options]

  --origin <url>        Where the app is served. Default http://127.0.0.1:5080
  --database <id>       City to open. Default primary/database/SimCityLoad
  --viewport rail|sheet|both   Which side of the 860px breakpoint. Default both
  --size <WxH>          Measure one custom viewport instead, e.g. 1115x800
  --skip-orbit          Skip the orbit and frame-cost passes (layout runs only)
  --vehicles            Add the live-vehicle passes: the roster the page reports, the
                        cost of an animating frame with the camera still, and an idle
                        window that counts rAF callbacks nobody asked for
  --idle-seconds <n>    Length of the idle window. Default 5
  --reduced-motion      Emulate prefers-reduced-motion: reduce. With --vehicles this is
                        the run that must report a stopped loop
  --mode city|map       Initial view mode. Default city
  --term <text>         What to type into the address book. Default "orders"
  --orbit-seconds <n>   Length of the orbit drag. Default 4
  --label <text>        Recorded in the output, e.g. "before" / "after"
  --screenshot <path>   Save the city after orbiting, e.g. to eyeball the shadows
  --clock <iso>         Pin the hour the city is lit for, e.g. 2026-06-21T08:30:00
  --json <path>         Write the full result, including every frame
  --headless            Run without a window (usually SwiftShader; see README)`)
        process.exit(0)
        break
      default:
        if (flag.startsWith('--')) throw new Error(`Unknown option ${flag}`)
    }
  }
  return args
}

async function measureViewport(context, viewport, args) {
  const page = await context.newPage()
  await page.setViewportSize({ width: viewport.width, height: viewport.height })

  /*
   * Emulated before the app loads, not after.
   *
   * `DatabaseCityScene` reads `prefers-reduced-motion` when it builds and does not start a
   * vehicle loop at all when it is set. Flipping the media query on an already-built scene
   * would measure a scene that had already decided, and would report the animated path while
   * claiming to report the reduced one.
   */
  if (args.reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' })

  /*
   * Collect page errors for the whole run.
   *
   * A React tree that throws unmounts the subtree under its boundary, and the next thing this
   * harness does is wait for a control inside it. The failure then surfaces as "locator timed
   * out waiting for the search box", which reads like a layout problem and is nothing of the
   * sort. Recording the exception makes the difference visible instead of leaving it to be
   * guessed at.
   */
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error?.message ?? error)))
  page.on('console', message => {
    if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`)
  })

  /*
   * Pin the hour when asked.
   *
   * The city is lit for the clock on the machine looking at it, so a run at midnight measures
   * — and photographs — a scene whose key light is almost off. `setFixedTime` fixes what `new
   * Date()` returns without touching timers, which is exactly the surface `timeOfDay.ts` reads,
   * and leaves `requestAnimationFrame` and `performance.now()` alone so the frame numbers stay
   * real. Use it to put the sun somewhere the shadows are actually visible.
   */
  if (args.clock) await page.clock.setFixedTime(new Date(args.clock))
  // After the clock, never before: see `instrument()`.
  await instrument(page)

  const url = cityUrl(args.origin, args.database, args.mode)
  const load = await openCity(page, url)

  const counts = await addressCounts(page)
  const geometry = { resting: await sidebarGeometry(page) }

  /*
   * The census is read here, before the sidebar states below, and that ordering is load-bearing.
   *
   * `openPlaceCard` replaces the drawers with the place card -- `[worstCase]` reports "drawers
   * not present" for exactly that reason -- and the vehicle ladder lives inside the legend
   * drawer. Read after it, `document.querySelector('.vehicle-ladder')` is null and the census
   * reports every class "missing from the ladder", which reads as a broken feature rather than
   * a probe looking in a DOM the probe itself dismantled. The first run of this harness said
   * "size ladder present NO" against a build whose ladder was demonstrably there.
   *
   * A closed <details> is fine: its children stay in the DOM, so the legend does not need to be
   * open for the census to find the ladder.
   */
  const census = args.vehicles ? await vehicleCensus(page) : null

  /*
   * Four states, measured in the order a reader reaches them.
   *
   * `resting` is the column as it loads, with every drawer closed. That is the state a casual
   * check sees and the one that has never had a defect in it. `planFinder` is caught mid-walk,
   * with the finder open over real rows -- the only moment it can be measured populated, since
   * the accordion closes it as soon as the next drawer opens. `drawersOpen` is the column after
   * the walk, which under an accordion means the last drawer open rather than all of them, and
   * `worstCase` adds a place card so the other claims on the rail are live alongside it -- the
   * arrangement #63 and #65 were both found in. Quoting only the first is how a squeezed column
   * gets signed off.
   */
  const { steps: sidebarSteps, planFinderGeometry } = await openSidebarWorstCase(page)
  if (planFinderGeometry) geometry.planFinder = planFinderGeometry
  geometry.drawersOpen = await sidebarGeometry(page)
  const placeCardStep = await openPlaceCard(page)
  sidebarSteps.push(placeCardStep)
  geometry.worstCase = await sidebarGeometry(page)

  const dragOrbit = args.skipOrbit ? null : await orbit(page, { seconds: args.orbitSeconds })
  const buttonOrbit = args.skipOrbit ? null : await nudgeOrbit(page)

  /*
   * The frame passes run *after* the orbit passes and take no input of their own.
   *
   * Orbit inertia keeps its own loop alive briefly after a drag and the render-on-demand pass
   * draws for a frame or two after any change, so both passes below start with a settle window.
   * Without it the idle sample catches those winding down and reports a vehicle loop that is
   * not there — which would make the "loop stops" claim pass for the wrong reason.
   */
  const vehicles = args.vehicles
    ? {
      census,
      animating: await vehicleFramePass(page, { seconds: args.idleSeconds }),
      idle: await idlePass(page, {
        seconds: args.idleSeconds,
        label: args.reducedMotion ? 'idle (reduced motion)' : 'idle',
      }),
    }
    : null

  /*
   * Captured last, and deliberately so.
   *
   * The shadow map is only regenerated when something that casts changes, so the frame worth
   * looking at is one reached entirely through camera-only controls — a drag, six azimuth
   * rotations and a few zooms, none of which invalidate. If the shadows are still under the
   * right buildings here, they survived the whole camera-only path. A capture of the first
   * frame would look correct even with invalidation broken outright.
   *
   * Zoomed in first: at the framing that holds 4,200 buildings a shadow is under a pixel wide.
   */
  if (args.screenshot) {
    const zoomIn = page.getByRole('button', { name: 'Zoom in' })
    for (let press = 0; press < 5; press += 1) {
      await zoomIn.click({ timeout: 60000 })
      await page.waitForTimeout(200)
    }
    await page.waitForTimeout(1500)
    const path = args.screenshot.replace(/(\.png)?$/i, `-${viewport.name}.png`)
    await page.screenshot({ path })
    console.log(`  screenshot: ${path}`)
  }

  /*
   * The address-book passes are last and are allowed to fail without discarding the run.
   *
   * Every pass above it is a completed measurement by this point, and throwing here threw all
   * of them away — a five-minute page walk plus the orbit and vehicle numbers, lost to a
   * locator timeout in the pass that happens to come last. The error is reported as a failed
   * pass, which is what every other reachability step in this file already does.
   */
  let search = null
  let cleared = null
  let entryClick = null
  try {
    /*
     * The place card has to be dismissed first, and this is the same trap the vehicle census
     * hit: `openPlaceCard` puts the sidebar into a mode whose place card *supersedes* the
     * address book, so by the time this pass runs the search box it is looking for no longer
     * exists. The symptom was not a clear "not found" either -- `typeSearch` waits on the
     * searchbox role with Playwright's default 30s budget, so the whole pass died on a timeout
     * that read like a slow page rather than a missing panel, and took the typing numbers and
     * the trusted entry click down with it.
     *
     * Reloading is deliberate rather than pressing Escape or clicking a close control: the
     * building place card has no close button (only the facility and road cards do), so there
     * is no interaction that reliably returns *every* card to the address book. The resting
     * state is what this pass is supposed to measure anyway.
     */
    await page.reload({ waitUntil: 'domcontentloaded' })
    /*
     * The reload also re-collapses the "City directory" disclosure, so this has to be reopened
     * here and not only in `openSidebarWorstCase`. Everything below reads `.address-entry` and
     * the searchbox, both of which live inside it.
     *
     * Waiting for the summary first is not belt-and-braces. `domcontentloaded` fires before React
     * has mounted the rail, so `openDirectory` ran against an empty document, found no
     * `.sidebar-directory`, and returned its "no directory disclosure in this view" success --
     * after which the pass sat on hidden `.address-entry` nodes for the full 120s budget. A step
     * that reports ok on a page it never touched is worse than one that fails.
     */
    await page.locator('.sidebar-directory > summary').waitFor({ state: 'visible', timeout: 120000 })
    sidebarSteps.push(await openDirectory(page))
    await page.locator('.address-entry').first().waitFor({ state: 'visible', timeout: 120000 })
    search = await typeSearch(page, args.term)
    cleared = await clearSearch(page, { term: args.term })
    entryClick = await clickFirstEntry(page)
  } catch (error) {
    pageErrors.push(`address book pass failed: ${String(error?.message ?? error)}`)
  }

  await page.close()

  return {
    viewport: { name: viewport.name, width: viewport.width, height: viewport.height },
    load,
    addressBook: counts,
    sidebarGeometry: geometry,
    sidebarSteps,
    orbit: dragOrbit,
    buttonOrbit,
    vehicles,
    search,
    cleared,
    trustedEntryClick: entryClick,
    pageErrors,
  }
}

function line(label, value) {
  return `  ${label.padEnd(34)} ${value}`
}

function report(result) {
  const out = []
  out.push(`\n=== ${result.viewport.name} (${result.viewport.width}x${result.viewport.height}) ===`)
  out.push(line('objects loaded', result.load.objectCount))
  out.push(line('load to settled', `${(result.load.loadMs / 1000).toFixed(1)} s`))
  out.push(line('GPU', result.load.renderer ?? 'unknown'))

  if (result.orbit) {
    out.push('\n  -- orbit (trusted drag) --')
    out.push(line('drag length', `${result.orbit.dragSeconds} s`))
    out.push(line('frames sampled (steady / total)', `${result.orbit.frames} / ${result.orbit.sampled}`))
    out.push(line('first frame CPU ms', result.orbit.firstFrameCpuMs))
    out.push(line('CPU ms/frame median | p95 | max',
      `${result.orbit.cpuMsPerFrame.median} | ${result.orbit.cpuMsPerFrame.p95} | ${result.orbit.cpuMsPerFrame.max}`))
    out.push(line('  shadow pass ms/frame median',
      `${result.orbit.shadowPassMsPerFrame.median} (max ${result.orbit.shadowPassMsPerFrame.max})`))
    out.push(line('frame interval ms median | p95',
      `${result.orbit.frameIntervalMs.median} | ${result.orbit.frameIntervalMs.p95}`))
    out.push(line('fps (from median interval)', result.orbit.fps))
    out.push(line('draw calls/frame median | max',
      `${result.orbit.drawCalls.median} | ${result.orbit.drawCalls.max}`))
    out.push(line('  of which offscreen (shadow)',
      `${result.orbit.offscreenDrawCalls.median} | ${result.orbit.offscreenDrawCalls.max}`))
    out.push(line('triangles/frame median',
      `${result.orbit.trianglesPerFrame.median?.toLocaleString?.() ?? result.orbit.trianglesPerFrame.median}`))
    out.push(line('  of which offscreen (shadow)',
      `${result.orbit.offscreenTriangles.median?.toLocaleString?.() ?? result.orbit.offscreenTriangles.median}`))
  }

  if (result.buttonOrbit) {
    out.push('\n  -- orbit (trusted clicks on Rotate left) --')
    out.push(line('presses', result.buttonOrbit.presses))
    out.push(line('trusted click ms each', result.buttonOrbit.trustedClickMs.join(', ')))
    out.push(line('CPU ms/frame median | max',
      `${result.buttonOrbit.cpuMsPerFrame.median} | ${result.buttonOrbit.cpuMsPerFrame.max}`))
    out.push(line('draw calls/frame median',
      `${result.buttonOrbit.drawCalls.median} (offscreen ${result.buttonOrbit.offscreenDrawCalls.median})`))
  }

  if (result.vehicles) {
    const { census, animating, idle } = result.vehicles
    out.push('\n  -- live vehicles --')
    out.push(line('size ladder present', census.ladderPresent ? 'yes' : 'NO'))
    for (const [klass, text] of Object.entries(census.classes)) {
      out.push(line(`  ${klass}`, text ?? 'missing from the ladder'))
    }
    if (census.summary) out.push(line('roster summary', census.summary))

    out.push('\n  animating, camera still:')
    if (animating.frames === 0) {
      out.push(line('  frames drawn', `0 — ${animating.note}`))
    } else {
      out.push(line('  frames drawn', `${animating.frames} over ${animating.windowSeconds}s`))
      out.push(line('  CPU ms/frame median | p95 | max',
        `${animating.cpuMsPerFrame.median} | ${animating.cpuMsPerFrame.p95} | ${animating.cpuMsPerFrame.max}`))
      out.push(line('  fps (from median interval)', animating.fps ?? 'n/a'))
      out.push(line('  draw calls/frame median | max',
        `${animating.drawCalls.median} | ${animating.drawCalls.max}`))
      /*
       * The line this whole pass exists for. Vehicles never cast shadows and the vehicle loop
       * never sets `shadowMap.needsUpdate`, so an animating frame must submit nothing offscreen
       * at all. A non-zero median here is the 948-call shadow pass from issue #90 back on every
       * frame, which is far worse than it was before: it would now be re-armed by an animation
       * that runs whether or not anyone touches the page.
       */
      out.push(line('  OFFSCREEN (shadow) calls med | max',
        `${animating.offscreenDrawCalls.median} | ${animating.offscreenDrawCalls.max}`
        + (animating.offscreenDrawCalls.max === 0 ? '  ✓ shadow pass not re-armed' : '')))
      /*
       * The verdict is about *how many* frames ran a shadow pass, not the maximum.
       *
       * One shadow frame is the legitimate re-bake after a scene change; every frame is #90's
       * regression. Judging on `max` alone marks correct code as a regression the moment a
       * bake lands inside the sample window, which it routinely does.
       *
       * Measured, with the live feed delivering a snapshot roughly every 3s: an *empty* roster
       * draws 2 frames in a 6s window and both carry 948 offscreen calls, because the only thing
       * asking for a frame is the snapshot arriving through `requestRender()`. The same window
       * with vehicles moving draws 31 frames and still only 2 of them shadow. The 29 extra frames
       * are the vehicle loop, and they cost 0 offscreen calls -- which is the claim this line
       * exists to check.
       */
      out.push(line('  shadow frames in window',
        `${animating.offscreenFrames} of ${animating.frames}`
        + (animating.offscreenFrames === 0
          ? '  ✓ no shadow pass at all'
          : animating.offscreenFrames === animating.frames && animating.frames > 5
            ? '  ← REGRESSION: every frame runs the shadow pass'
            : `  ✓ ${animating.frames - animating.offscreenFrames} loop frames at 0 offscreen calls;`
              + ` the ${animating.offscreenFrames} that shadow are scene-change re-bakes`)))
      out.push(line('  shadow pass ms/frame median', animating.shadowPassMs.median))
      out.push(line('  triangles/frame median',
        animating.trianglesPerFrame.median?.toLocaleString?.() ?? animating.trianglesPerFrame.median))
    }

    out.push(`\n  ${idle.label}, no input at all:`)
    out.push(line('  rAF callbacks in window',
      `${idle.callbacks} over ${(idle.windowMs / 1000).toFixed(1)}s (${idle.callbacksPerSecond}/s)`))
    out.push(line('  draw calls in window', `${idle.drawCalls} (${idle.drawCallsPerSecond}/s)`))
    out.push(line('  loop still running?', idle.loopRunning ? 'YES' : 'no — page is at rest'))
  }

  out.push('\n  -- address book --')
  out.push(line('entries rendered', result.addressBook.entries))
  out.push(line('nodes under .sidebar-scroll', result.addressBook.scrollNodes))
  out.push(line('document nodes', result.addressBook.documentNodes))
  if (!result.search) {
    out.push(line('typing pass', 'DID NOT RUN — see page errors below'))
  } else {
    out.push(line('trusted click on search field', `${result.search.trustedClickMs} ms`))
    out.push(line(`typing "${result.search.term}" keystrokes`, result.search.keystrokes))
    out.push(line('key-to-paint ms median | p95 | max',
      `${result.search.keyToPaintMs.median} | ${result.search.keyToPaintMs.p95} | ${result.search.keyToPaintMs.max}`))
    out.push(line('first keystroke to paint', `${result.search.firstKeyToPaintMs} ms`))
    out.push(line('per key', result.search.perKeyToPaintMs.join(', ')))
    out.push(line('long tasks during typing', result.search.longTasksMs.join(', ') || 'none'))
    out.push(line('entries after typing', result.search.entriesAfter.entries))
  }
  if (result.cleared) {
    out.push(line('clearing: last key to paint', `${result.cleared.lastKeyToPaintMs} ms`))
    out.push(line('clearing: per key', result.cleared.perKeyToPaintMs.join(', ')))
    out.push(line('entries after clearing', result.cleared.entriesAfter.entries))
  }

  out.push('\n  -- reachability --')
  for (const step of result.sidebarSteps ?? []) {
    out.push(line(`  ${step.step}`, step.ok
      ? `ok${step.note ? ` (${step.note})` : ` in ${step.ms} ms`}`
      : `FAILED: ${step.error}`))
  }
  for (const [state, boxes] of Object.entries(result.sidebarGeometry)) {
    out.push(`\n  [${state}]`)
    for (const [name, box] of Object.entries(boxes)) {
      if (name === 'eachDrawer' || name === 'drawerCap') continue
      if (!box) { out.push(line(name, 'not present')); continue }
      out.push(line(name, `${box.clientHeight}px visible, ${box.scrollHeight}px content, `
        + `overflow ${box.overflowY}, ${box.unreachablePx}px unreachable`
        + (box.scrollExtentPx ? `, ${box.scrollExtentPx}px scrollable` : '')
        /*
         * Printed for `directory` so a 0px `.sidebar-scroll` on the next line is attributable:
         * a closed disclosure and a column squeezed to nothing read the same otherwise.
         */
        + (box.open !== undefined ? `, ${box.open ? 'open' : 'CLOSED'}` : '')
        /*
         * The number that says whether the feed is a feed. Zero unreachable pixels is necessary and
         * not sufficient: as a drawer this read 0.4 rows with every overflow number clean.
         */
        + (box.rowsVisible !== undefined && box.rowsVisible !== null
          ? `, ${box.rowsVisible} of ${box.rows} rows visible at ${box.rowHeight.toFixed(1)}px`
          : '')))
    }
    if (boxes.drawerCap) {
      out.push(line('drawer budget / cap', `${boxes.drawerCap.budget || '—'} / ${boxes.drawerCap.cap || '—'}`))
    }
    for (const drawer of boxes.eachDrawer ?? []) {
      out.push(line(`  drawer "${drawer.label}"`,
        `${drawer.open ? 'open' : 'closed'}, ${drawer.clientHeight}px visible, `
        + `${drawer.scrollHeight}px content, summary ${drawer.summaryHeight}px, `
        + `max-height ${drawer.maxHeight}, ${drawer.unreachablePx}px unreachable`))
      if (drawer.body) {
        out.push(line('    body', `${drawer.body.clientHeight}px visible, ${drawer.body.scrollHeight}px content, `
          + `overflow ${drawer.body.overflowY}, ${drawer.body.unreachablePx}px unreachable`))
      }
    }
  }
  out.push('')
  out.push(line('trusted click on first entry',
    !result.trustedEntryClick
      ? 'DID NOT RUN'
      : result.trustedEntryClick.ok
        ? `passed in ${result.trustedEntryClick.ms} ms`
        : `FAILED: ${result.trustedEntryClick.error}`))
  if (result.pageErrors?.length) {
    out.push('\n  -- page errors --')
    for (const error of result.pageErrors.slice(0, 12)) out.push(`    ${error}`)
    if (result.pageErrors.length > 12) out.push(`    ... and ${result.pageErrors.length - 12} more`)
  }
  return out.join('\n')
}

const args = parseArgs(process.argv.slice(2))
/*
 * `--size` measures one arbitrary viewport instead of the two presets. 1115x800 is the size
 * `AGENTS.md` prescribes for the drawer budget, and it is neither of them: it is a rail, but a
 * short one, which is where a budget that fits at 1440x900 stops fitting.
 */
const custom = args.size
  ? (() => {
    const match = /^(\d+)x(\d+)$/.exec(args.size)
    if (!match) throw new Error(`--size wants WxH, e.g. 1115x800; got ${args.size}`)
    return [{ name: args.size, width: Number(match[1]), height: Number(match[2]) }]
  })()
  : null
const wanted = custom
  ?? (args.viewport === 'both' ? [VIEWPORTS.rail, VIEWPORTS.sheet] : [VIEWPORTS[args.viewport]])
if (wanted.some(viewport => !viewport)) throw new Error(`Unknown viewport ${args.viewport}`)

const { browser, context } = await launch({ headed: args.headed })
const results = []
try {
  for (const viewport of wanted) {
    const result = await measureViewport(context, viewport, args)
    results.push(result)
    console.log(report(result))
  }
} finally {
  await browser.close()
}

if (args.json) {
  writeFileSync(args.json, JSON.stringify({
    label: args.label,
    origin: args.origin,
    database: args.database,
    mode: args.mode,
    at: new Date().toISOString(),
    results,
  }, null, 2))
  console.log(`\nWrote ${args.json}`)
}
