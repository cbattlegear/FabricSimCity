#!/usr/bin/env node
/**
 * Retakes the three README screenshots against a running deployment.
 *
 * This exists because the images go stale silently. They are the first thing anyone sees, they
 * are binary, and no test can read them -- #109 retook them because they still showed the
 * pre-map-first product, and they went stale again one day later when #116 turned the rail's four
 * regions into an accordion. A committed script makes the next retake a command rather than an
 * afternoon of rediscovering the two details below.
 *
 *   node capture-readme-shots.js --origin https://sqlsimcity.battagler.me
 *
 * Two capture details, both learned the hard way and both invisible in the result:
 *
 * - **The clock is pinned.** `timeOfDay.ts` reads `new Date()`, so an unpinned run photographs
 *   whatever hour it happened to execute at: a midday capture washes the city out and a midnight
 *   one has almost no key light. 18:10 is the evening phase that file's own comment calls the
 *   golden hour. `page.clock` must be installed *before* anything else touches
 *   `requestAnimationFrame`.
 * - **The size is 3200x1800**, matching #109, so the README's layout does not move when the
 *   images are replaced.
 *
 * The city is given a settle window after `openCity` returns. The scene renders on demand rather
 * than on a permanent rAF loop (#90), so the frame on screen when the object count stops moving
 * is not necessarily the frame with shadows drawn -- shots taken without the wait have caught the
 * city mid-shadow-pass.
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, openCity, cityUrl, close } from './lib/city.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT = path.resolve(HERE, '..', '..', 'docs', 'images')

/** The golden hour `timeOfDay.ts` grades the evening phase from. See the header. */
const DEFAULT_CLOCK = '2026-08-28T18:10:00'
const DEFAULT_SIZE = { width: 3200, height: 1800 }

function parseArgs(argv) {
  const args = {
    origin: 'https://sqlsimcity.battagler.me',
    database: null,
    out: DEFAULT_OUT,
    clock: DEFAULT_CLOCK,
    settleMs: 2500,
    headed: true,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--origin') { args.origin = value; index += 1 }
    else if (flag === '--database') { args.database = value; index += 1 }
    else if (flag === '--out') { args.out = path.resolve(value); index += 1 }
    else if (flag === '--clock') { args.clock = value; index += 1 }
    else if (flag === '--settle-ms') { args.settleMs = Number(value); index += 1 }
    else if (flag === '--headless') { args.headed = false }
    else if (flag === '--help' || flag === '-h') { args.help = true }
  }
  return args
}

/**
 * The largest database on the instance, which is the one worth photographing.
 *
 * Read from the atlas API rather than the rendered list. The first row of the sidebar is
 * whatever sorts first -- on the demo that is `master`, a 4.6 MB city of almost nothing, next to a
 * 4.7 GB `AdventureWorks`. Picking by allocated bytes gets the picture the README is trying to
 * show without hard-coding a database name that only exists on one deployment.
 */
async function largestDatabaseId(page, origin) {
  const atlas = await page.request.get(`${origin}/api/v1/atlas`, { timeout: 120000 })
  if (!atlas.ok()) throw new Error(`atlas request failed: ${atlas.status()} ${atlas.statusText()}`)
  const body = await atlas.json()
  const databases = body.databases ?? []
  if (databases.length === 0) throw new Error('the atlas listed no databases, so there is no city to photograph')
  const largest = databases.reduce((best, candidate) =>
    Number(candidate.allocated?.bytes ?? 0) > Number(best.allocated?.bytes ?? 0) ? candidate : best)
  return largest.databaseId
}

/**
 * The atlas, photographed as the 3D surface with a fresh live sample.
 *
 * Three things make this fussy. The view mode persists across navigations, so an atlas shot taken
 * after the flat-map city comes back flat -- which is how the first run of this script produced a
 * paper atlas where every previous README had towers. It is therefore taken **first**, before
 * anything switches to `map`, and asks for `mode=city` explicitly rather than trusting the
 * default. Belt and braces, because the failure is silent: a flat atlas is a perfectly good
 * screenshot of the wrong thing.
 *
 * The third is that the live DMV sample goes stale in about twenty seconds, and the settle wait
 * lands near that boundary -- two consecutive runs produced one atlas reading `Available live` and
 * one reading `Stale live` against the same healthy server. Waiting for the freshness line to say
 * so keeps the README from advertising stale evidence on a deployment that has none. It is a
 * preference, not a requirement: if the wait expires the shot is still taken, because a slightly
 * stale atlas beats no atlas.
 */
async function shootAtlas(page, { origin, file, settleMs }) {
  await page.goto(`${origin}/?mode=city`, { waitUntil: 'domcontentloaded' })
  await page.locator('.address-entry').first().waitFor({ state: 'visible', timeout: 120000 })
  await page.waitForTimeout(settleMs)
  try {
    await page.waitForFunction(
      () => !/\bstale\b/i.test(document.body.textContent ?? ''),
      undefined,
      { timeout: 60000, polling: 500 },
    )
  } catch {
    console.log('           (live sample still reads stale; shooting anyway)')
  }
  await page.screenshot({ path: file })
}

async function shoot(page, { url, file, settleMs }) {
  const opened = await openCity(page, url)
  // See the header: render-on-demand means "laid out" and "drawn" are not the same moment.
  await page.waitForTimeout(settleMs)
  await page.screenshot({ path: file })
  return opened
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`Usage: node capture-readme-shots.js [options]

  --origin <url>      Deployment to photograph. Default https://sqlsimcity.battagler.me
  --database <id>     City to open. Default: the atlas's largest database
  --out <dir>         Where the PNGs land. Default docs/images
  --clock <iso>       Hour the city is lit for. Default ${DEFAULT_CLOCK}
  --settle-ms <n>     Wait after layout before the shutter. Default 2500
  --headless          Run without a window (usually SwiftShader; see README)
`)
    return
  }

  await mkdir(args.out, { recursive: true })
  const { browser, context } = await launch({ headed: args.headed })
  const page = await context.newPage()
  await page.clock.setFixedTime(new Date(args.clock))
  await page.setViewportSize(DEFAULT_SIZE)

  try {
    const database = args.database ?? await largestDatabaseId(page, args.origin)
    console.log(`origin   ${args.origin}`)
    console.log(`database ${database}`)
    console.log(`clock    ${args.clock}`)

    await shootAtlas(page, {
      origin: args.origin,
      file: path.join(args.out, 'atlas.png'),
      settleMs: args.settleMs,
    })
    console.log('atlas.png  server atlas (3D)')

    const city = await shoot(page, {
      url: cityUrl(args.origin, database, 'city'),
      file: path.join(args.out, 'city.png'),
      settleMs: args.settleMs,
    })
    console.log(`city.png   ${city.objectCount} objects, ${city.loadMs}ms, ${city.renderer ?? 'unknown renderer'}`)

    const map = await shoot(page, {
      url: cityUrl(args.origin, database, 'map'),
      file: path.join(args.out, 'map.png'),
      settleMs: args.settleMs,
    })
    console.log(`map.png    ${map.objectCount} objects, ${map.loadMs}ms`)
  } finally {
    await close({ browser })
  }
}

main().catch(reason => {
  console.error(reason)
  process.exitCode = 1
})
