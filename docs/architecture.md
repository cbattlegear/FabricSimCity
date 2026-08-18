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
src/SqlSimCity.Storage    AES-256-GCM protected SQLite records and retention
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

The backend returns bounded object pages, a fixed top-query-family set, and an exact `other workload`
aggregate. The browser never receives all 100,000 query families.

Routes indicate co-reference or cross-database evidence. Solid, dashed, and dotted styles mean
confirmed, probable, and unknown; they do not imply row direction or row flow.

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
