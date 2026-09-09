# Working in this repository

Conventions for coding agents. Everything here was learned by getting it wrong first; the
specifics matter more than the general advice.

FabricSimCity renders a Microsoft Fabric capacity as a walkable 3D city and runs as a Fabric App
on Rayfin. It began as a fork of SQLSimCity, which drew a SQL Server the same way. The
visualization was kept; the entire .NET collection stack underneath it was deleted. Several rules
below survive from that build because they were about the renderer, which did not change.

## Layout and CSS changes must be measured in a real browser

**A UI change is not verified until it has been measured in a running browser.** Run `npm run dev`
and take real numbers.

This is not a style preference. The test suite reads `src/App.css` as *source text*: it can confirm
that a declaration exists, and it cannot see the layout that results. Four real defects have been
invisible to a green suite:

- The sidebar rendered `.sidebar-scroll` while the stylesheet only styled `.sidebar-body`, so the
  column had no scroll container at all and everything past the fold was unreachable.
- A fix that added `min-height: 0` to `.sidebar-drawer` squeezed the drawer to **10px** and clipped
  the summary you click to open it.
- `.lazy-surface` was rendered with no rule for it at all. Left `static` it collapsed onto the
  canvas's intrinsic size: measured at 1440x900 the canvas came out **1032x516** and left 384px of
  dead black below the city. `tsc` was clean and all 610 tests passed.
- The capacity detail panel was placed directly inside `.sidebar-scroll`, which carries no padding
  by design, so every label sat flush at **x=0** against the rail's edge.

The last two share a cause worth naming: **a class that appears in JSX and nowhere in the
stylesheet is invisible to every check in this repo.** After adding markup, diff the class names
against `App.css`:

```powershell
$css = Get-Content src\App.css -Raw
$names = Select-String -Path src\App.tsx -Pattern 'className="([^"]+)"' -AllMatches |
  ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value -split '\s+' } | Sort-Object -Unique
foreach ($n in $names) { if ($css -notmatch [regex]::Escape(".$n")) { "UNSTYLED: $n" } }
```

For any change touching layout, record before/after numbers for the elements involved:

```js
const el = document.querySelector('.map-sidebar')
console.log(el.clientHeight, el.scrollHeight, getComputedStyle(el).overflowY)
```

`scrollHeight > clientHeight` with `overflow: hidden` means content is clipped and unreachable.
That is the bug signature to look for. Also check that you have not created nested scroll traps,
and that scrolling does not chain into the map canvas — `.map-shell` is `position: fixed`.

**Zero unreachable pixels is necessary, not sufficient.** A column where the address list is 0px and
the detail panel is 12px does not overflow and is still useless — the same class of mistake as the
10px drawer. Record the actual heights of the sections that gave way, not just the overflow number,
and say whether the result is usable.

The sharpest usability check is a **trusted** click. `locator.click()` hit-tests, so it fails when a
sibling overlaps the target; that is how one column turned out to be uninteractable and not merely
unreadable. `element.click()` via `evaluate`, and `click({ force: true })`, both bypass hit-testing
and will pass while the defect is still there — use them only to reach a later state, never as
evidence. Report the trusted click as its own pass/fail line, with the timing.

Measure at **both** breakpoints. The sidebar is a rail above 860px and a bottom sheet at or below
it, and the two behave differently on purpose.

`tools/measure-browser/measure-atlas-column.js` does all of this against `npm run dev`. Use it
rather than rebuilding the probe, and put the measured numbers in the pull request body.

**Measure the populated column.** An empty detail region and a closed drawer are short forms that
hide exactly the height defects the measurement exists to find. Select a capacity and open every
drawer first — two open drawers are the case where the shared height budget is under real pressure.

## A new test must fail against the broken state

Before claiming a regression test works, revert the fix and watch the test fail:

```powershell
Copy-Item src\App.css $env:TEMP\App.css.bak
# ...mutate the fix...
npx vitest run
Copy-Item $env:TEMP\App.css.bak src\App.css -Force
```

A guard that passes against the broken state is worse than no guard, because it advertises
protection it does not provide. Say in the pull request that you checked this.

The same applies when you refactor test helpers: confirm the *existing* assertions still bind and
have not started passing vacuously. That risk is unusually high right now — a large mechanical
rename (`database`→`capacity`, SQL types→Fabric types) ran across this tree, and a source-text
assertion about a renamed symbol can start matching nothing while still reporting green.

### Prefer an invariant to a count

`leaves the single-drawer atlas column unwrapped` asserted that the atlas had exactly one drawer.
The atlas legitimately grew a second one and the guard failed for the wrong reason — not because
the layout broke, but because a count went out of date. It now asserts the rule the wrapper
actually exists for: a column with sibling drawers wraps them, a column with one does not.

A guard phrased as a count has to be edited every time the thing it counts changes shape, and each
of those edits is an opportunity to weaken it without noticing.

### `ownRule()` in `mobileLayout.test.ts` silently retargets

`ownRule()` strips `@media` wrappers and returns the **last** matching rule. Adding a narrow-width
override for a selector will therefore repoint existing desktop assertions at the override, and
they may keep passing while asserting the wrong rule. The helper splits the stylesheet into
desktop and sheet sources for this reason — use that split rather than adding a new mechanism.

The media split does not save you from the **second** face of this, because the retarget can happen
*within* one source. `ownRule()` matches its selector followed by an **optional pseudo-class group**,
and still returns the last match — so `ownRule('.sidebar-drawer > summary')` resolves to the body of
`.sidebar-drawer > summary:hover`, which is declared after it. An assertion about `display` on that
selector therefore reads the hover rule, and passes happily against a stylesheet where the base rule
sets `display: flex`. That is a guard advertising protection it does not provide, and only a mutation
found it.

