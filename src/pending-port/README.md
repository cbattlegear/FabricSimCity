# Pending port

The React UI mount layer (`CapacityCityView.tsx`, `CapacityCityViewport.tsx`) and one test
(`cityTour.test.ts`) from SQLSimCity that the Fabric port has not reached yet. They are
excluded from `tsconfig.json` and from `vitest.config.ts` — deliberately in agreement, so a module
here is neither type-checked nor run, and nothing in the shipped app imports one. The 3D city scene
itself (`CapacityCityScene.ts`), the vehicle system (`cityVehicles.ts`) and the camera tour
(`cityTour.ts`) have been ported out to `src/` and tested — see the `port-city` section below.

They are kept rather than deleted because each one is a solved rendering problem. The traffic
system, the incident pins, the disaster survey and the tour camera all work; what they do not have
is a Fabric field to read. Deleting them would mean re-deriving the geometry as well as the
semantics, and the geometry is the part that took the longest to get right.

## Why they could not be ported mechanically

The atlas ported cleanly because a capacity and a database are the same *shape*: a named thing with
a size, a utilization and a state. The city did not, because the SQL concepts it reads have no
Fabric field behind them at all.

The bulk renames took the tree from 780 type errors to 567. What was left was not vocabulary. It
was `queryStore`, `liveActivity`, showplan node types, index statistics and wait categories — none
of which Fabric emits. A rename cannot invent a measurement.

## What each module needs

Grouped by the todo that unblocks it, because they do not become portable one at a time.

### `port-city` — items as buildings

**Ported out so far** (moved to `src/`, rewritten against the Fabric contracts, tested, and each
guard mutation-checked against the broken state):

- `capacityCity.ts` — the keystone. `bytesToFootprint`/`itemFootprint` size a building from OneLake
  bytes, `itemHeight` raises it from CU-seconds (importing `cuToHeight` from `capacityAtlas.ts`
  verbatim so the two levels share one scale), and `itemMassing` resolves the pair into `built` vs
  `vacant`. It holds the "missing rather than zero" line at the item level, with the one subtlety the
  city adds: a compute-only kind with null bytes is a *measured* minimum lot, while a storage kind
  with null bytes is missing evidence and draws wireframe — `canHoldStorage` in `itemKind.ts` is what
  tells the two apart. The old SQL-era `capacityCity.ts` (query-store exposure, index DMV counters)
  was deleted, not adapted; nothing in it survived the contract change.
- `cityPaging.ts` — reduced to almost nothing, as predicted. It now folds `items`, `routes`,
  `workspaces` (summing counts, null-preserving) and each family's `itemIds` across pages. The
  wait-attribution and per-object confidence machinery is gone, because the new `OperationFamily`
  carries no such fields.
- `cityPlan.ts` — the neighbourhood/lot planner. Splits the city by **Fabric workspace** (grouping,
  neighbourhood territories and districts are all keyed on `workspaceId`; the `CityPlanOptions.schemas`
  option is renamed `workspaces` to match `CapacityCityPage.workspaces`, and `CityDistrict.kind` is
  now `'workspace' | 'civic'`). A building's footprint and height are no longer derived here: `placeLot`
  reads `itemFootprint`/`itemHeight` from `capacityCity.ts` verbatim, so an item and its capacity raise
  a skyline on one scale, and a missing measurement flows straight onto the lot as `null` and draws
  `vacant`. `buildingArchetype` is the *visual* style (`house`…`skyscraper`), size-driven from OneLake
  bytes, and returns `vacant` exactly when `itemMassing` is vacant — a compute-only kind with null bytes
  is a built `house`, not a wireframe. The SQL-era page-count helpers (`buildingFootprint`,
  `buildingHeight`, `pageCount`, `ARCHETYPE_THRESHOLD_PAGES`) and the `IndexedView`→`civic` mapping were
  deleted; no item is `civic` on Fabric, so that member is retained in the union for the geometry kit
  but no longer produced.
- `cityBuildings.ts` — the procedural building geometry and palette. Purely presentational: it consumes
  a `CityLot` and a `BuildingArchetype` and needed no logic change, only its import paths. Guarded by
  `cityBuildings.test.ts` (colour/tint). Its weathering guard, `cityWeathering.test.ts`, stays
  quarantined because it slices `CapacityCityScene.ts` as source text — it rejoins when the scene ports.
