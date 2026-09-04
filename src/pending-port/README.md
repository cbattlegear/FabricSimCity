# Pending port

22 modules and 23 test files from SQLSimCity that the Fabric port has not reached yet. They are
excluded from `tsconfig.json` and from `vitest.config.ts` — deliberately in agreement, so a module
here is neither type-checked nor run, and nothing in the shipped app imports one.

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
- `cityPlan.testkit.ts` and the `cityGrowth*` family (`cityGrowth.testkit.ts` +
  `cityGrowthLots/Placement/Retrace/Streets.test.ts`) — moved with their subject. The four-files-over-one-testkit
  layout is preserved intact (`cityGrowthRetrace.test.ts` is left alone on the critical path); do not merge them.

**Still quarantined** (too large / too interconnected to port safely without the scene):

| Module | What it needs |
|---|---|
| `CapacityCityScene.ts` | Mostly domain-agnostic (221 KB) — it consumes a `CityPlan`, which now exists. Unblocked. **Read `AGENTS.md` on shadow invalidation before touching its loops**, and check the `shadowInvalidation.test.ts` / `cityVehicle*` slice anchors. |
| `CapacityCityView.tsx`, `CapacityCityViewport.tsx`, `AddressPanel.tsx`, `addressBook.ts` | Follow the contracts; no independent decision. Blocked on the scene. Note: `CapacityCityView.tsx` passes the plan `workspaces` option (was `schemas`). |
| `cityWeathering.test.ts` | A cityBuildings weathering guard that also slices `CapacityCityScene.ts` via `import.meta.url`; moves to `src/` with the scene. |


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

**Still quarantined** (blocked on `cityPlan` geometry):

| Module | What it needs |
|---|---|
| `cityFacilityTraffic.ts` | Wait-category facilities become the power/reservoir/carry-forward/gate set. The lane routing survives; only the facility roster changes. |

### `operation-traffic` — roads and vehicles

| Module | What it needs |
|---|---|
| `operationMapping.ts` | Renamed from `queryFamilyMapping.ts`. Operation name × item, in place of query hash × object. |
| `cityQueryTraffic.ts`, `cityWorkloadTraffic.ts` | Split on operation class: interactive → cars, background → freight. The vehicle system already carries both types. |
| `cityTraffic.ts`, `cityVehicles.ts` | Domain-agnostic once fed. `cityVehicles.ts` is pinned by shadow and legibility guards — check the slice anchors. |
| `cityRoute.ts`, `planCost.ts` | **These may not survive.** Both exist to parse showplan XML and work out which objects a query touched. Capacity Metrics attributes each operation to an `Item Id` directly, so the inference is unnecessary. `OperationFamily.itemIds` carries the endpoints. Port only if a lineage operation genuinely needs two. |

### `throttle-incidents` and `capacity-disasters`

| Module | What it needs |
|---|---|
| `cityIncidents.ts`, `IncidentPopup.tsx` | Rejected and failed operations in place of blocking chains. |
| `cityBlocking.ts` | Blocking has no Fabric analogue. The nearest thing is throttle queueing, which is a capacity-wide state, not a pairwise one — likely a rewrite rather than a port. |
| `cityDisasters.ts`, `cityDisasterSurvey.ts` | Overload states as brownout/blackout weather, keyed on `CapacityStateReason`. |

### `live-timepoints`

| Module | What it needs |
|---|---|
| `liveFeed.ts`, `liveQueryFeed.ts` | 30-second capacity timepoints in place of DMV samples. Cadence is fixed and documented, so the clock gets simpler, not harder. |
| `cityRefresh.ts` | Closest to portable. Rayfin has no cron or background workers, so client-side polling is the only option and this already does exactly that. |

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