When asserting that a declaration is **absent** — the negative form, which is where this bites —
iterate `rules(css)` and check *every* rule whose selector is the target or starts with `target:`.
Reserve `ownRule()` for reading a value you expect to be present.

### Source-text guards need a real file path, not `import.meta.url`

Under `environment: 'jsdom'`, `import.meta.url` is an **http** URL, so
`readFileSync(new URL('./x', import.meta.url))` throws `TypeError: The URL must be of scheme file`.
This breaks *every* source-text guard in the repo, and it fails at **collect** time, so it reads as
a missing suite rather than a broken one — the run stays green-looking while seven files of
protection quietly do nothing.

Each affected suite has a local `sourcePath()` helper resolving against `process.cwd()`, with a
fallback to `src/pending-port/`. Use it. Do not reintroduce `import.meta.url` for file reads.

## `App.css` source order is load-bearing

A media query adds no specificity, so same-specificity rules resolve by source order. Base rules
for `.sidebar-drawer` and friends sit near the **end** of the file, *after* the first
`@media (max-width: 860px)` block. Narrow overrides written into that first block silently lose.

Narrow-width overrides belong in the second `@media (max-width: 860px)` block at the end of the
file. Verify the line numbers before assuming which rule wins.

New **base** rules go immediately before that final narrow block, so the narrow block can still
override them. Take care when inserting there: the edit boundary is one line above a rule that is
easy to clip, and truncating `.map-sidebar { overflow: auto }` out of the narrow block removes the
bottom sheet's only scroller without failing a single test.

## `<details>` floors on `::details-content`, not on `<summary>`

`<details>` wraps its children in a `::details-content` box, and *that* box is the flex item —
not the `<summary>`, and not `.sidebar-drawer-body`. It is `display: block` with
`min-height: auto` and floors on its own content no matter how hard a flex column pushes.

No `flex` arrangement on `.map-sidebar`'s children can shrink it. Do not add `min-height: 0` to
`.sidebar-drawer` to try: that is the 10px-drawer defect above, and it is pinned by
`never shrinks the legend drawer past its own summary`.

Cap the box itself instead. `.sidebar-drawer::details-content` is given `min-height: 0` so it can
give way, plus `display: flex; flex-direction: column` so the shrink reaches `.sidebar-drawer-body`,
which is already a `min-height: 0; overflow: auto` scroller. The legend then scrolls inside the
drawer rather than spilling out of the rail. An engine without `::details-content` skips the rule
and does not need it: without that box the summary and the body are the flex items directly, and the
body already scrolls. The defect exists only where the box does.

`.sidebar-drawer` keeps `min-height: auto`, and a flex item's automatic minimum is its content size
clamped by its own definite `max-height`. So each drawer still floors at `min(content, cap)` —
summary always inside that. Two open drawers therefore cannot both shrink out of the way.

That is why the cap is not a flat `46vh` per drawer. Two drawers each floored at 46vh floor at
46vh *each*, and 2 × 368 does not fit an 800px rail: measured at 1115×800, 167px of the column was
unreachable, the address list was squeezed to 0px, and its entries stopped being clickable at all.
So a `.sidebar-drawers` wrapper owns one budget and the drawers inside divide it via
`--sidebar-drawer-cap`, sharing by open count and widened by a `:has()` rule when only one is open.
The drawer's `max-height: var(--sidebar-drawer-cap, 46vh)` fallback is what keeps an *unwrapped*
drawer byte-identical.

Two traps in that arrangement, both of which fail quietly:

- **Never put `:where()` inside that `:has()`.** `:has()` takes a *relative* selector list, in which
  a selector may start with a combinator; `:where()` takes a *complex* one, in which it may not. So
  `:where(> .sidebar-drawer[open] ~ …)` has its argument dropped by forgiving parsing rather than
  failing — Chromium reads the rule back as `:not(:has(:where()))`, which matches everything, so the
  widened cap applies with both drawers open and the overflow returns. Plain `:not(:has(> …))` is
  correct: `:not()` is *not* forgiving, so an engine without `:has()` drops the whole rule and lands
  on the smaller share, which always fits.
- **`display: contents` removes a box, not an element.** At ≤860px the wrapper is `display:
  contents`, so `.map-sidebar > *` goes on matching the *wrapper* while the drawers are the flex
  items — hence `.sidebar-drawers > *` alongside it in that block. Custom properties still inherit
  through it too, so the drawers keep inheriting a share there; `max-height: none` in the same block
  is the only thing discarding it, and weakening that gives the sheet a *tighter* cap than existed
  before the wrapper.

The atlas rail in `App.tsx` has two drawers and is wrapped. `src/pending-port/CapacityCityView.tsx`
has two more that will rejoin the budget when the city view is ported — check the change against
more than one column.

## The city scene renders on demand, and the shadow map is not automatic

The viewport owns a renderer for the lifetime of its canvas, not for the identity of its callbacks.
`CapacityCityView` supplies fresh closures on refresh and sidebar interaction. Putting those in the
scene-creation effect's dependencies destroys the populated scene, while unchanged data effects
do not rerun to populate its replacement. Delegate through current callback refs instead of either
recreating the renderer or capturing stale handlers. `CapacityCityViewport.test.tsx` exercises this
lifecycle; `tools/measure-browser/measure-refresh.js` measures real refreshes at both breakpoints.

This applies to `src/pending-port/CapacityCityScene.ts`, which is quarantined but not rewritten.
The rules below survive the port and are the reason the file was kept rather than deleted.

It does not run a permanent `requestAnimationFrame` loop. It renders when something changed, and
`shadowMap.autoUpdate` is **off** — the shadow pass measured 948 draw calls and 7.6 ms *per frame*,
all of it redrawing shadows for a city that had not moved. Shadows are re-rendered by setting
`shadowMap.needsUpdate = true` at the few moments the scene's contents or its light actually change,
never on camera movement.

