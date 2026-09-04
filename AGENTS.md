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
semanticModelSource   DAX via the fabric-semanticmodel connector      [default, not yet written]
eventhouseSource      KQL via the kusto connector                     [not yet written]
fixtureSource         deterministic synthetic evidence                [the development loop]
```

`capabilities` is declared up front so the UI decides what to draw *before* it asks. A source
without per-item CU breakdown degrades to live infrastructure over static buildings rather than
failing.

**Fixture mode is the primary development loop, not a fallback.** Rayfin has no local backend and
no `rayfin dev`; `npm run dev` runs Vite against a *deployed* backend. Without fixtures the city is
undevelopable without a Fabric tenant. `App.tsx` constructs the source at module scope — that one
line is the swap point.

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
- Connectors are **private preview** and delegated-auth only: every user needs their own capacity
  metrics permissions, and there is no service-principal path where the app reads once for everyone.
- Static bundle caps at 100 MB compressed.

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

## Validation commands

```powershell
npx tsc -b            # 0 errors expected; the correct typecheck, see the Rayfin note above
npx vitest run        # 1,083 tests / 66 files
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
