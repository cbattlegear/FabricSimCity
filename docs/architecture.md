# Architecture and evidence model

SQLSimCity is an evidence-first performance visualization, not a SQL Server emulator and not an
automated tuning service. The API owns data reduction and evidence classification; the browser
renders bounded projections.

## Source layers

```text
src/SqlSimCity.Contracts  versioned transport and evidence contracts
src/SqlSimCity.Domain     source-neutral API seams and fixture sources
src/SqlSimCity.SqlServer  validated connection and authentication strategies
src/SqlSimCity.Collection static SQL probes, capability negotiation, Atlas/City/Query Store/live collectors
src/SqlSimCity.Storage    plaintext protected SQLite records and retention (legacy sealed records still open)
src/SqlSimCity.Findings   deterministic rules and evidence references
src/SqlSimCity.Archive    hostile-input archive format and offline adapters
src/SqlSimCity.Edge       signed delivery, replay defense, encrypted spool, atomic edge generations
src/SqlSimCity.Api        same-origin HTTP, SignalR, source registration, and static hosting
web/                      React analytical UI and imperative three.js scenes
```

The city and analytical views consume the same versioned contracts in fixture, connected, archive,
and edge modes.

## Evidence boundaries

SQLSimCity keeps materially different evidence types separate:

1. **Query Store aggregates** describe retained intervals. They are not current activity, per-execution
   traces, or actual operator timing.
2. **Live DMV samples** prove what was visible at one sample instant. Requests and blocking that begin
   and end between polls can be missed.
3. **Cumulative DMV counters** produce rates only after two comparable samples in the same reset
   epoch. First samples, resets, and regressions never become fabricated zero or negative rates.
4. **Catalog metadata** describes objects, files, compatibility, and capabilities at collection time.
5. **Attributed/inferred evidence** carries an explicit confidence and rationale. Query-level cost is
   never copied to every object in a multi-object plan.
6. **Unavailable evidence** remains unavailable, permission denied, disconnected, stale, unsupported,
   or not probed. It never becomes numeric zero.

Exact SQL `bigint` and aggregate values cross JSON as decimal strings. The frontend uses `BigInt`
only for exact formatting and converts to bounded numeric scales solely for visual mapping.

## Product surfaces

The UI is one surface: a full-bleed map with a sidebar over it. The map is the product — there is no
tab bar, and no page that is not the map.

The sidebar is an **address book** (`web/src/addressBook.ts`): one flat, searchable list holding
query families, tables, and infrastructure facilities together, each with a measured one-line summary
and an address derived from the city plan (`dbo · Block C4`). One search box matches all three kinds,
so you look up a place rather than first having to know which category it lives in — searching a
table name also surfaces the query families that drive traffic to it. Selecting an entry selects it
on the map and replaces the list with a place card carrying the existing evidence panels verbatim.
An entry whose object is not on the loaded bounded page has no lot, and says so rather than inventing
a location.

Everything else floats over the canvas: the view-mode toggle, camera controls, the layer switches,
a status chip, and the incident summary. The evidence tables and the visual-semantics prose live
behind a "Legend & evidence" disclosure in the sidebar footer — kept in full for accessibility and
honesty, but no longer the page. The deployment-security notice and the archive and edge banners are
floating cards that default to visible and are dismissed only by the reader.

### Server atlas

The atlas shows up to 100 databases, and each one is drawn as a small city on a shared grid, not as a
single block. A database is therefore a city at both altitudes: the atlas and the database city read
as two heights over one place rather than as two unrelated diagrams.

Exactly two properties are measured, and they are the pair the database city measures one level down.
Everything else is either a consequence of them or decoration.

| Encoded property | Evidence |
| --- | --- |
| City plot side | known allocated bytes, through the documented logarithmic mapping `t = min(1, log₂(1 + A) / 50)`, `area = 144 + 9072t` |
| Tallest tower height | known used bytes, `log₂(1 + U) × 2.6`, so zero used bytes is zero height |

Block count follows from the plot rather than claiming anything of its own: `web/src/atlasCity.ts`
divides every city at one constant block pitch, so a larger database is a larger city with more
blocks in it and block *size* never varies. Skyline shape, setbacks, masts, and the small per-lot
width variation are decoration seeded from the database's stable id, so a city's shape never changes
between renders and never moves when its measurements do.