That makes the shadow cost invisible in the usual places. `renderer.info.render.calls` folds the
shadow pass in with the visible one, and a frame time taken while nothing is animating measures a
scene that is not rendering at all. Use `tools/measure-browser`, which counts submissions off the
WebGL context and splits them by bound framebuffer, so **offscreen draw calls are the shadow pass**.
`median 0` with an occasional `max 948` is the shape that means "on demand and still working";
a steady 948 means something re-armed it and a steady 0 means shadows were switched off entirely.

Two consequences for any loop added later — both fail silently, and both are pinned by
`shadowInvalidation.test.ts`:

- **A new loop gets its own handle.** There are three (`animationHandle` for the render-on-demand
  pass, `dampingHandle` for orbit inertia, `vehicleHandle` for live vehicles). Reusing one handle
  for two loops means whichever `cancelAnimationFrame` runs last silently orphans the other, which
  then runs forever with nothing able to stop it. Cancel every handle in `dispose()`.
- **A loop that moves objects must not invalidate the shadow map.** Vehicles animate every frame,
  so a single `shadowMap.needsUpdate = true` inside `runVehicleLoop` re-arms the whole 948-call
  pass on every frame. Vehicles are therefore excluded from shadow casting outright
  (`castShadow = false`), which is also why they need no invalidation.

A loop must also **stop on its own** when there is nothing left to move — an empty roster ends the
loop rather than scheduling an idle frame forever. Measure that, do not reason about it: an
always-scheduled callback that does no work looks identical in a screenshot and identical in the
test suite, and shows up only as a machine that never goes idle.

`shadowInvalidation.test.ts` guards this by slicing the scene as **source text** and asserting a
region does not mention `needsUpdate`. Two traps follow. It strips comments first (`code()`),
because otherwise a doc comment *explaining* the rule reads as a violation of it. And each slice is
bounded by a named anchor further down the file, so **adding a function between two anchors silently
extends the slice above it** and the guard starts asserting about code it was never written for.
Check the anchors when you add anything near a loop.

Anchors are used the same way outside that file — `cityVehicleAssets.test.ts` and
`cityVehicleLegibility.test.ts` both slice `VEHICLE_SIZE` out of the scene — and there the failure
is sharper. **Promoting a declaration to module scope moves an anchor, and if it ends up *above* the
start anchor the window inverts.** `String.slice(from, to)` with `to < from` returns the empty
string, so every lookup inside the slice finds nothing. Hoisting `VEHICLE_Y` to the top of the file
to derive the trail height did exactly this to both files at once.

So assert `to > from`, not merely that each `indexOf` cleared `-1`. An inverted window and a renamed
anchor are different bugs and only the stricter check catches both. Prefer an end anchor that is
declared close to the start one and is unlikely to be hoisted.

## Never draw a guess

The single rule the whole visualization rests on. A measurement that is **missing** renders as
wireframe; it never renders as zero.

A paused capacity and an idle capacity produce identical zeroes and are completely different
things. `capacityHeight()` returns `null` rather than `0` for unknown CU, `capacitySide()` returns
`null` for an unrecognised SKU rather than defaulting, and `atlasCity.ts` turns a `null` height into
`vacant` lots. `capacityAtlas.test.ts` pins this in
`describe('measurements that are missing rather than zero')`. The fixture roster includes a
suspended capacity specifically because it is the case most likely to be drawn wrong.

`isRejecting()` deliberately excludes `InteractiveDelay`. That stage adds 20s to a request — a busy
city, not a broken one. Drawing it as a blackout would cry wolf.

## The `CapacitySource` seam

All Fabric access goes through one interface, `src/collect/source.ts`, with three implementations:

```
semanticModelSource   DAX via the Power BI executeQueries API         [written; dev-only transport]
eventhouseSource      KQL via the kusto connector                     [written; no transport]
fixtureSource         deterministic synthetic evidence                [the development loop]
```

`capabilities` is declared up front so the UI decides what to draw *before* it asks. A source
without per-item CU breakdown degrades to live infrastructure over static buildings rather than
failing.

**Fixture mode is the primary development loop, not a fallback.** Rayfin has no local backend and
no `rayfin dev`; `npm run dev` runs Vite against a *deployed* backend. Without fixtures the city is
undevelopable without a Fabric tenant. `App.tsx` loads the configured source through
`loadConfiguredCapacitySource()`; fixtures and the dev DAX proxy bypass Rayfin session startup.

### The semantic model is reachable from `npm run dev` and not from the deployed app

Three independent walls, any one of which is enough, so do not go looking for a configuration flag
that opens this up:

1. Rayfin 1.34.0 ships **no connector package** — `discover_packages` returns only `rayfin-core` and
   `rayfin-mcp`. The `fabric-semanticmodel` connector this seam was designed against does not exist
   yet.
2. **Fabric refuses to deploy `functions`**, the only server-side seam the app has. It rejects the
   whole runtime-settings sync, not just the functions part — `rayfin up` gets as far as retrieving
   the publishable key and then fails with `400 Bad Request ... Invalid settings detected: Functions
   are not supported yet.` It is a platform gap, not a config error, so there is no flag that works
   around it. The function itself is kept: `rayfin/functions/src/fabricTopology.ts` still builds and
   `createTopologySource()` still invokes `functions.readFabricTopology`, so this is one word in
   `rayfin.yml` to reverse once Fabric supports functions.
3. **`executeQueries` sends no CORS headers.** This one is independent of Rayfin entirely: even
   holding a valid token, a browser cannot call `api.powerbi.com`. It needs a server-side relay, and
   Fabric static hosting has nowhere to run one.