- `addressBook.ts` + `AddressPanel.tsx` — the flat searchable index of everywhere the map can take
  you (operation families, items, facilities) and the panel that renders it. Rewritten against the
  Fabric contracts: item footprint reads `item.storage` (a `ByteMeasurement`) rather than SQL
  `storageBytes`, operation rows read `operationName`/`operationCount`/`cuSeconds` rather than the
  query-store `executionCount`/`totalCpuMicroseconds`/`rationale`, the `table` address kind is now
  `item`, and the cross-reference wording ("in another database") is now off-page wording ("outside
  this page") since a Fabric city is one capacity. Facilities still come from `cityInfrastructure`,
  matching the facility set the current `cityPlan` scatters. Guarded by `addressBook.test.ts`
  (rebuilt with Fabric fixtures and mutation-checked against the missing-rather-than-zero rule). The
  panel is not yet rendered — `CapacityCityView.tsx` is what mounts it — but the module is portable
  and tested on its own.
- `cityPlan.testkit.ts` and the `cityGrowth*` family (`cityGrowth.testkit.ts` +
  `cityGrowthLots/Placement/Retrace/Streets.test.ts`) — moved with their subject. The four-files-over-one-testkit
  layout is preserved intact (`cityGrowthRetrace.test.ts` is left alone on the critical path); do not merge them.

**Ported out** (moved to `src/`, rewritten against the Fabric contracts, tested, and each guard
mutation-checked against the broken state):

- `CapacityCityScene.ts` — the 3D city itself. Its imports were repointed (`../` → `./`), the deleted
  `cityRoute`/`liveQueryFeed` imports removed (the selected-route highlight is retired behind a local
  minimal type pending a Fabric lineage-route source, and vehicles no longer read a live feed), and
  its three surviving SQL-era reads rewritten: the index annexes (`object.indexes` / `directActivity`)
  were removed (no Fabric analogue), and the amber CPU roof cap (`object.attributedExposure`) became a
  **CU-regression cap** derived from `performanceDeltaPercent` — a red cap on items whose CU regressed
  week-over-week, sized by the regression, with a **null delta drawing no cap at all** (never
  "unchanged"). Road/street field renames (`executions` → `operations`) and the new
  `IncidentSeverity` (`delay`/`interactiveRejection`/`backgroundRejection`, replacing the SQL
  `blocked`/`waiting`/`cycle`/`deadlock`) were applied; wreckage now sits under a **rejection** pin and
  blocked-vehicle placements key on `itemId`. `setVehicles(events, families)` became
  `refreshVehicles()`, since vehicles now derive from the graded roads the scene already holds. The
  shadow-invalidation contract is intact (three loops, three handles, all cancelled in `dispose()`;
  vehicles `castShadow = false`; the vehicle loop stops on an empty roster and never touches
  `needsUpdate`) and all of `shadowInvalidation.test.ts` still binds and was mutation-verified.
- `cityVehicles.ts` — **a semantics rewrite onto the trip/road model.** The SQL live-execution roster
  (`LiveQueryEvent` / `query_hash` / `planDataVolume`) is gone; a vehicle is now a measured share of a
  road's operation traffic. An **unmeasured road (`operations === null`) gets no vehicles** (distinct
  from a measured-quiet road, which is counted apart); class is the operation class (interactive → car,
  background → freight/`semiTruck`, unclassed → `unknown` cube — the four-rung size ladder survives in
  the scene's `VEHICLE_SIZE` and `vehicles.glb` but only `car`/`semiTruck`/`unknown` are produced,
  because Fabric publishes no per-operation size); and **speed is graded off the same
  throttling-per-operation ratio the road colour is** (`delayPerOperation`), so paint and motion never
  contradict. Guarded by a rewritten `cityVehicles.test.ts` and `vehicleSpeedWiring.test.ts`, both
  mutation-checked (unmeasured road → no vehicles; congested road slower than free; missing ratio →
  base speed).
- `cityTour.ts` — the camera tour. Landmark ranking rewired off `cuConsumed`/`storage` (was attributed
  CPU / reserved pages), captions rewritten into Fabric vocabulary, road ranking onto
  `delayPerOperation`/`operations`, and `severityRank` onto the new incident severities. The module
  compiles and ships; **its test `cityTour.test.ts` is left quarantined** (a full rewrite of a 25 KB
  suite that was not on the critical path for the scene).
