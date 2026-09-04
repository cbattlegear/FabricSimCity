# Measuring what a large city costs the browser

A real browser, a real GPU, a real 4,000-object city, and numbers for the three things
`web/` gets accused of: frame cost while orbiting, how many draw calls a frame submits, and
what one keystroke in the address book costs.

This exists because `AGENTS.md` is binding: *a UI change is not verified until it has been
measured in a running browser*. The suite in `web/` reads `App.css` as source text and
renders nothing, so it can confirm a declaration exists and cannot see the layout — or the
frame time — that results. Two real defects here were invisible to a green suite.

Nothing here runs in CI. It is a workbench, and it is one of three: `tools/measure/`
measures what the same product costs the SQL Server it watches, and `tools/measure-api/`
measures what a request costs the API process in between.

## What it measures, and why each number is trustworthy

**Draw calls and triangles come from the WebGL context, not from `renderer.info`.**
`WebGLRenderingContext.prototype.drawElements` and friends are wrapped before any
application script runs, so every submission is counted whoever issued it. That is strictly
more than `renderer.info` can tell you, because the probe also tracks the bound draw
framebuffer: three.js renders the shadow map into a `WebGLRenderTarget` and the visible
scene into the default framebuffer, so **offscreen draw calls are the shadow pass** and the
split falls out for free. `renderer.info.render.calls` folds the two together.

**Frame cost is the main-thread time inside the application's own `requestAnimationFrame`
callback.** `requestAnimationFrame` is wrapped, so each frame reports the milliseconds
spent in `controls.update()` plus `draw()` plus every GL submission it made, attributed to
the draw calls it issued. Frame *interval* is reported next to it: interval alone cannot
tell a fast scene from a vsync-limited one, and CPU time alone cannot tell you whether the
user saw a dropped frame.

**Interaction latency is keydown to the paint that answers it.** A capture-phase listener
on `document` runs before React's root listener, so the clock starts before any application
work; the stop is a `MessageChannel` message posted from inside a `requestAnimationFrame`
callback, which is delivered after that frame has been presented. Chromium's own Event
Timing is recorded alongside it, which includes compositor presentation time but only
reports events slower than 16 ms — so an empty Event Timing list is itself a result.

**Input is trusted.** The orbit is driven with `page.mouse`, typing with
`pressSequentially`, and every click is `locator.click()`, which hit-tests. `element.click()`
via `evaluate` and `click({ force: true })` both bypass hit-testing and would pass while a
control was covered by a sibling — which is exactly how the #65 column turned out to be
uninteractable rather than merely unreadable. The trusted click on the search field and on
the first list entry are reported as their own pass/fail lines.

**Both breakpoints.** The sidebar is a rail above 860px and a bottom sheet at or below it,
and they behave differently on purpose, so `--viewport both` runs 1440×900 and 820×900.

**Nothing in `web/` is modified to make this work.** No debug hook, no exported handle, no
build flag. A measurement that needed one would be measuring the hook too, and would not be
available on the build that actually ships.

## Standing it up

The city view needs the API, and the API needs a SQL Server with enough in it. Use the rig
next door — see `tools/measure/README.md` for why 4,200 objects is the floor:

```powershell
cd tools/measure
docker compose -f compose.measure.yaml up -d
./Initialize-MeasureDatabase.ps1        # ~4 minutes
```

Then serve the app. **Publish rather than `npm run dev`**: the dev server runs React in
development mode, where a re-render costs several times what it costs in the build users
get, and the address-book finding is precisely a re-render cost. `dotnet run` will not do
either — `SqlSimCity.Api.csproj` copies `web/dist` with `CopyToPublishDirectory`, so the
assets only appear on publish.