So `createSemanticModelDaxClient` posts to a *same-origin* path, defaulting to `/powerbi`, and the
Vite dev server proxies it. The token is read from `POWERBI_TOKEN` — deliberately **not**
`VITE_POWERBI_TOKEN`, because only `VITE_`-prefixed variables are inlined into the bundle and that
naming would publish a live Power BI token to every visitor of the built site.

Two transport details are load-bearing and both fail as *silence* rather than as an error:

- **`executeQueries` has no parameter binding.** The query builder emits `@Start`, `@End` and
  `@CapacityId`, and the transport rewrites them into DAX literals. Substitution matches whole
  identifiers, because replacing `@Start` textually also rewrites the front of `@StartOfDay` and
  leaves behind *valid* DAX — wrong numbers rather than a failure. Strings double their quotes;
  a capacity id is server-supplied and must not be able to end the literal.
- **Rows come back with bracketed keys** — `"[CapacityId]"` for a `SELECTCOLUMNS` alias,
  `"Table[Column]"` for a bare column — while the source parses plain names. Without unwrapping,
  every lookup misses and a well-formed response yields an empty city.

A 400 from `executeQueries` maps to `Unsupported`, not `Unknown`, because the DAX error this source
expects to meet is the Capacity Metrics schema having moved again — a documented, recoverable
condition that the app handles by falling back and saying so.

### A deploy writes `.env.local`, and the suite used to read it

`rayfin env --framework vite` — which `npm run build:fabric` and a successful `rayfin up` both run —
writes a real `.env.local` containing `VITE_RAYFIN_API_URL`. Vitest loads `.env` files through Vite,
and that variable is exactly what `isFixtureMode()` keys off, so the suite silently left fixture
mode and `appState.test.ts` failed.

That is ambient state deciding the result: green on a fresh clone and in CI, red on any machine that
has ever deployed. `vitest.config.ts` now pins `test.env` to neutralize every variable `rayfin env`
writes. Add new `VITE_*` variables to that list, and stub with `vi.stubEnv` in tests that want a
configured backend rather than relying on what happens to be on disk.

### A negative result must be stamped if it is cached

Carried forward from the SQL build, where it cost real capability: query text was normalized once
and the *result* was cached, including a `Missing` result. The consequence is easy to miss —
improving the normalizer changed nothing on any instance that had already run, because every text
the old code rejected was on disk as a rejection and the read was a hit. Measured against a live
instance, **167 of 172 query families had no text at all** and the code that would have fixed it
was never reached.

Any cache added here for a *derived* value must carry a version stamp that feeds the record id, not
merely the record kind — the id is what retires a record. Restamping only the kind leaves it
readable, and a test that restamps the kind to prove retirement passes against a broken
implementation.

## Rayfin constraints

All verified against `@microsoft/rayfin-*` v1.34.0.

- **No cron, no timers, no background workers.** Functions are invocation-triggered only, so there
  is no in-app collector. Refresh is a client-side `setInterval` while the tab is open.
- Decorators are TC39 Stage 3. Requires `@vitejs/plugin-react`, **never** `-swc`, which cannot parse
  them, and `ESNext.Decorators` in the tsconfig `lib`.
- The root `tsconfig.json` deliberately omits `erasableSyntaxOnly`; it would break `rayfin/`.
- `tsc --noEmit -p tsconfig.json` reports TS6305 on `src/services/*` because project references are
  not built. **`tsc -b` is the correct check.**
- `@text()` without `max` produces `NVARCHAR(MAX)`, which breaks GraphQL schema generation *after*
  `rayfin up` reports success.
- Omitting a permission decorator silently grants full CRUD to any signed-in user.
- `.execute()` silently returns one page with no signal that more exist. Always `.executePaginated()`.
- Connectors do not exist as a package in 1.34.0 — `discover_packages` returns only `rayfin-core`
  and `rayfin-mcp`. Capacity metrics access is delegated-auth in any case: every user needs their
  own metrics permissions, and there is no service-principal path where the app reads once for
  everyone.
- Static bundle caps at 100 MB compressed.

### The `es2022` transform target lives in two config files, and the old spelling fails silently

Decorators are why `es2022` is pinned, so the bundle and the suite have to agree: a suite
transformed at a different syntax level than the bundle can pass while the build fails. That target
is set in **both** `vite.config.ts` (three places — `build.target`, `oxc.target`,
`optimizeDeps.rolldownOptions.transform.target`) and `vitest.config.ts` (`oxc.target`), because
`vitest.config.ts` is standalone and does **not** extend `vite.config.ts`.

The oxc-based toolchain still *accepts* the esbuild-era `esbuild: { target }` key and silently
ignores it, logging `oxc options will be used and esbuild options will be ignored` before carrying
on at oxc's default target. So the migration has to be done per file, and missing one leaves dead
config that reads as correct. It has already been missed once: #4 migrated `vite.config.ts` and left
`vitest.config.ts` behind, where the key stayed *honoured* under Vitest 3 and only went dead on the
bump to Vitest 5.

Do not trust a green suite to tell you which key is live — mutate the target to prove it. Set
`target: 'not-a-target'` and run any single file:

```powershell
npx vitest run src/atlasSceneFactory.test.ts
# under `oxc:`      → exit 1, [BUNDLER_INITIALIZE_ERROR] Invalid target 'not-a-target'
# under `esbuild:`  → exit 0, "Tests 2 passed", warning only
```

A bump of Vite, Vitest or `@vitejs/plugin-react` is the moment to re-check both files. Keep
`@vitejs/plugin-react` on v5: v6 replaces the React transform and peers on `oxc-transform-react`,
`@rolldown/plugin-babel` and `babel-plugin-react-compiler`, none of which are installed, so taking
it invalidates the decorator support this pin exists to guarantee.

### Keep `@types/node` level with the Node that runs, never ahead