- `cityWeathering.test.ts`, `trailGeometry.test.ts`, `cityDepthRanks.test.ts`, `cityVehiclePaint.test.ts`,
  `vehicleSpeedWiring.test.ts` — the source-text/geometry guards that slice the scene, moved with it.
  `shadowInvalidation.test.ts`, `cityVehicleAssets.test.ts`, `cityVehicleLegibility.test.ts` (already in
  `src/` via the `sourcePath()` fallback) rebind to the shipped scene; all three slice anchors still
  hold `to > from` and were mutation-verified.

**Still quarantined** (the React UI mount layer — one coherent blocked unit):

| Module | What it needs |
|---|---|
| `CapacityCityView.tsx`, `CapacityCityViewport.tsx` | The scene, `cityVehicles`, and `cityTour` are ported and tested, so the geometry these mount is ready. The **view** is the block: it carries ~146 type errors that are a genuine semantic rewrite, not a rename — its object-detail panel and evidence tables render deleted query-store fields (`attributedExposure`, `directActivity`, `indexes`, `reservedBytes`, `usedBytes`, `storageBytes`, `cuSecondsRaw`), and it calls the pre-Fabric signatures of `projectIncidents(snapshot, objects)`, `projectFacilityTraffic(families, objects)`, `runDisasterSurvey`, `projectCityDisasters`, plus deleted `../api`, `./liveFeed`, `./cityRoute`, and `NormalizedShowplan`. Rewiring these to `surveyCapacityWeather` / `projectCityDisasters({throttle,items,capabilities})` / `projectIncidents({families,items,samples,throttle,capabilities,observedAt})` / `projectFacilityTraffic(families,items,throttle,capabilities)` / `startTimepointClock`, deciding what each Fabric item/family/facility detail panel should show, wiring `AddressPanel` and the `.sidebar-drawers` budget, and then **browser-verifying** the result at both breakpoints — is a task on the scale of the scene port itself. The viewport ports cleanly (verified: it compiles with a local `CityRoute` type, dropping the `liveQueryFeed`/`liveQueries`/`families` inputs, `setVehicles` → `refreshVehicles`, and `FacilityTraffic.unmapped` → `unattributedSeconds`); it is quarantined with the view so the mount layer stays one unit for whoever ports it. |


### `power-grid` — the civic infrastructure

**Ported out so far** (moved to `src/`, rewritten against the Fabric contracts, tested, and guard
mutation-checked against the broken state):

- `cityThrottleAttribution.ts` — wait-category attribution is now throttle-stage attribution. It
  places measured `OperationFamily.throttlingSeconds` only when the family operation class, rejected
  count and capacity throttle gauges identify one honest power-grid gate. Missing throttling seconds
  and missing gauges stay unmeasured/unattributed rather than becoming zero-load lanes.
- `powerGrid.ts` — the canonical power-grid roster: Power Plant, Smoothing Reservoir,
  Carry-forward Yard, Delay Gate, Interactive Rejection Gate, Background Rejection Gate and Surge
  Substation. Each facility exposes its stable identity, driving measurement and derived
  healthy/loaded/brownout/blackout state; a missing driving measurement yields
  `MeasurementStatus.Unknown` plus a null state for wireframe rendering.
- `cityFacilityTraffic.ts` — wires each `(item, stage)` throttle attribution into a drawable lane
  from the building to the gate that held its work. Lanes are coloured by
  `congestionFromDelay(throttlingSeconds / operations)` — the *same* rule the roads grade by — so a
  lane and the street beside it never disagree; the delay gate is `delayed` load and never a
  `refused` blackout; a family with no measured throttling seconds draws no lane, and a lane with no
  operation count grades `unknown` (grey) rather than `free` (green). Exports
  `POWER_GRID_STATE_LEGEND`, `POWER_GRID_FACILITY_LEGEND` and `FACILITY_LANE_LEGEND` as data for the
  scene to render (the city legend still lives in the quarantined `CapacityCityView.tsx`).

**Still quarantined** (nothing remains in this todo — the scene port is the next wave):

| Module | What it needs |
|---|---|
| _(none — the domain layer is fully ported; `CapacityCityScene.ts` wiring is the next wave)_ | — |

### `operation-traffic` — roads and vehicles

**Ported out** (moved to `src/`, rewritten against the Fabric contracts, tested, and each guard
mutation-checked against the broken state):