```powershell
cd web; npm ci; npm run build; cd ..
dotnet publish src/SqlSimCity.Api -c Release -o "$env:TEMP/sqlsimcity-measure"

$env:ConnectionStrings__SqlSimCity =
  'Server=127.0.0.1,11433;Database=SimCityLoad;User Id=sqlsimcity_reader;Password=Reader!Local1;TrustServerCertificate=true;Encrypt=true'
& "$env:TEMP/sqlsimcity-measure/SqlSimCity.Api.exe" --urls http://127.0.0.1:5080
```

`Encrypt=false` is rejected outright — every profile requires TLS — so the local container's
self-signed certificate needs `Encrypt=true;TrustServerCertificate=true`, not `Encrypt=false`.

Then, in another shell:

```powershell
cd tools/measure-browser
npm install
npx playwright install chromium
node measure.js --json before.json --label before
```

## Reading the run

The harness opens `?view=city&database=…` and **waits for the automatic page walk to
finish** — the view backfills up to `AUTO_PAGE_LIMIT` (80) pages of `CITY_PAGE_SIZE` (50)
objects with no further input, and each page is a live probe against the instance, so
expect one to four minutes before the first number appears. Measuring before it settles
measures a small city wearing a large one's name. The object count in the report is the
count the sidebar itself shows; if it is not ~4,000 the database is too small and the
result proves nothing about this issue.

Two lines in the report are easy to misread:

- **`offscreen (shadow)`** is the draw calls that went into a render target rather than the
  canvas. With `shadowMap.autoUpdate` on it sits at 948 every frame; with it off it sits at
  **0** and spikes back to 948 on the frames where something invalidated it. A `max` of 948
  next to a `median` of 0 is the shape you want — a max of 0 would mean the shadows had been
  switched off rather than made on-demand.
- **`unreachable` versus `scrollable`.** Overshoot only counts as unreachable when the box
  cannot scroll. A 529px column holding 341,776px of list under `overflow: auto` is a
  scroller working; the same numbers under `overflow: hidden` are content nobody can get to.
  Reporting them as one figure is how a scroll extent gets filed as a bug and a real clipping
  bug gets waved away as "it's just a long list".