CI and local both run **Node 24** (`node-version: 24` in `ci.yml` and `deploy-fabric.yml`), and
`@types/node` is pinned to `^24` to match. The direction of any mismatch is what matters. Types
*behind* the runtime only hide APIs that do exist — stale, but safe. Types *ahead* let TypeScript
accept APIs that are absent at runtime: green build, green suite, crash in production.

Dependabot cannot see `node-version` and will keep proposing the newest major. Decline it, and move
the runtime and the types together as one deliberate change when the runtime moves.

## Fabric telemetry facts

- **No REST endpoint returns CU utilization.** `api.fabric.microsoft.com/v1` gives topology only.
- CU telemetry comes from the Capacity Metrics semantic model over DAX, which Microsoft documents
  as **unsupported** for programmatic access, and whose schema has already changed once. Probe both
  generations the way Microsoft's own FUAM notebooks do
  (`'Metrics By Item Operation And Day'` → `'MetricsByItemandOperationandDay'`).
- Throttling uses **30-second timepoints**, 2,880 per day. The gauges average *future* smoothed
  usage over 20 / 120 / 2,880 timepoints → interactive delay / interactive rejection / background
  rejection. The fixture generator carries 24h of future series for exactly this reason.
- The REST `ItemType` enum (50 values, `DataPipeline`, `SemanticModel`…) and the Capacity Metrics
  names (`Pipeline`, `Dataflow Gen2`, `LlmPlugin`, `User Data Functions`) disagree. `src/itemKind.ts`
  is the mapping layer and is where building archetypes get assigned.

## The port is finished; the quarantine is gone

`src/pending-port/` no longer exists. Every SQLSimCity module was either ported or deliberately
deleted, and the `pending-port` excludes are out of `tsconfig.json` and `vitest.config.ts`.

Two lessons from it are worth keeping, because both cost real time:

- **If you ever quarantine again, keep the `tsconfig.json` and `vitest.config.ts` exclude lists in
  agreement.** A module excluded from one and not the other is either unchecked or unrunnable, and
  both fail quietly.
- **Check *why* a pure module errors before moving it.** An iterative "move whatever still errors"
  loop once dragged the entire atlas into quarantine, because `mapRibbon` → `cityRoads` →
  `cityTraffic` for a single type. The fix was moving that type to where it belonged, not moving
  twelve files.

## The slow tests are isolated on purpose

Suite wall time is set by a few individual tests, not by the total, so the layout that spreads
them out is load-bearing and easy to undo by tidying.

The `cityGrowth` family is four spec files over one `cityGrowth.testkit.ts`, and
`cityGrowthRetrace.test.ts` holds exactly one test because that test alone was the critical path —
17.7s of a 44s run. Vitest schedules a *file* onto a worker, so merging these back into one spec
re-serialises them and roughly doubles the suite. Add growth tests to one of the other three; leave
the retrace file alone. The cost is `planCity`, not the scaffolding: measured over counts 80..140,
planning is 16,150ms against 116ms of signature building.

## The ingest replays DAX rows; it does not interpret them

The deployed app cannot call the Capacity Metrics semantic model — see the three walls in the README
— so a scheduled Fabric notebook runs the DAX and writes the rows into the app's own SQL database.

The shape of that is the whole point, and it is easy to "simplify" into a much worse design. The
notebook stores rows **verbatim** and `ingestedDax.ts` replays them into a `SemanticModelDaxClient`,
so `createSemanticModelSource` parses them without knowing anything changed. The two obvious
alternatives were both rejected for the same reason: making the notebook emit finished snapshots
means porting 41 KB of parsing to Python, and making it emit normalized tables means rebuilding the
assembly logic on the read side. Both put Capacity Metrics schema knowledge in two languages, and
that schema has already moved once.

For the same reason the DAX itself is **generated**, not written in Python. `npm run dax:manifest`
writes `fabric/dax-queries.generated.json` from `buildSemanticModelQueries`, and the notebook only
ever looks queries up. `daxManifest.test.ts` regenerates it in memory and fails if the committed file
is stale, because otherwise a stale manifest builds a city from old DAX rather than raising.

Four things about the replay that fail silently if changed:

- **The run is resolved once per client and held.** A notebook finishing mid-render would otherwise
  serve `cityItems` from one run and `operationFamilies` from the next — a torn city with no error.
  The held promise is also cleared on rejection, so one transient failure does not brick the page.
  Each atlas refresh creates a fresh ingest source and publishes it together with its snapshot.
  Holding one source for the tab's lifetime would otherwise pin the first run forever. City
  selections reset on capacity changes, not on refreshed source identity.
- **The window is not part of the replay key.** `queryWindow(now)` derives `Start`/`End` from the
  clock on every call, so exact-parameter matching would never hit. The key is `queryName` plus
  `CapacityId`, and only `timepoints` is filtered by time — via `rowTimestamp`, which the notebook
  lifts into its own column. Windowing the aggregated queries drops rows the source expects.
- **`TENANT_WIDE_CAPACITY_ID` is `''`, not null**, so the column stays non-nullable and equality
  filtering needs no special case.
- **Latency is the model's lag plus the schedule interval.** Reporting the model's 15 minutes alone
  would tell the UI the city is fresher than it is, which is the "unmeasured drawn as measured"
  failure the evidence model exists to prevent. `VITE_FABRIC_INGEST_INTERVAL_MINUTES` must match the
  real schedule.

**`@authenticated('read')` on `IngestRun`/`IngestRow` means any signed-in app user reads the whole
tenant's capacity metrics.** That is a real disclosure change from the per-user delegated auth the
semantic model enforces, and it is deliberate — there is no other way to serve a shared ingest. Write
is not granted: the notebook writes over direct SQL, so nothing done through the app can forge
telemetry. Say this out loud in any change that touches those entities.