- `operationMapping.ts` — the keystone (renamed from `queryFamilyMapping.ts`). Operation name × item
  in place of query hash × object. It only ever read `itemIds`, so it ported almost verbatim:
  `familyOnMap`/`placedObjectIds`/`splitQueryFamiliesByMap` still decide which ranked families this
  paged city can actually draw and disclose how many it hid. Guarded by a trimmed
  `operationMapping.test.ts` over the pure functions; the old view-integration guards that sliced
  `CapacityCityView.tsx` and imported `addressBook.ts` were dropped and belong with the scene, which
  must re-add them when it mounts the families table.
- `cityTraffic.ts` — the road grader, now domain-fed by operation families. A road is an
  `OperationFamily` naming both endpoints (`route.fromItemId`/`toItemId` ∈ `family.itemIds`); its
  colour is the mean **throttling seconds per operation** over the pair, replacing SQL's mean wait
  milliseconds. The GPS ladder (`congestionFromDelay`) is unchanged in shape, only its unit and
  thresholds. New: `trafficModeForClass` (interactive → car, background → freight, unknown → neither);
  `carOperations`/`freightOperations` on every road; and
  `trafficEvidenceState`/`describeTrafficEvidence`, which turn the source's separate
  `operationFamilies` capability into a first-class `unsupported`/`none`/`measured` state, so a source
  that cannot see roads at all withholds the layer rather than drawing an empty-but-measured city. A
  pair no family names grades `unknown` (grey), never `free`.
- `cityWorkloadTraffic.ts` — the aggregate street loader. Drives each family through the items it
  touched, once per measured operation, and colours each street by throttling-per-operation on the
  same ladder. The showplan cost/wait attribution it used to import from `cityThrottleAttribution`
  (`familyCostShares`, `familyWaitByObject`) is gone — those fields do not exist on Fabric — and is
  replaced with local logic: the journey starts at the family's primary item (`itemIds[0]`), and the
  measured `throttlingSeconds` is split **evenly** across the items it touched, which is the only
  defensible model because Capacity Metrics never attributes throttling below the family. Streets and
  trips carry the car/freight split. `congestionFromDelay` is re-exported (the same function object,
  pinned by a test) so a street and its co-reference road grade identically.
- `cityQueryTraffic.ts` — the co-reference ribbon assigner, domain-agnostic; only its import paths and
  the `executions`→`operations` field rename changed. It still spreads measured ribbons across the
  street network via `assignTraffic` so a busy corridor reads as several routes.

Guarded by fresh Fabric-typed tests (`cityTraffic.test.ts`, `cityWorkloadTraffic.test.ts`,
`cityQueryTraffic.test.ts`, `operationMapping.test.ts`) over a shared `operationTraffic.testkit.ts`.
Mutation-checked: an unmeasured family grading as `free`/zero (road **and** street paths), interactive
and background collapsing to one vehicle class (road split, street split, and `trafficModeForClass`),
and the source-cannot-report-families capability collapsing into measured-quiet.

**Deleted, not ported:**

- `cityRoute.ts` and `planCost.ts` (with their tests). Both existed solely to parse **showplan XML**
  and infer which objects a query touched. Fabric's Capacity Metrics attributes each operation to an
  `Item Id` directly, and `OperationFamily.itemIds` already carries both endpoints of a lineage
  operation, so the inference is obsolete. Their `NormalizedShowplan`/`ShowplanNode` inputs have no
  Fabric contract behind them at all. No lineage operation here needs two endpoints the family does
  not already provide, so deleting them removed dead inference rather than a capability — the
  "deleting them is a legitimate outcome" the todo endorsed.

**Still quarantined** (owned by the scene port):

| Module | What it needs |
|---|---|
| `cityVehicles.ts` | **Ported** to `src/` with the scene (a semantics rewrite onto the trip/road model). See the `port-city` section above. |

### `throttle-incidents`

**Ported out** (moved to `src/`, rewritten against the Fabric contracts, tested, and each guard
mutation-checked against the broken state):

