# Measuring what a Fabric capacity city costs the browser

A real browser, a real GPU, the fixture-backed FabricSimCity app, and numbers for the things source-text tests cannot see: frame cost while orbiting, WebGL draw submissions split by visible versus offscreen targets, sidebar reachability, and trusted input latency.

This exists because `AGENTS.md` is binding: *a UI change is not verified until it has been measured in a running browser*. The test suite reads `src/App.css` as source text and cannot see the layout or frame time that results. This workbench is kept with the repo so those measurements stay reproducible.

## What it measures, and why each number is trustworthy

**Draw calls and triangles come from the WebGL context, not from `renderer.info`.** `WebGLRenderingContext.prototype.drawElements` and friends are wrapped before any application script runs. The wrapper tracks whether a draw target is the default framebuffer or an offscreen framebuffer; three.js renders the shadow map offscreen, so the `offscreen` line is the shadow-pass evidence to read first.

**Frame cost is the main-thread time inside the app's own `requestAnimationFrame` callback.** The probe reports callback CPU time alongside frame interval, because either number alone can mislead.

**Interaction latency is keydown to the paint that answers it.** A capture-phase listener starts the clock before React sees the key, and a `MessageChannel` posted from `requestAnimationFrame` stops it after the answering frame is presented.

**Input is trusted.** The orbit is driven with `page.mouse`, typing with `pressSequentially`, and clicks with `locator.click()`. A forced click or `element.click()` would bypass hit-testing and can pass while a covered control is still unusable.

**Both breakpoints matter.** The sidebar is a rail above 860px and a bottom sheet at or below it, so the main probes run both sides unless told otherwise.

## Standing it up

FabricSimCity has no local .NET API or SQL Server. The current development loop is the fixture-backed Vite app:

```powershell
npm run dev
```

Then, in another shell:

```powershell
cd tools\measure-browser
node measure.js --headless
```

Install dependencies only if this workbench has not been set up on the machine already:

```powershell
npm install
npx playwright install chromium
```

## Opening a city

The app opens a city with `?capacity=<capacity-id>`. The default probes use the deterministic fixture id for **Contoso Analytics**:

```text
005cdd71-3dbd-4484-0060-17041100c991
```

Use `--capacity <id>` to point at a different capacity. The app does not read the old city-view/database query parameters or an API atlas endpoint.

## Reading the run

Two lines in the report are easy to misread:

- **`offscreen (shadow)`** is draw calls submitted into a render target rather than the canvas. With on-demand shadows working, camera movement has a median of 0 with only occasional spikes when scene contents change. A steady high value means the shadow pass was re-armed every frame; a steady 0 in a run that should include a scene-change bake can mean shadows were switched off.
- **`unreachable` versus `scrollable`.** Overshoot only counts as unreachable when the box cannot scroll. A long list under `overflow: auto` is a working scroller; the same list under `overflow: hidden` is clipped content.
- **One sidebar state per open region.** `CapacityCityView.tsx` uses one `openRegion`, so the city directory and drawers are measured one at a time. Fabric has no captured-plan route takeover; if a future lineage-route panel returns, add a new honest pass rather than silently weakening the old one.

## Scripts

- `measure.js` — full city workbench: layout states, address-book input, orbit cost, optional vehicle idle/animation passes, and optional screenshots.
- `measure-tour.js` — guided-tour loop cost, caption geometry, trusted tour toggle, and whether the loop stops after a user drag.
- `measure-disasters.js` — screenshot-based component measurements for fires, water jets, puddles, and wrecks during the tour.
- `measure-city-column.js` — fixture city column reachability, shadow-pass, and evidence readout smoke measurement.
- `measure-atlas-column.js` — atlas sidebar reachability and trusted click check against `npm run dev`.

## Headed by default, and why that matters

Headless Chromium falls back to SwiftShader on many machines, which rasterises in software. Frame times from that path describe a CPU renderer nobody uses. The probe records the unmasked `RENDERER` string on every run; check the `GPU` line before quoting frame time. Draw-call and triangle counts are renderer-independent.

## Before and after

`--label` and `--json` are there so two runs can be compared without re-deriving what each one was. If you change app source, restart or let Vite rebuild before measuring again. `--screenshot` captures the city after camera-only movement, which is the frame worth inspecting for shadow regressions.

## Measuring the sidebar column

For layout-only changes, `measure-atlas-column.js` and `measure-city-column.js` report the numbers `AGENTS.md` asks for: `clientHeight`, `scrollHeight`, `overflowY`, unreachable pixels, actual section heights, and a trusted click. Zero unreachable pixels is necessary but not sufficient; check the section heights to make sure a useful region was not squeezed to nothing.