### The notebook is generated from `.py` files

`fabric/ingest_capacity_metrics.ipynb` is built by `npm run fabric:notebook` from
`fabric/simcity_ingest.py` (pure logic) and `fabric/ingest_main.py` (Fabric I/O). Edit the `.py`
files. A `.ipynb` diff is JSON string arrays that nobody reads, and Python inside one is invisible to
every linter and to the tests.

`simcity_ingest.py` has no Fabric imports on purpose: `ingestNotebook.test.ts` executes it in a real
Python and asserts on behaviour. Keep it that way. The two functions it exists to protect are the
ones that had to be written twice, and both fail as **wrong numbers** rather than as an error:

- `bind_dax_parameters` matches whole identifiers. A plain replace of `@Start` also rewrites the
  front of `@StartOfDay`, and what it leaves is still valid DAX — the query runs and answers for the
  wrong window.
- `dax_literal` doubles quotes, which is DAX's own escape, so a capacity id cannot end its literal
  and carry on as expression text.

Both mirror `src/collect/semanticModelDaxClient.ts` exactly. Change one, change the other, and check
the executed tests still fail when you revert the fix.

That test skips when no Python is on `PATH` — but it **throws** when `CI` is set, because a skip
there would quietly remove the only check that the Python half works at all.

`pandas.NaT` passes `isinstance(value, datetime)` but cannot be timezone-converted. `_utc_datetime`
checks its non-reflexive equality before conversion and shares that rule between JSON encoding
and SQL timestamp extraction. Missing timestamps stay null; known timestamps become UTC before
SQL drops timezone information. The executed regressions use real pandas when available and the
same datetime-subclass contract on plain-Python CI, without requiring Fabric libraries.

Rayfin's physical tables are `IngestRuns` and `IngestRows`, not the singular entity names. The
notebook resolver accepts both forms, checks columns, and rejects ambiguous schemas/names rather
than taking the first result. Its orchestration test must exercise that resolver against a catalog,
not replace it with a fake returning the expected name: that stub hid the deployed-name failure.

Bracket every column identifier in the notebook's hand-written SQL, including updates and cleanup.
`rowCount` collides with SQL Server's reserved `ROWCOUNT` keyword; quoting the table does not quote
its columns. A recording fake cannot detect SQL syntax errors. The executed tests inspect emitted
identifiers and exercise retention deletes, and the SQL was also checked on a local SQL Server with
`SET PARSEONLY ON` (ODBC `?` markers replaced by a declared variable). Parsing does not execute the
statements or establish that tenant SQL persistence works.

### A recognized fact table is not a recognized schema

The first live export contained `Metrics By Item Operation And Day`, but its date is `Datetime`,
its operation is `Operation name`, and labels live in `Items` and `Capacities`. The original
flattened-column assumptions rejected it. `metricsDailyWithDimensions` requires all three tables,
and the manifest carries those requirements to Python. Keep every required table's probe rows in
the ingest: keeping just the fact makes a successful notebook run unreadable by the app.

The UI uses `client.data.IngestRun`/`IngestRow` through the configured source, after adopting the
portal session with Rayfin's built-in `initEmbeddedAuth`. Share that initialization across
StrictMode mounts and refreshes; never open a popup at startup, build a separate login route,
or fall back to synthetic data when authentication fails. The SDK handles API authentication.
Validate config before constructing the client singleton so a failed startup can be retried.

The notebook skips `unavailableQueries`; the source refines its timepoint capability after the
initial schema probe and replay forwards it. Daily totals cannot stand in for 30-second samples.
`Throttling (min)` is multiplied by 60 in DAX because the reader takes seconds. Dimension lookups
use capacity/workspace/item keys without joining metadata into fact totals. Workspace storage,
item memory and summed daily users are not evidence for per-item bytes or distinct users.

Keep DAX model references physical: `SUM(__Window[Column])` is invalid even when `__Window` is
a valid table variable. Pass the variable as a `SUMMARIZECOLUMNS` filter instead. Explicit ISO
window strings also matter: `CEILING` returns a serial number, which the reader cannot parse as
a timestamp. `metricsDailyQueries.test.ts` and executed notebook tests pin these seams; local
schema/reference checks are not DAX execution against a tenant.

### DirectQuery row filters are not source parameters

Live access exposed the second half of that schema: capacities and items are imported, but facts
are DirectQuery. Without `MPARAMETER 'CapacitiesList' = { @CapacityId }` and
`MPARAMETER 'RegionName' = @RegionName`, an unfiltered count returns zero. A `TREATAS` capacity
filter does not substitute for those source parameters. `Region` can be the display label `Default`;
only `Region without default` is a routing value. Do not infer a home region.

Manifest v3 adds an imported `capacityInventory` query. Both the notebook and live TypeScript source
discover routing first, then execute summaries/items/operations per capacity. The notebook still
stores the concatenated, verbatim summaries under tenant-wide `capacitySummary`, keeping existing
SQL readers compatible. Replay serves scoped summaries by filtering that one pinned snapshot,
caches it once per client, and clears a rejected promise for retries. Do not add the requested
region or clock-derived window to that replay key.

Even `SUM` can return zero for an empty DirectQuery fact table. The summary checks for actual rows
before claiming measured CU. Observation aliases are explicit UTC strings: executeQueries otherwise
returns zone-less datetimes that `Date.parse` interprets in the browser's local timezone.

All six capacities were queried read-only through the actual notebook orchestration on 2026-09-09:
679 item rows and 2,458 operation-family rows, with SQL writes captured in memory and every row
passed through the real replay/parser. This proves model queries and staging, not a completed
write to a real SQL database.

## Validation commands
```powershell
npx tsc -b            # 0 errors expected; the correct typecheck, see the Rayfin note above
npx vitest run        # 1,235 tests / 76 files
npm run build         # tsc -b + vite build
npm run dev           # Vite on fixtures -- no tenant needed
```