Unknown never degrades into a small number, in either direction. Unknown allocated size draws the
nonquantitative × parcel and no city at all; known allocated size with unknown used size draws the
real plot and its real block grid with every lot fenced and empty, because the ground was measured
and the skyline was not.

Every city is named on the ground, with the label vocabulary shared with the database city
(`web/src/cityLabels.ts`). Live concurrency, historical Query Store load, capacity, and data quality
remain separate dimensions, reported in the evidence table rather than in the geometry. A fresh live
sample adds a pulsing beacon over the city, and inferred topology edges keep their own line styles.

Hovering a city reports its name, a click selects it and fills the evidence panel, and a double-click
enters that database's city, so the atlas descends to the next altitude by the same gesture a map
uses. A double-click only opens the city that both of its clicks landed on
(`web/src/atlasActivation.ts`): the browser pairs any two clicks that fall close together in time,
and clicking one database and then its neighbour to compare them must not throw the reader into
either of them. The detail panel's "Enter database city" button stays the keyboard-reachable way to
do the same thing, and the evidence table below stays the non-WebGL one.

Placement and framing are presentation, not evidence, and both exist so the encodings above can
actually be compared by eye. `web/src/atlasLayout.ts` reserves one of a hundred grid slots per
database and hands out the slots nearest the centre first, so a server with eight databases is a
compact cluster rather than eight specks scattered over a thousand units of empty ground; a database
never moves once it holds a slot, and which database claims the centre is decided by its stable id
rather than by arrival order. `web/src/atlasFraming.ts` then solves the camera distance that fits the
cities that exist, against the real viewport shape, by fitting the corners of their bounding box
rather than its bounding sphere — the atlas is a wide, nearly flat subject, and sphere fitting would
stand the camera off as though it were a cube. Distance and direction change what is legible, never
what is claimed.

Cities are merged into one geometry per database and cached by the measurements that shape them, so
the thirty-second atlas refresh rebuilds nothing that did not move.

### Database city

Schemas are stable neighborhoods. Tables and indexed views are buildings sized by exact 8-KiB page
counts. Indexes are attached structures on their parent object. Direct index DMV activity and
Query Store-attributed exposure use different evidence and visual styles.

#### Attributed and shared exposure

Query Store measures one set of totals per query, not per object. A query that joins four tables has
one CPU figure, and nothing in Query Store says how much of it each table caused. SQLSimCity
therefore reports exposure in two separate shapes and never mixes them:

- **Attributed exposure** is assigned to an object only when a ranked query family names that object
  and nothing else — no second local object, no cross-database target, no reference the collector
  could not resolve. Anything less and the totals are not that object's to claim.
- **Shared exposure** carries the query-level totals of families that named the object *alongside
  others*. The figures appear **whole** on every object those families named, because a per-object
  share would have to be invented. `DatabaseCitySharedExposureV1.Rationale` says so in the payload
  itself, and the map draws it as an outlined roof cap rather than a solid one.

Summing shared exposure across buildings double-counts by construction. That is the point: a total
that cannot be divided honestly is better shown repeated, and labelled, than split or hidden.

Without shared exposure a normalized schema renders almost entirely blank, because on such a schema
`local.Count == 1` is close to unreachable — shrink the page and joined tables fall off it, widen it
and they come on-page. The strict attribution rule is deliberately unchanged; shared exposure is what
makes that strictness survivable on a real workload.

The city is laid out as a real street grid rather than a bar chart. `web/src/cityPlan.ts` builds a
uniform block lattice and scatters lots across it using a seeded generator (`web/src/citySeed.ts`),
so a city looks like a city instead of a packed rectangle while remaining completely deterministic:
the seed is a stable hash of the database's own id, and every draw comes from that one stream. The
same database therefore lays out identically on every load, in every browser, on every machine.

Two rules make that scatter safe to build on:

- **Appending a page never moves a building.** The grid is sized from `page.totalObjects` (plus the
  facilities and slack), not from how many objects happen to be loaded, and each object's slot is
  `Σ(objectCount of schemas with a lower neighborhoodOrdinal) + objectOrdinal`. Because every page
  carries the complete schema list with full per-schema counts, that slot is page-independent.
  Filtering the address book does not rearrange the city either.