- `cityBlocking.ts` — the blocked-session model, re-pointed onto rejected operations. Blocking has no
  Fabric analogue, so this is a rewrite: `liveRejectionEdges(samples, items, capabilities)` resolves
  live `OperationSample`s with `status === 'Rejected'` onto the loaded items they name, split by the
  class that decides which gate refused them (interactive / background / unknown). It keeps the
  `LiveBlockingEdge` wire into `cityTraffic.gradeRoads` intact — `edges` is exactly that shape, so a
  rejected item's roads still grade to the blocking band. Only `status === 'Rejected'` is an edge: a
  delayed-but-succeeded operation carries `status === 'Success'` and is deliberately not one, which is
  the severity ladder held at the source. Follows `cityTraffic`'s `unsupported`/`none`/`measured`
  vocabulary — a source that reports `operationSamples: false` withholds the layer (`unsupported`)
  rather than drawing a clean bill of health.
- `cityIncidents.ts` — the keystone. A SQL blocking chain becomes a **throttling incident**: one item
  × one throttle stage, pinned to the item whose operations drove the overload. It composes the landed
  layers rather than re-deriving them — `cityThrottleAttribution.attributedThrottling` supplies the
  retained-window markers (item, stage, facility, seconds, responsible families), `cityBlocking`
  supplies live corroboration and stands up a live-only marker where the retained window has not caught
  up, and `powerGrid` names the gate. Severity is `delay` < `interactiveRejection` < `backgroundRejection`;
  `stopsTraffic` returns true only for a rejection, so an interactive delay is drawn as busy, never as a
  crash, exactly as `capacityAtlas.isRejecting` excludes it. `incidentEvidenceState` is the "cannot know"
  rule: with no markers it says `unsupported` (not observed) whenever the throttle gauges are unmeasured
  **or** the source can report neither families nor samples, and only says `none` for a readable, quiet
  capacity. `incidentSummaryLabel` returns "Not observed" for `unsupported`, never "No throttling".
- `IncidentPopup.tsx` — the HTML popup (`IncidentPopup`) plus the folded one-line status
  (`IncidentSummary`). Rewritten for the new `IncidentProjection`: it reads `incidentSummaryLabel`/
  `incidentSummaryTone`, surfaces off-map and unclassed rejections, and renders each marker's stage,
  responsible operations and carry-forward from the marker `details`. `IncidentSummary` also lists the
  markers as buttons so the popups are reachable by keyboard, not only by picking a sphere.

Guarded by fresh Fabric-typed tests (`cityIncidents.test.ts`, `cityBlocking.test.ts`). Mutation-checked:
(a) an unmeasured gauge / a source that cannot report families or samples collapsing into "No throttling"
(three tests fail against the broken state); (b) `InteractiveDelay` promoted to rejection severity —
`stopsTraffic(delay)` and the delay-is-not-a-rejection-incident tests fail against the broken state.

**Scene wiring left for the scene wave**: `CapacityCityScene.ts` must call `projectIncidents({ families,
items, samples, throttle, capabilities, observedAt })`, place each `IncidentMarker` with
`cityIncidentPlacement.placeIncident(marker.itemId, marker.counterpartObjectIds, …)`, render
`IncidentPopup`/`IncidentSummary`, halt a vehicle at a marker only when `stopsTraffic(marker)`, and pass
`projection.liveRejections.edges` to `gradeRoads`.

### `capacity-disasters`

| Module | What it needs |
|---|---|
| `cityDisasters.ts`, `cityDisasterSurvey.ts` | **Ported out** (rewritten to `src/`, tested, mutation-checked). The SQL versions (showplan surveys, missing-index fires, deadlock crashes, stats decay) were deleted, not adapted — every input they read has no Fabric field behind it, exactly like `cityRoute`/`planCost`. `cityDisasterSurvey.ts` now holds `surveyCapacityWeather`, which reads the sky from the capacity throttle ladder (clear → overcast/gathering-storm at interactive delay or carry-forward debt → rolling-blackout at interactive rejection → blackout at background rejection), keeping the delay-is-weather / rejection-is-disaster line `isRejecting()` draws. `cityDisasters.ts` holds `projectCityDisasters`, which pins the blackout to buildings with a *measured* rejected count. An unmeasured capacity (paused/disconnected) renders `unknown`, never `clear` — a paused capacity's `stage` is `None` just like a clear one, so the verdict keys on measured evidence, not stage. `cityWeathering.test.ts` stays quarantined: it slices `CapacityCityScene.ts` as source text with no `sourcePath()` fallback, so it can only rejoin `src/` with the scene. |

### `live-timepoints`

**Ported out** (rewritten to `src/`, tested, mutation-checked). The SQL "live query feed" polled
`sys.dm_exec_requests` for sessions *running right now*; Fabric has no such thing. The Capacity
Metrics app reports 30-second `CapacityTimepoint`s that land with `latencySeconds` delay, so the
honest replacement is a **timepoint clock**, not a live feed, and it is named for what it is.