Those counts are the baselines to compare against. Investigate any delta rather than accepting it.

`npm run build` and a bare typecheck are not the same check. `build` runs `tsc -b` over the whole
project graph, which is the first thing that reads the `*.test.ts` files. A test that constructs a
contract value with a string literal outside its union type passes the suite — Vitest strips types
— and fails the build. Run `npm run build` before pushing.

## Every pull request needs a `release:*` label

Merging to `main` with green CI cuts a GitHub Release automatically. The release workflow reads the
`release:*` label on the pull request merged at the CI head SHA, computes the next `vMAJOR.MINOR.PATCH`
tag, and writes generated release notes. A separate pull request check fails unless **exactly one**
`release:*` label is present.

| label | when |
|---|---|
| `release:major` | Anyone running the app must change something to stay working — a removed or renamed route or response field, a renamed configuration key or environment variable, a changed default that alters behaviour. |
| `release:minor` | New capability that costs the operator nothing — a new view, endpoint, opt-in setting or supported source. |
| `release:patch` | Bug fix, performance work, a rendering or layout correction, dependency bumps, refactors with no visible effect. |
| `release:skip` | Nothing reaches the shipped artifact: docs, `AGENTS.md`, tests, CI workflows, repository chores. |

**The bump describes the promise to whoever runs the app, not the size of the diff.** A one-line
change that renames a config key is `major`. A thousand-line refactor nobody can observe is `patch`.
When a pull request spans categories, take the highest one it earns.

Omitting the label is not neutral. The workflow now fails loudly instead of silently defaulting to
`release:patch`; this is deliberate because #69, #70 and #71 all merged unlabelled once and forced a
hand-cut release after feature work shipped understated.

### Manual and batched releases

`release:skip` defers a bump; it does not cancel one. The skipped change still lands on `main`, so
skip means "some later release carries this". When cutting a batched release with
`workflow_dispatch`, choose the explicit bump input as the **highest bump earned by any pull request
merged since the last release** — not the size of whichever one triggered it. **When a bump-worthy
change is skipped, say so in the pull request body**, so whoever cuts the batched release can find it
without re-reading every diff since the tag.

The release workflow tests `release:skip` first and that branch wins outright over any bump. That is
intentional historical behaviour, and the exact-one-label PR check is what keeps mixed labels from
reaching this point in normal use.

The workflow deliberately declines to cut a second release for an already-tagged commit. Keep that
safety check: it is why a rerun cannot move or duplicate a release after the fact.

A commit with **no** merged pull request — anything pushed straight to `main`, including the push
that bootstraps a repository — skips with a notice rather than failing. It has nowhere to carry a
label, so there is nothing to read and nothing to release. This is deliberately *not* the same as an
unlabelled pull request, which still errors: that one is a mistake someone can fix, and
`autoDecision` refuses it precisely so a missing label cannot quietly become a patch. Both arrive at
`planRelease` with an empty label array, so the `noPr` flag is what tells them apart, and the skip is
checked before `autoDecision` gets a chance to reject.

**Two or more** merged pull requests for one commit remains an error. Their labels can disagree
about the bump, and picking one is how a release ships understated.

### Merge ordering still matters

Auto-release triggers on **CI completing on `main`**, not on the merge. CI no longer cancels
in-progress runs on `main`, because doing so once cancelled the release that should have read a
`release:minor` label. #85 (`release:minor`) and #86 (`release:patch`) merged 94 seconds apart and
shipped together as a **patch**; it could not be repaired because the workflow correctly declined to
cut a second release for the already-tagged commit.

Still prefer to **merge the release-bearing pull request last** when batching with `release:skip`.
The skip-first precedence makes the two collapse cases asymmetric: merge a skip before a bump and a
later bump release can carry it; merge the bump before a skip and, if only the skip run reaches the
version job, it cuts **nothing at all** — no tag, and the change ships silently inside a later
release. Between two bumps there is no safe order, only waiting for the first release to appear.

### Fabric deployment

`deploy-fabric.yml` runs on a published GitHub Release and can also be started manually. It checks
out the release tag, installs dependencies, authenticates Rayfin non-interactively, runs
`npm run rayfin:up`, then `npm run rayfin:status`.

The deploy job is guarded until the repository or environment has a real Fabric target configured:
set `RAYFIN_WORKSPACE_ID`, `RAYFIN_TENANT_ID`, and either `RAYFIN_TOKEN` or
`RAYFIN_CLIENT_ID`/`RAYFIN_CLIENT_SECRET`. Without those values the job logs notices and skips
`rayfin up`; do not claim a deploy is verified until it has run against a tenant.

#### The first `rayfin up` needs a workspace named explicitly

A bare `npx rayfin up` fails on a fresh clone with **`No workspace targeting context`**, and that
error reads like a missing project scaffold. It is not one. The CLI has already found the project
and parsed `rayfin.yml` by the time it fails — the two lines above the error say so:

```
👀 Found Rayfin project root: ...
📋 Using project name 'fabricsimcity' from rayfin.yml configuration
```

`rayfin up` records its workspace binding in `rayfin/.deployments.json`, and reuses it on every
later run. On the *first* run that file does not exist yet, so the workspace has to be supplied —
`--workspace <display name>`, `--workspace-id <guid>` or `--workspace-uri <portal url>`. The help
text's "defaults to My Workspace when omitted" describes the resolution of the flag, not a fallback
for having no binding at all; a Fabric App needs a capacity-backed workspace, which a personal one
generally is not.

So **the absence of `rayfin/.deployments.json` is the diagnostic**, not evidence of a broken repo.
It is gitignored (Rayfin's docs list it beside `rayfin/.env`, and it carries the same tenant and
workspace GUIDs, the `fabricItemId` and the publishable key), so it is per-developer by design and
never arrives with a clone.

