/**
 * What the guided tour costs, measured in a real browser at both breakpoints.
 *
 *   node measure-tour.js
 *   node measure-tour.js --viewport rail --seconds 20 --json tour.json
 *
 * A separate entry point from `measure.js` rather than another pass inside it, because the two
 * answer different questions and `measure.js` already takes minutes per viewport. This one needs
 * the same fixture-backed Vite app: run `npm run dev` at the repository root and point this probe
 * at that origin. There is no API process or SQL Server in FabricSimCity.
 */

import { writeFileSync } from 'node:fs'
import { VIEWPORTS, launch, cityUrl, openCity, instrument, close } from './lib/city.js'
import { tourPass } from './lib/tour.js'

function parseArgs(argv) {
  const args = {
    origin: 'http://localhost:5173',
    capacity: '005cdd71-3dbd-4484-0060-17041100c991',
    viewport: 'both',
    seconds: 12,
    json: null,
    label: null,
    headed: true,
    control: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    switch (flag) {
      case '--origin': args.origin = value; index += 1; break
      case '--capacity': args.capacity = value; index += 1; break
      case '--viewport': args.viewport = value; index += 1; break
      case '--seconds': args.seconds = Number(value); index += 1; break
      case '--json': args.json = value; index += 1; break
      case '--label': args.label = value; index += 1; break
      case '--headless': args.headed = false; break
      case '--control': args.control = true; break
      case '--help':
        console.log(`Usage: node measure-tour.js [options]

  --origin <url>       Where the Vite app is served. Default http://localhost:5173
  --capacity <id>      Capacity city to open. Default Contoso Analytics fixture
  --viewport rail|sheet|both   Which side of the 860px breakpoint. Default both
  --seconds <n>        How long to let the tour fly per viewport. Default 12
  --json <path>        Write the full report
  --label <text>       Tag the report, e.g. before/after
  --control            Never click the toggle. Runs the identical pass with the tour
                       switched off, so the post-drag idle rate has something honest to
                       be compared against on an instance that is busy anyway.
  --headless           Headless Chromium. Falls back to SwiftShader on many machines,
                       so frame times from it measure a CPU renderer.`)
        process.exit(0)
        break
      default: break
    }
  }
  return args
}

async function runViewport(args, viewport) {
  const { browser, context } = await launch({ headed: args.headed })
  const page = await context.newPage()
  await page.setViewportSize({ width: viewport.width, height: viewport.height })
  await instrument(page)

  const load = await openCity(page, cityUrl(args.origin, args.capacity))
  console.log(
    `  loaded ${load.itemCount ?? load.objectCount} items in ${(load.loadMs / 1000).toFixed(1)}s on ${load.renderer ?? 'unknown renderer'}`,
  )

  const tour = await tourPass(page, { seconds: args.seconds, control: args.control })
  await close({ browser, context })
  return { viewport: `${viewport.name} ${viewport.width}x${viewport.height}`, load, tour }
}

const args = parseArgs(process.argv.slice(2))
const chosen =
  args.viewport === 'both' ? [VIEWPORTS.rail, VIEWPORTS.sheet] : [VIEWPORTS[args.viewport]]

const results = []
for (const viewport of chosen) {
  console.log(`\n=== ${viewport.name} ${viewport.width}x${viewport.height} ===`)
  results.push(await runViewport(args, viewport))
}

for (const result of results) {
  const { tour } = result
  console.log(`\n--- ${result.viewport} ---`)
  console.log(`  trusted click on the toggle: ${tour.control ? 'skipped (control run)' : `${tour.trustedClick.ok ? 'PASS' : 'FAIL'} (${tour.trustedClick.ms}ms)${tour.trustedClick.error ? ' ' + tour.trustedClick.error : ''}`}`)
  console.log(`  caption mounted:             ${tour.started.captionMounted ? 'yes' : 'NO'} — ${tour.started.kind} / ${tour.started.caption} / ${tour.started.detail}`)
  const geometry = tour.captionGeometry
  if (geometry) {
    console.log(`  caption geometry:            client ${geometry.clientWidth}x${geometry.clientHeight}, scroll ${geometry.scrollWidth}x${geometry.scrollHeight}, overflow-y ${geometry.overflowY}`)
    console.log(`  unreachable pixels:          ${geometry.unreachable}`)
    console.log(`  fully on screen:             ${geometry.onScreen ? 'yes' : 'NO'} (${JSON.stringify(geometry.rect)} in ${geometry.viewport.width}x${geometry.viewport.height})`)
  }
  console.log(`  road readout suppressed:     ${tour.started.roadReadoutMounted ? 'NO' : 'yes'}`)
  console.log(`  camera moved:                ${tour.itinerary.cameraMoved ? 'yes' : 'NO'} (${tour.itinerary.distinctHeadings} distinct headings)`)
  console.log(`  itinerary advanced:          ${tour.itinerary.advanced ? 'yes' : 'NO'} (${tour.itinerary.distinctCaptions} stops over ${tour.itinerary.samples} samples)`)
  console.log(`  kinds visited:               ${tour.itinerary.kinds.join(', ') || 'none'}`)
  const flight = tour.flight
  console.log(`  frames:                      ${flight.frames ?? 0}`)
  if (flight.cpuMsPerFrame) console.log(`  cpu ms/frame:                median ${flight.cpuMsPerFrame.median}, p95 ${flight.cpuMsPerFrame.p95}, max ${flight.cpuMsPerFrame.max}`)
  if (flight.fps) console.log(`  fps (median interval):       ${flight.fps}`)
  if (flight.drawCalls) console.log(`  draw calls/frame:            median ${flight.drawCalls.median}, max ${flight.drawCalls.max}`)
  if (flight.offscreenDrawCalls) console.log(`  offscreen (shadow):          median ${flight.offscreenDrawCalls.median}, max ${flight.offscreenDrawCalls.max}`)
  if (flight.shadowPassMsPerFrame) console.log(`  shadow pass ms/frame:        median ${flight.shadowPassMsPerFrame.median}, max ${flight.shadowPassMsPerFrame.max}`)
  console.log(`  idle callbacks/s before:     ${tour.idleCallbacksBefore.perSecond}`)
  console.log(`  drag ends the tour:          ${tour.endedByDrag.stopped ? 'PASS' : 'FAIL'} (pressed=${tour.endedByDrag.pressed}, caption=${tour.endedByDrag.captionMounted})`)
  console.log(`  live vehicles at idle:       ${tour.endedByDrag.vehicles ?? 'unknown'}`)
  console.log(`  went quiet after drag:       ${tour.settling.quiet ? 'yes' : 'NO'} (${tour.settling.settledAfterMs}ms of OrbitControls damping)`)
  console.log(`  loop stopped after:          ${tour.loopStopped ? 'PASS' : 'FAIL'} (${tour.idleCallbacksAfter.perSecond}/s against a ${tour.stoppedThreshold}/s ceiling; the tour flew at ${tour.flight.fps ?? '?'}/s)`)
}

if (args.json) {
  writeFileSync(args.json, JSON.stringify({ label: args.label, at: new Date().toISOString(), results }, null, 2))
  console.log(`\nWrote ${args.json}`)
}
