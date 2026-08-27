/**
 * The live-vehicle passes.
 *
 * Vehicles are the only thing in this scene that animates on its own. Everything else is
 * render-on-demand: the page draws when the camera moves or the data changes and is otherwise
 * completely still. That makes vehicles the one feature capable of costing something while
 * nobody is touching the machine, and it makes "does the loop stop?" a question about a
 * measurable number rather than about the shape of the code.
 *
 * Two things here are deliberately not measured the way the orbit passes are.
 *
 * `idlePass` counts **raw `requestAnimationFrame` callbacks**, not frames from the frame list.
 * The frame list only records callbacks that submitted draw calls, so a loop that re-arms
 * itself forever while drawing nothing — the classic way a "stopped" loop is not stopped — is
 * invisible in it. `__measure.rafTotal` counts every callback whatever it did, so a running
 * loop cannot hide in it.
 *
 * And the idle window takes **no input at all**. Orbit inertia runs its own loop for a moment
 * after a drag, and the render-on-demand pass draws for a frame or two after any change, so an
 * idle sample taken straight after an interaction measures those settling down and reports a
 * vehicle loop that isn't there. `settleMs` is the pause that separates the two.
 */

/** Read the vehicle roster the page itself reports, from the legend the reader sees. */
export async function vehicleCensus(page) {
  return page.evaluate(() => {
    const ladder = document.querySelector('.vehicle-ladder')
    const swatch = (klass) => {
      const node = ladder?.querySelector(`.legend-vehicle.is-${klass}`)
      if (!node) return null
      const row = node.closest('span') ?? node.parentElement
      return row ? row.textContent.trim() : null
    }
    /*
     * The disclosure is the `.mapping-note` immediately after the ladder, found by position
     * rather than by a class of its own. Adding a hook to `web/src` for the probe's benefit
     * would put a selector in the shipped build that exists only for this file — see the
     * README: nothing in the app is changed to make a measurement work.
     */
    const disclosure = ladder?.nextElementSibling?.classList.contains('mapping-note')
      ? ladder.nextElementSibling.textContent.trim()
      : null
    return {
      ladderPresent: Boolean(ladder),
      classes: {
        bike: swatch('bike'),
        car: swatch('car'),
        van: swatch('van'),
        semi: swatch('semi'),
        unknown: swatch('unknown'),
      },
      // The tail of the disclosure carries the counted-but-not-drawn cases, which is the only
      // place an unmatched query_hash or an over-cap remainder is stated.
      summary: disclosure ? disclosure.slice(-320) : null,
      canvasPresent: Boolean(document.querySelector('.map-shell canvas')),
    }
  })
}

/**
 * Sit still and count what the page does unprompted.
 *
 * Returns callbacks and draw calls per second over the window. A render-on-demand page with no
 * vehicles should report ~0 callbacks per second; a page with vehicles should report ~60, which
 * is what tells you the loop is genuinely animating rather than the roster being drawn once and
 * frozen.
 */
export async function idlePass(page, { seconds = 5, settleMs = 2500, label = 'idle' } = {}) {
  await page.waitForTimeout(settleMs)

  const before = await page.evaluate(() => ({
    raf: window.__measure.rafTotal,
    calls: window.__measure.live.calls,
    at: performance.now(),
  }))
  await page.waitForTimeout(seconds * 1000)
  const after = await page.evaluate(() => ({
    raf: window.__measure.rafTotal,
    calls: window.__measure.live.calls,
    at: performance.now(),
  }))

  const elapsedMs = after.at - before.at
  const callbacks = after.raf - before.raf
  const drawCalls = after.calls - before.calls
  return {
    label,
    windowMs: Math.round(elapsedMs),
    callbacks,
    callbacksPerSecond: Number((callbacks / (elapsedMs / 1000)).toFixed(1)),
    drawCalls,
    drawCallsPerSecond: Math.round(drawCalls / (elapsedMs / 1000)),
    // The claim this pass exists to settle, stated as a boolean so a report cannot fudge it.
    loopRunning: callbacks / (elapsedMs / 1000) > 5,
  }
}

/**
 * Frame cost while vehicles animate and the camera is still.
 *
 * This is the number that did not exist before vehicles did. Every other frame measurement in
 * this workbench is taken during a camera move, which redraws the whole city; this one is the
 * cost of the vehicle loop alone on an otherwise idle page, and it is the cost a reader pays
 * for simply leaving the tab open.
 *
 * `offscreenDrawCalls` is the line to read first. Vehicles do not cast shadows and the loop must
 * never invalidate the shadow map, so this must be **0** on every vehicle frame. Anything else
 * means the 948-call shadow pass issue #90 removed has been re-armed by the animation.
 */
export async function vehicleFramePass(page, { seconds = 5, settleMs = 2500 } = {}) {
  await page.waitForTimeout(settleMs)
  await page.evaluate(() => window.__measure.start())
  await page.waitForTimeout(seconds * 1000)
  const sample = await page.evaluate(() => window.__measure.stop())

  const frames = sample.frames
  if (frames.length === 0) {
    return { frames: 0, note: 'no frames drawn — the page was at rest for the whole window' }
  }
  const stat = (pick) => {
    const values = frames.map(pick).sort((a, b) => a - b)
    const at = (q) => values[Math.min(values.length - 1, Math.floor(values.length * q))]
    return { median: round(at(0.5)), p95: round(at(0.95)), max: round(values[values.length - 1]) }
  }
  const intervals = frames.map(frame => frame.sinceLast).filter(value => value !== null).sort((a, b) => a - b)
  const medianInterval = intervals.length ? intervals[Math.floor(intervals.length / 2)] : null

  return {
    frames: frames.length,
    windowSeconds: seconds,
    cpuMsPerFrame: stat(frame => frame.cpuMs),
    frameIntervalMs: medianInterval === null ? null : round(medianInterval),
    fps: medianInterval ? Number((1000 / medianInterval).toFixed(1)) : null,
    drawCalls: stat(frame => frame.calls),
    offscreenDrawCalls: stat(frame => frame.offCalls),
    shadowPassMs: stat(frame => frame.offMs),
    trianglesPerFrame: stat(frame => frame.tris),
    /*
     * How many frames ran a shadow pass, and where they were in the window.
     *
     * A median alone cannot answer the question this pass exists to ask. Issue #90 removed a
     * 948-call shadow pass from *every* frame; the failure mode to catch is an animation loop
     * re-arming it by setting shadowMap.needsUpdate. But the shadow map is also baked once,
     * legitimately, whenever the scene changes -- so a single frame at 948 immediately after a
     * camera or roster change is the bake, and a run of them is the regression. Reporting only
     * "max 948" cannot tell those apart and reads as a regression either way, which is how the
     * first run of this pass produced a REGRESSION marker against correct code.
     */
    offscreenFrames: frames.filter(frame => frame.offCalls > 0).length,
    offscreenFrameIndexes: frames
      .map((frame, index) => (frame.offCalls > 0 ? index : -1))
      .filter(index => index >= 0),
  }
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(1)) : value
}