- **Facilities are spread out.** The six civic facilities are placed first, each drawn from the seeded
  stream and accepted only when its Chebyshev distance to every already-placed facility is at least
  `MIN_FACILITY_BLOCK_GAP` (2 blocks), so infrastructure is distributed across the map rather than
  clustered in one corner. On a grid too small to satisfy that, a deterministic
  maximise-minimum-distance sweep takes over, so a four-table database still lays out — just tighter,
  and still fully determined by the seed.

The plan also emits the intersections and streets that roads are drawn on and that query routes walk,
so nothing is drawn diagonally through a building. Schema districts are now the bounding box of their
scattered members and are used only for the optional tint layer, which draws per-lot pads rather than
one contiguous rectangle.

Every property in the table below encodes evidence. Everything else in the scene is decoration seeded
from an object's stable id and carries no data claim; the in-app legend states this split verbatim.

| Encoded property | Evidence |
| --- | --- |
| Building footprint | log₂ of exact reserved 8-KiB pages |
| Building height | log₂ of exact used 8-KiB pages (zero used pages is zero height) |
| Solid amber roof-cap height | Query Store CPU measured for that object alone |
| Outlined amber roof-cap height | Query Store CPU of queries that also named other objects |
| Index annex width | direct DMV operations on that index |
| Road width | executions of query families naming both endpoints |
| Road colour | captured wait share, graded low/medium/high, upgraded only by a resolved live lock |
| Route line pattern | co-reference confidence (confirmed / probable / unknown) |
| Wait-lane width | captured Query Store wait milliseconds from one building to one facility |
| Wait-lane colour | which facility the lane ends at |
| Wait-lane pattern | attribution confidence of the contributing query families |

Building *archetype* (house, rowhouse, midrise, tower, skyscraper, civic hall, vacant parcel) is
chosen from exact reserved-page thresholds compared as `BigInt`, because page counts are lossless
base-10 strings that can exceed `Number.MAX_SAFE_INTEGER`. The archetype selects style only; the
measured footprint and height are unchanged by it. Unknown size yields a fenced wireframe parcel.

Colour and confidence deliberately occupy independent channels: once colour carries congestion,
confidence moves to line pattern, so neither dimension can be mistaken for the other.

CPU, memory, storage, tempdb, log, and lock evidence from `/api/v1/live` are placed as six civic
facilities scattered across the grid (`web/src/cityInfrastructure.ts`). Each facility's architecture
is fixed decoration so its location stays learnable with no evidence at all; only the *height* of the
measured units inside it varies, interpolated between a documented floor and ceiling. A subsystem
that could not be sampled renders as a wireframe with its reason and claims nothing.

#### Map view and city view

The same object graph is drawn two ways, switched by one toggle (`web/src/mapStyle.ts`). There is one
scene, one raycaster, and one set of controls in both modes — the mode changes appearance, never
content, so anything selectable in 3D is selectable on the flat map.

| | Map view | City view |
| --- | --- | --- |
| Camera | narrowed to a 13° field of view with the polar angle locked flat, which is parallel projection for practical purposes | oblique perspective, free orbit |
| Lighting | a single white ambient light, so materials render as their flat base colour | hemisphere, key, and fill lights |
| Massing | buildings collapse to footprint plates — height is a claim the 3D view makes, not this one | full height |
| Roads | white fill over a grey casing, drawn from the sidewalk strips the lattice already had | asphalt with kerbs |
| Facilities | teardrop POI pins | full facility geometry |

Road colour survives the switch in both directions, because congestion colour is measured evidence
rather than styling. Only the drawing style changes.

#### Incident pins

`web/src/cityIncidents.ts` projects a live snapshot into map pins: a blocked waiter, or a session
caught in a cycle in the current wait graph, anchored to the building whose lock it is waiting on.
`IncidentPopup.tsx` draws the callout as HTML over the canvas so the text is real text — selectable,
screen-reader reachable, legible at any zoom.

The projection follows the same evidence rule as everything else, and the distinctions are load-bearing:

- A snapshot that never carried a `lockResource` field means the probe did not run. That is reported
  as "not observed", never as "no blocking".