- **One sidebar state per open region, and the routed plan separately.** The accordion in #116
  made "open everything" impossible, so a run that still tried it measured the *emptiest*
  column and called it the worst case (#118). Each region is now opened in turn and reported
  under its own name, and the routed plan — the one state where the card takes the whole rail
  over and the drawers stop being rendered — gets a pass of its own. It runs *before* the place
  card and is cleared afterwards: run second there is no plan finder left to click, and the pass
  would quietly re-measure the place card under the routed plan's name. That state is where #120
  lived, 1,028px of card in a 900px `overflow: hidden` rail.

## What a 4,200-object city measured

Chromium 1440×900 and 820×900, RTX 3060 via ANGLE/D3D11, release build served by the API.
Full numbers and every frame are in the pull request for issue #80; the shape of it:

| | rail 1440×900 | sheet 820×900 |
| --- | ---: | ---: |
| draw calls / frame | 22,406 | 22,411 |
| triangles / frame | 11.6 M | 11.6 M |
| CPU ms / frame | 138 | 110 |
| fps while orbiting | 6.8 | 8.9 |
| address-book entries | 4,018 | 4,018 |
| DOM nodes in the list | 28,138 | 28,138 |

The scene is **draw-call bound**: 22,406 submissions in 138 ms is ~6 µs each, which is
three.js's per-call CPU overhead and not the GPU's problem. That is the number to attack,
and attacking it means instancing, which is a redesign.

## Headed by default, and why that matters

Headless Chromium falls back to SwiftShader on many machines, which rasterises in software.
Frame times taken there describe a CPU renderer nobody uses. The probe records the unmasked
`RENDERER` string on every run and the report prints it as `GPU`: **check that line before
quoting a frame time.** `--headless` exists for convenience, not for evidence.

Draw-call and triangle counts are renderer-independent, so those survive a headless run
intact.

## Before and after

`--label` and `--json` are there so two runs can be compared without re-deriving what each
one was. Rebuild and republish between them — the app is served from `web/dist`, so a
source change that has not been through `npm run build` is not in the thing being measured.
This is the single most common way to spend twenty minutes measuring no change at all.

`--screenshot` saves the city *after* the whole camera-only path — a drag orbit, six azimuth
rotations and five zooms, none of which invalidate the shadow map. That is the frame worth
looking at for anything shadow-related: if the shadows are still under the right buildings
there, they survived every camera move. A capture of the first frame would look correct even
with invalidation broken outright.

`--clock` pins what `new Date()` returns, which is what `timeOfDay.ts` reads. Without it a
run at midnight photographs a city whose key light is nearly off, and the shadows you came to
look at are not there to see. Two things to know: the probe is installed *after* the clock on
purpose (`page.clock` replaces `requestAnimationFrame`, and a probe registered first ends up
underneath it and silently records no frames), and the clock quantises `performance.now()` to
1 ms — fine against 100 ms frames, misleading if you ever measure something small with it.

## Retaking the README screenshots

`capture-readme-shots.js` produces the three images in `docs/images/` against a running
instance, so a documentation refresh does not depend on whoever took the last one:

```powershell
node tools\measure-browser\capture-readme-shots.js --origin https://sqlsimcity.battagler.me --out docs\images
```

It reuses this probe's `lib/city.js`, so the settle rule is the same one the measurements use.
Four things it does that a hand-taken capture reliably gets wrong:

- **It picks the largest database from `/api/v1/atlas`**, not the first one on screen. The first
  entry is usually `master`, and a 4.6 MB city photographs as an empty lot.
- **It takes the atlas shot first, and asks for `mode=city` explicitly.** View mode persists
  across navigations, so an atlas captured after a `mode=map` city comes back as flat paper —
  a perfectly good screenshot of the wrong thing.
- **It waits for the atlas freshness line to read `Available live`.** The live DMV sample goes
  stale in about twenty seconds, so an otherwise healthy server hands you `Stale live` on
  roughly every other run. The wait is bounded and does not fail the shot if it expires.
- **It pins the clock to 18:10 and shoots at 3200x1800**, matching the committed images, so the
  README's layout does not move when the pictures are replaced.
## Measuring the sidebar column

`measure-atlas-column.js` is the other half of the workbench: not what the city costs the GPU, but
whether the rail beside it can actually be read and clicked. The repo conventions require a real
browser for anything touching layout, because the test suite reads `App.css` as *source text* — it
can confirm a declaration exists and cannot see the layout that results.

```powershell
npm run dev                     # in the repo root, serving fixtures
node measure-atlas-column.js    # here
```

It reports, at 1115x800 and 720x800:

- `clientHeight` / `scrollHeight` / `overflowY` for the column, the drawer wrapper, every
  `.sidebar-scroll` and every drawer body. `scrollHeight > clientHeight` with `overflow: hidden` is
  content that is unreachable, which is the defect signature.
- The height each section actually got. **Zero unreachable pixels is necessary, not sufficient**: a
  column whose address list is 0px does not overflow and is still useless.
- A **trusted** `locator.click()` on a capacity entry, reported as its own pass/fail line with a
  timing. Trusted clicks hit-test, so they fail when a sibling overlaps the target. `element.click()`
  via `evaluate` and `click({ force: true })` both bypass that and will pass while the defect is
  still there — use them only to reach a later state, never as evidence.
- The three fixture capacities' city evidence readouts and the power-grid facility entries present
  in the city directory, so a paused capacity can be checked as "not observed" rather than a healthy
  empty grid while the conditional surge substation stays absent unless reported active.

It selects a capacity and opens every drawer before measuring, on purpose. An empty detail region
and a closed drawer are short forms that hide exactly the height defects this exists to find, and
two open drawers are the case where the shared height budget is under real pressure.
