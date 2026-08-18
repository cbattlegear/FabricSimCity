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

### Server atlas

The atlas shows up to 100 databases. Known allocated size controls footprint through a documented
logarithmic mapping; unknown size uses nonquantitative geometry. Live concurrency, historical Query
Store load, capacity, and data quality remain separate dimensions.

### Database city

Schemas are stable neighborhoods. Tables and indexed views are buildings sized by exact 8-KiB page
counts. Indexes are attached structures on their parent object. Direct index DMV activity and
Query Store-attributed exposure use different evidence and visual styles.

The city is laid out as a real street grid rather than a bar chart. `web/src/cityPlan.ts` packs each
schema district into blocks of lots on a uniform lattice, derived strictly from the backend's stable
`neighborhoodOrdinal` / `objectOrdinal`, so layout is deterministic and independent of source row
order. The plan also emits the intersections and streets that roads are drawn on and that query
routes walk, so nothing is drawn diagonally through a building. A civic district is always allocated
last, which keeps schema districts from shifting when infrastructure appears.

Exactly seven properties encode evidence. Everything else in the scene is decoration seeded from an
object's stable id and carries no data claim; the in-app legend states this split verbatim.

| Encoded property | Evidence |
| --- | --- |
| Building footprint | log₂ of exact reserved 8-KiB pages |
| Building height | log₂ of exact used 8-KiB pages (zero used pages is zero height) |
| Amber roof-cap height | attributed Query Store CPU |
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
facilities in the civic district (`web/src/cityInfrastructure.ts`). Each facility's architecture is
fixed decoration so its location stays learnable with no evidence at all; only the *height* of the
measured units inside it varies, interpolated between a documented floor and ceiling. A subsystem
that could not be sampled renders as a wireframe with its reason and claims nothing.

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

### Query Store history

Query families preserve physical query/context splits, regular/aborted/exception execution types,
replica groups, reset epochs, plan forcing state, and PSP/OPPO relationships where supported.
Dispatcher runtime is excluded while variant runtime remains attached to its plan.

Raw SQL text and Showplan XML are on-demand protected payloads only. The normalized Showplan parser
prohibits DTDs/resolvers and applies depth, node, text, and character limits. Query Store supplies
compiled plans and query-level aggregates, never actual operator progress.

### Live incidents

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
`RequiresLookup` and names the probe that would resolve it. The city consumes the result to upgrade a
road to red congestion, and only where a resolved lock names one of the loaded objects.

### Findings

Findings are deterministic observations with measured impact, confidence, evidence links, caveats,
alternate explanations, next checks, and read-only recommendations. Insufficient evidence produces
`NotEvaluated` or `InsufficientEvidence`, not a diagnosis.

Rules avoid folklore such as universal page-life-expectancy thresholds, treating every scan or
`CXPACKET` wait as bad, or assigning a query's total work to each operator/table.

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
- Query Store uses keyset pagination, encrypted index pages, individually addressable/chunked detail,
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