- A lock that resolves to a real object outside the loaded bounded page is **counted** as an off-map
  incident rather than pinned to the nearest available lot.
- A lock that names no object at all — a page lock, a database lock — is listed with the parser's own
  reason rather than guessed onto a building.
- A cycle in the *current* wait graph is reported as exactly that. SQL Server resolves real deadlocks
  before they can be sampled in `sys.dm_exec_requests`, so the popup says what was measured.

#### Waits as traffic to infrastructure

Roads answer "which objects are named together". **Wait lanes** answer a different question — "where
did the time go" — so they are a separate layer (`web/src/cityFacilityTraffic.ts`), toggled
separately. Query Store `wait_category_desc` totals, already collected by the Query Store probes,
are carried on `DatabaseCityQueryFamilyV1.WaitMillisecondsByCategory` and routed to the facility
that owns the resource: CPU and Worker Thread to the Scheduler Yard, Memory to the Memory Grant
Office, Buffer IO and Other Disk IO to the Storage Depot, Tran Log IO and Log Rate Governor to the
Log Yard, Lock to the Lock Authority.

Three refusals keep the layer honest, and each is enforced by a test:

1. A family naming more than one object is **never divided** between them. Query Store reports one
   wait total per query, not per object, so splitting it would fabricate a per-building number. Those
   milliseconds are reported whole in a separate list.
2. A category with no counterpart in this city — Parallelism, Network IO, Compilation, Idle,
   Preemptive — is **never folded into the CPU yard**. It is listed with the reason it has no
   destination.
3. `Buffer Latch` is **not** routed to tempdb Works, even though tempdb allocation contention is its
   most famous cause, because the category does not name a database. tempdb therefore has no Query
   Store lane at all.

A building with no lane is not idle. `sys.query_store_wait_stats` does not exist before SQL Server
2017 (14.x), so an absent breakdown is stated in prose rather than drawn as a zero-width lane, and
an unrecognised category is reported verbatim rather than routed to a guessed facility. Lane width
saturates at a documented ceiling; past it the lane says its width is a floor and defers to the
exact figure in the evidence table.

The backend returns bounded object pages, a fixed top-query-family set, and an exact `other workload`
aggregate. The browser never receives all 100,000 query families.

Routes indicate co-reference or cross-database evidence. Solid, dashed, and dotted styles mean
confirmed, probable, and unknown; they do not imply row direction or row flow.

#### Query plan routes

Selecting a Query Store plan draws a GPS-style route through the city (`web/src/cityRoute.ts`). The
normalized showplan's operator tree is walked in post-order, and each operator becomes a stop:

1. a resolvable object reference becomes that building;
2. otherwise a memory-consuming operator stops at the Memory Grant Office;
3. otherwise a tempdb-spilling operator stops at tempdb Works;
4. otherwise a non-zero `EstimatedIoCost` stops at the Storage Depot;
5. otherwise the operator stops at the CPU Scheduler Yard.

Consecutive stops are joined by a shortest path over the street graph, so the route follows roads.
An object reference that names something outside the loaded bounded page becomes an explicit off-map
stop with a reason; it is never silently dropped, and the panel reports "N of M stops placed on this
map". The route is a compiled plan shape and carries the plan's `runtimeOverlayCaveat` verbatim: it
is never actual operator progress.

The camera is a full orbit/pan/zoom control with keyboard equivalents (arrows pan, `+`/`-` zoom,
`[`/`]` rotate, `Home` resets). Fit-to-bounds runs on first load and on an explicit reset only, so
filtering or a live tick never yanks the viewpoint. The full evidence tables remain below the map as
the text-first, non-WebGL equivalent.

## Evidence layers

These are collection layers, not screens. Each one is collected in full by the backend and surfaces
on the map: Query Store aggregates become roads, wait lanes, and address-book metrics; live samples
become road congestion and incident pins.

> [!NOTE]
> Findings are still computed and still served from `/api/v1/findings`, but the UI no longer draws
> them. SQLSimCity is a map, not an assessment tool. Removing the backend end-to-end is a clean
> follow-up rather than part of this change.

### Query Store aggregates