| Module | What happened |
|---|---|
| `liveQueryFeed.ts` | **Renamed to `src/timepointFeed.ts`.** Pure fold `advanceTimepointFeed` that advances one timepoint at a time and reports the **age** of the newest landed timepoint; it never labels it "live" or "now". Evidence follows `cityTraffic`'s vocabulary — `timepointEvidenceState` returns `unsupported` (capability absent → *cannot know*) / `none` (capable, nothing landed → measured absence) / `measured`, keyed on the capability flag not the array length. Future-dated timepoints (the throttle gauge's forward-smoothing series) are never landed. `describeTimepointEvidence`, `timepointClockLabel`, `timepointAgeSeconds` surface the age so stale is never drawn as current. |
| `liveFeed.ts` | **Deleted, replaced by `src/timepointClock.ts`.** The SignalR transport talked to a deleted .NET hub; a Fabric App on Rayfin has no push hub (no cron/worker/channel). `startTimepointClock` is a cancellable client-side poller over the `CapacitySource` seam: it polls at `refreshIntervalMs`, **schedules no loop at all** for a source without the `timepoints` capability, and its disposer clears the interval + aborts in-flight + drops a late result. |
| `cityRefresh.ts` | **Ported to `src/cityRefresh.ts`.** The hardcoded `CITY_REFRESH_INTERVAL_MS = 30_000` became `refreshIntervalMs(capabilities) = max(TIMEPOINT_SECONDS, latencySeconds) * 1000` — cadence derived from the source's declared latency, never faster than a 30-second timepoint can land. Content-stability signatures rewritten onto Fabric fields. |
| `api.test.ts`, `edgeUi.test.ts` | **Deleted, not ported.** `api.test.ts` tested `liveFeed.ts`'s SignalR `subscribeToLiveIncidents` against `../api` (deleted). `edgeUi.test.ts` was a source-text guard over edge-connector/deployment-notice UI in `App.tsx`/`api.ts` that no longer exists. Both test infrastructure with no Fabric analogue; keeping them would raise a count with dead assertions. |

**Scene wiring left for the scene wave**: `CapacityCityScene.ts`/`cityVehicles.ts` still `import type { LiveQueryEvent } from './liveQueryFeed'` (now gone) — those consumers must be rewired to `TimepointFeed`; mount `startTimepointClock` + fold with `advanceTimepointFeed`; pass `refreshIntervalMs(source.capabilities)` to `describeTrafficWindow`; render `timepointClockLabel`/`describeTimepointEvidence`. The vehicle roster / operation-sample feed is the vehicle agent's separate concern.

### Test kits

`cityGrowth.testkit.ts` and `cityPlan.testkit.ts` built synthetic plans and have been ported out to
`src/` with their subject `cityPlan.ts`. The `cityGrowth` family is still **four spec files over one
testkit** — it stayed that way through the port and must stay that way: `cityGrowthRetrace.test.ts`
alone runs ~24s, and Vitest schedules a *file* onto a worker, so merging them re-serialises the suite
and roughly doubles it. Add growth tests to one of the other three; leave the retrace file alone.
`AGENTS.md` covers this.

## Porting one out

1. Move it back to `src/`, and rewrite `from '../X'` to `from './X'` for anything that did not move
   with it.
2. Delete nothing from the exclude lists until `npx tsc -b` is clean — the two lists are kept in
   agreement, so update both together.
3. Run the module's own tests, then **mutate the fix and confirm they fail**. Several guards here
   read source text rather than behaviour and will pass vacuously against a renamed symbol.
4. Check the slice anchors if it is one of the files sliced as source text
   (`cityVehicles.ts` via `cityVehicleAssets.test.ts` and `cityVehicleLegibility.test.ts`,
   `CapacityCityScene.ts` via `shadowInvalidation.test.ts`). An anchor that moves above its start
   anchor inverts the window silently and every lookup inside it finds nothing.

## The rule that has to survive the port

Never draw a guess. A measurement that is missing renders as wireframe, not as zero — a paused
capacity and an idle one produce identical zeroes and are completely different things. The atlas
already holds this line (`capacityHeight()` returns `null` rather than `0`, and
`capacityAtlas.test.ts` pins it). Every module here has to hold it too.