Validate the configuration without a tenant using `--dry-run`, which makes no API calls and prints
the planned operations. Do not reach for `--gen-config-only`: it does not exist on CLI 1.34.0
despite appearing in some quick references, and fails with `error: unknown option`.

```powershell
npx rayfin login status                                   # confirm a session exists first
npx rayfin up --dry-run --workspace "<name>"              # offline: validates config, no API calls
npx rayfin up --workspace "<name>"                        # first real run; writes .deployments.json
npx rayfin up                                             # thereafter
```

Note that a successful deploy **edits tracked files**: it appends the live hosting URL to
`allowedRedirectUris` in `rayfin/rayfin.yml` and merges `RAYFIN_PUBLIC_*` into `rayfin/.env`.
Expect `rayfin.yml` in `git status` afterwards and commit it deliberately.

It does not edit that file in place — it **re-serializes it from the parsed config**, which
normalizes the shape (a `storage: enabled: false` block appears) and, more importantly, **deletes
every comment**. A ten-line comment above `functions.enabled: false` explaining that Fabric rejects
the whole deployment when it is on did not survive the first deploy, and the loss shows up in the
diff as a plain deletion with nothing to indicate the CLI did it rather than a person.

So do not record *why* a setting has its value in `rayfin.yml`. That reasoning belongs here, where
the CLI cannot reach it; the file holds values only.

### A conflicted pull request silently switches CI off

If `gh pr checks` reports "no checks reported" and the Actions API returns **zero runs** for a
pushed commit, the first suspicion should not be the runner. GitHub cannot compute a merge ref for a
conflicted pull request, so it never queues a `pull_request` workflow at all. The symptom is
identical to Actions being disabled on the repository, and no error appears anywhere.

Diagnose in this order, because each step rules out a whole class of cause:

```powershell
gh api repos/:owner/:repo/actions/permissions          # is Actions on at all?
gh run list --limit 5                                  # do runs exist for other SHAs?
gh pr view <n> --json mergeable,mergeStateStatus        # CONFLICTING / DIRTY is the answer
```

`main` moving under a long-lived branch is what causes this, and the longer the branch runs the more
likely it is. Merge `main` early and often rather than at the end — a branch that is silently
untested is worse than one that is visibly red.

### Resolving a merge where one side deleted a whole stack

Do not eyeball ninety conflicted paths. Most of them are not conflicts in any interesting sense —
they are files this branch deleted on purpose and `main` went on editing. Partition them first:

```powershell
git diff --name-only --diff-filter=U | ForEach-Object {
  git cat-file -e "HEAD:$_" 2>$null
  if ($LASTEXITCODE -ne 0) { git rm -q --force -- $_ }   # we deleted it; main's edits are moot
}
git diff --name-only --diff-filter=U                     # what is left is the real review
```

Then check the half of the merge that reports no conflict at all. Files `main` *added* merge
cleanly by definition, even when they import modules this branch deleted — `tsc` and the test suite
will not notice, because nothing imports them either. Review every addition on its own merits:

```powershell
git diff --cached --name-only --diff-filter=A
```

The same applies to CSS and to markup attributes added for tooling that no longer exists. A rule
whose selector matches nothing this branch renders is dead weight, and a guard written for that rule
is a guard that can never fail. Take the upstream change only when it still has a referent here.

## Scratch files

One-off probe pages and ad-hoc measurement scaffolding do not get committed. Delete them and
confirm `git status` is clean before opening a pull request.

That is about throwaway scratch, not about tooling. `tools/measure-browser/` is the opposite case:
a deliberate, documented workbench for measuring what the city costs the browser and whether the
rail beside it can be read, kept precisely so the next measurement is reproducible rather than
reinvented. Add to it, and document what you added in its README, rather than growing a private
copy beside it.

## The city keystone: footprint from bytes, height from CU

`src/capacityCity.ts` is the item-level echo of `capacityAtlas.ts`, and the two must stay the same
shape. A capacity's plot comes from its provisioned CU budget and its skyline from CU consumed; one
level down, a *building's* footprint comes from its OneLake bytes and its height from the CU-seconds
charged to it. `capacityCity.ts` imports `cuToHeight` from `capacityAtlas.ts` verbatim rather than
re-deriving it, so an item and its capacity raise a skyline on one scale — do not fork that formula.

The city adds one subtlety to "never draw a guess", and it is the easy thing to get wrong: a null
footprint is **not** always a missing measurement. A compute-only kind — a Notebook, a Pipeline —
holds no OneLake storage by nature, so null bytes is a *complete* measurement of an item that stores
nothing, and it sits on `MIN_FOOTPRINT`. A storage-bearing kind — a Lakehouse, a Warehouse — with
null bytes is missing evidence and draws `vacant`/wireframe. `canHoldStorage(kind)` in `itemKind.ts`
is the only thing that separates the two; collapsing them either fills the city with false wireframes
or hides real gaps. `itemMassing` draws `vacant` when *either* footprint or height is missing, so a
building with a known lot but unknown CU still fences rather than claiming a height of zero.

`capacityCity.test.ts` pins this in `describe('measurements that are missing rather than zero')`.
When you change any of it, mutate the fix and watch that block go red first — a footprint helper that
returns `MIN_FOOTPRINT` for a missing Lakehouse, or a height helper that returns `0` for unknown CU,
must fail a test, or the guard is advertising protection it does not provide.

`cityPlan.ts`, `cityBuildings.ts`, `CapacityCityScene.ts` and the city view components are still in
`src/pending-port/` — they consume a `CityPlan` that does not exist yet against the Fabric contracts,
and `cityPlan.ts` (the schema-split neighbourhood builder) is the blocker for all of them.