Query families preserve physical query/context splits, regular/aborted/exception execution types,
replica groups, reset epochs, plan forcing state, and PSP/OPPO relationships where supported.
Dispatcher runtime is excluded while variant runtime remains attached to its plan.

Raw SQL text and Showplan XML are on-demand protected payloads only. The normalized Showplan parser
prohibits DTDs/resolvers and applies depth, node, text, and character limits. Query Store supplies
compiled plans and query-level aggregates, never actual operator progress.

### Live sampling

The live sampler exposes current requests and sessions, every visible task-level wait, MARS and
parallel blocking edges, root blockers, memory grants, tempdb, file I/O deltas, scheduler pressure,
and log-space gauges. Every snapshot includes source, collection, and freshness timestamps plus
missed/skipped-cycle counts.

The `-2`, `-3`, `-4`, and `-5` blocking-session sentinels remain explicit. `-5` is diagnostic and is
not counted as a blocker incident by itself.

Lock resources are parsed from the engine's verbatim `wait_resource` / `resource_description` text by
`LockResourceParser`, which resolves only what the text actually states. `OBJECT:` and `TAB:` carry an
object id outright. `KEY:`, `HOBT:`, and `ALLOCUNIT:` carry only a `hobt_id` and are reported
`RequiresLookup` until the bounded `sessions.lock_resource_objects` probe resolves them through
`sys.partitions` in the owning database. `PAGE:` and `RID:` name a physical location whose object
would need `sys.dm_db_page_info` or an allocation scan, so they are reported `Unresolvable` with that
reason and are never guessed. `DATABASE`, `FILE`, `EXTENT`, `APPLICATION`, and `METADATA` locks are
reported `NotObjectScoped`. An unrecognised prefix stays `Unrecognized` rather than being coerced.

`LockResource` is optional throughout the live contracts, so its absence means the probe did not run,
not that a request holds no lock. Parsing runs on every sampled request and waiting task in both
connected and fixture mode, because it is pure and costs nothing. The hobt-resolving lookup step is a
separate, bounded call: the fixture declares a sanitized resolution table so the resolved path is
demonstrable offline, and a connected collector that has not yet issued the probe simply reports
`RequiresLookup` and names the probe that would resolve it. The city consumes the result twice — to
upgrade a road to red congestion, and to place an incident pin — and only where a resolved lock names
one of the loaded objects.

### Findings

Findings are deterministic observations with measured impact, confidence, evidence links, caveats,
alternate explanations, next checks, and read-only recommendations. Insufficient evidence produces
`NotEvaluated` or `InsufficientEvidence`, not a diagnosis.

Rules avoid folklore such as universal page-life-expectancy thresholds, treating every scan or
`CXPACKET` wait as bad, or assigning a query's total work to each operator/table.

They are computed and served, and no UI draws them.

## Acquisition modes

- **Fixture** is deterministic and opens no SQL or identity network connection.
- **Connected** runs the embedded, startup-validated, static read-only SQL probe catalog.
- **Archive** validates one mounted redacted observation archive before publishing any section and
  performs no SQL/identity network calls.
- **Edge** accepts signed, replay-protected generations from an outward-only connector and publishes
  only complete, target-isolated generations.

Archive and edge live evidence is static point-in-time evidence. The central service does not turn it
into a continuous trace.

## Scale and lifecycle

- Atlas summaries load before database-city or query detail.
- Query Store uses keyset pagination, chunked index pages, individually addressable/chunked detail,
  a final publication pointer, and 7-day detail plus 90-day hourly retention.
- Database-city layout is deterministic and independent of source row order.
- Live samplers, channels, publishers, edge spools, idempotency maps, and replay journals are bounded.
- three.js frame loops reuse objects and pools rather than allocating per frame.

The deterministic release gates cover 100 databases and 100,000 query families without committing a
giant fixture or loading that population into browser memory.

## API shape

Primary read-only groups:

```text
/api/v1/atlas
/api/v1/capabilities
/api/v1/database-city
/api/v1/query-store
/api/v1/live
/api/v1/findings
```

`/api/v1/edge/ingest` is the sole bounded POST route and exists only when edge ingestion is explicitly
enabled. All responses are same-origin, rate/body bounded, and carry evidence/status fields rather
than success-shaped empty values.
