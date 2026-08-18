# Changelog

All notable changes to SQLSimCity are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

SQLSimCity is independent software and is not affiliated with, sponsored by, or
endorsed by Microsoft, Electronic Arts, Maxis, or the SimCity franchise. No
SimCity assets are included.

## [Unreleased]

First MVP release candidate. There is no tagged release yet.

### Added

- **The database city is now a city.** The 3D view was rebuilt from unlabelled boxes on a rigid grid
  into a navigable street-grid town, with every encoded dimension documented and everything else
  declared as decoration:
  - **Real buildings.** Objects are placed on lots along block frontages by `web/src/cityPlan.ts` and
    given procedural per-archetype geometry by `web/src/cityBuildings.ts` — houses with pitched roofs
    and doors, rowhouses, setback midrises, and towers/skyscrapers with window grids and crowns.
    The archetype is chosen from exact reserved-page thresholds compared as `BigInt`, so a small table
    is a house and a multi-gigabyte table is a skyscraper for a measured reason. Archetype selects
    style only; measured footprint (log₂ reserved pages) and height (log₂ used pages) are unchanged.
    Unknown size stays a fenced wireframe parcel that claims no quantity.
  - **Orbit, pan, and zoom.** The camera is a full `OrbitControls` rig (left-drag orbit, right-drag
    pan, wheel zoom, damped, clamped above ground) with keyboard equivalents — arrows pan, `+`/`-`
    zoom, `[`/`]` rotate, `Home` resets — on a focusable, described canvas. Rendering is on-demand and
    respects `prefers-reduced-motion`. Fit-to-bounds now runs on first load and explicit reset only,
    so filtering or a live tick no longer yanks the viewpoint.
  - **Roads with GPS-style congestion.** Co-references render as flat road ribbons along the street
    graph instead of 1px diagonals through buildings. Road width maps the executions of query families
    naming both endpoints; road colour maps captured wait share graded green/amber/red, upgraded to red
    only where a resolved live lock names that object. Confidence moved to line pattern so colour and
    confidence stay independently readable, and unknown grades stay grey and claim nothing.
  - **Query plan routes.** A plan finder searches query families and plans; picking one draws a
    numbered route through the city (`web/src/cityRoute.ts`) with a turn-by-turn panel. Operators walk
    the tree in post-order and stop at their object's building, the Memory Grant Office, tempdb Works,
    the Storage Depot, or the CPU Scheduler Yard. An object outside the loaded page becomes an explicit
    off-map stop with a reason rather than being dropped, and the panel reports "N of M stops placed on
    this map". The plan's `runtimeOverlayCaveat` is carried verbatim — it is a compiled plan shape,
    never actual operator progress.
  - **CPU, memory, and storage as places.** Six civic facilities (`web/src/cityInfrastructure.ts`,
    `web/src/cityFacilityShells.ts`) render live evidence as architecture: a Scheduler Yard, Memory
    Grant Office, Storage & I/O Depot, tempdb Works, Log Yard, and Lock Authority. Facility shells are
    fixed decoration so a location stays learnable with no evidence; only measured unit heights vary.
    An unsampled subsystem renders as a wireframe with its reason.
  - **Full-bleed map with a floating HUD** — object/plan finders, layer toggles, an encoded-vs-decoration
    legend, compass and camera controls, live-feed pill, and a slide-over for the selected building or
    route. The existing evidence tables are preserved verbatim in a collapsible section below the map as
    the text-first, non-WebGL equivalent.
- **Lock resource resolution.** `LockResourceParser` parses the engine's verbatim `wait_resource` /
  `resource_description` text into a new optional `LockResourceV1` on `LiveRequestV1` and
  `WaitingTaskV1`. `OBJECT:`/`TAB:` resolve with no lookup; `KEY:`/`HOBT:`/`ALLOCUNIT:` carry only a
  `hobt_id` and are reported `RequiresLookup` until the new bounded `sessions.lock_resource_objects`
  probe resolves them through `sys.partitions` in the owning database; `PAGE:`/`RID:` are reported
  `Unresolvable` because mapping a physical location to an object needs `sys.dm_db_page_info` or an
  allocation scan, and are never guessed; `DATABASE`/`FILE`/`EXTENT`/`APPLICATION`/`METADATA` are
  reported `NotObjectScoped`; an unrecognised prefix stays `Unrecognized`. The field is optional
  throughout, so its absence means the probe did not run, not that no lock is held. The live-cases
  fixture declares a sanitized resolution table so the resolved path is demonstrable offline.

- **Single connection string configuration** for every connected surface. One ordinary ADO.NET
  connection string can now stand in for the ~15 individual connection settings plus a mounted
  password file: `ConnectionStrings:SqlSimCity` (settable as `ConnectionStrings__SqlSimCity`),
  `SQLSIMCITY_CONNECTION_STRING`, or a section-scoped `Atlas:ConnectionString` /
  `LiveIncidents:Connection:ConnectionString`, plus `SQLSIMCITY_EDGE_SQL_CONNECTION_STRING` for the
  edge connector. Supplying one turns connected Atlas and live incidents on by itself, so no mode
  setting is also required; with none configured, fixtures remain the default. The string is parsed
  into exactly the same immutable, fully validated `ConnectionProfile` the field-by-field path
  produces and is then discarded, so every existing guarantee holds — the password is delivered as a
  `SqlCredential` and never concatenated into a connection string, log, or exception;
  `ApplicationIntent=ReadOnly` and the `SQLSimCity` application name are still forced; `Encrypt=false`
  and infinite timeouts are still rejected; and only SQL login, Kerberos, and managed identity are
  accepted (workload identity and service principal need a tenant id a connection string cannot
  carry, and `Active Directory Default` remains banned). The engine platform is inferred from the host
  name (`*.database.windows.net` means Azure SQL Database), Azure SQL `KnownDatabases` defaults to the
  connection string's own database, and explicit configuration always wins over both. This is a
  documented convenience, not the hardened path: an inline password is readable from the process
  environment and cannot be rotated without a restart, so both the API and the connector log a
  warning at startup when one is in use, and mounted secret files remain the production default.
  Neither surface will combine a connection string with any field it already covers, rather than
  letting one silently win — a real safeguard, since `ConnectionStrings__SqlSimCity` is a name some
  hosting platforms inject automatically and would otherwise silently downgrade a hardened profile's
  authentication, TLS trust, and mounted password file. `Max Pool Size` defaults to 20 (the field
  path's ceiling) rather than SqlClient's 100, and `admin:`, `np:`, and `lpc:` data-source prefixes
  are rejected rather than stripped, since the profile is always rebuilt as TCP. The connector's
  prohibition on plaintext secret environment variables is unchanged.
  See `SECURITY.md`, `docs/connected-mode.md`, and `docs/edge-connector.md`.
- Outward-only **edge connector** for monitoring SQL Servers the central container cannot reach
  (`src/SqlSimCity.Edge`, `src/SqlSimCity.Edge.Connector`, `Dockerfile.connector`,
  `compose.edge.yaml`, `docs/edge-connector.md`). A connector near SQL Server connects outward over
  HTTPS, forwards the same source-neutral observations in a versioned envelope
  (`ObservationEnvelopeV1`), signs each request with HMAC-SHA-256 (constant-time verification, bounded
  clock skew, connector allowlist, key rotation, and durable replay-nonce protection), and buffers a
  bounded AES-256-GCM-encrypted spool when the central server is unavailable. Central ingestion is
  opt-in and disabled by default (`Acquisition:Mode=Edge` plus `EdgeIngestion:Enabled`); when enabled it adds one bounded
  `POST /api/v1/edge/ingest` plus read-only `GET /api/v1/edge/status`/`/targets` endpoints, validates
  schema/digest/signature/sequence/epoch/standard-payload contracts with atomic publication, bounded
  idempotency indexes, a dedicated per-client edge rate limit, and compression-bomb guards. One complete,
  allowlisted target generation projects through the existing Atlas, capabilities, Query Store,
  database-city, live, and findings APIs; partial next generations remain invisible. The UI shows a
  compact Edge source/status/target panel and labels live evidence as a static point-in-time sample.
  The connector supports fixture and opt-in connected sources; connected mode composes the production
  SQL collectors over one validated file-secret profile, bounded volatile Query Store storage, and
  text-disabled live probes. No live SQL target was validated; connected tests use fake executors.
- Fixture-mode and opt-in read-only connected server **atlas** (`/api/v1/atlas`,
  `/api/v1/atlas/status`) with a three.js scene backed by a keyboard- and
  screen-reader-accessible database evidence table.
- **Database-city semantic zoom** (`/api/v1/database-city`, `/api/v1/database-city/{databaseId}`)
  with exact page geometry, separated direct-DMV and Query-Store-attributed heat,
  and confidence-graded co-reference routes.
- **Live-incident** point-in-time DMV sampling (`/api/v1/live`) and a
  `/hubs/current-snapshot` SignalR hub, with explicit freshness/staleness and
  never-numeric-zero unavailable states.
- Encrypted, paged **Query Store history** (`/api/v1/query-store/*`) with plan
  history, a hardened Showplan parser (DTD/resolver prohibited, bounded), and
  structural plan comparison from sanitized fixtures.
- Evidence-backed **findings** engine and read-only API (`/api/v1/findings/*`)
  with redacted export.
- Source-neutral SQL Server connection library with SQL/Kerberos/Microsoft Entra
  authentication and file-referenced secrets.
- Optional AES-256-GCM encrypted SQLite record store (disabled by default) with
  fail-closed initialization, key rotation, and bounded retention/pruning.
- Versioned static, read-only SQL probe catalog (`sql/manifest.json` + `sql/probes/*.sql`).
- HTTP hardening: `AllowedHosts` pinning, strict CSP and security headers,
  64-KiB request-body bounds, and per-client API rate limiting that excludes the
  long-lived SignalR hub.
- Container hardening (non-root, dropped capabilities, read-only rootfs,
  `no-new-privileges`, loopback binding), locked dependencies, CI/release
  workflows with SBOM and provenance attestation, Docker fixture smoke, and
  backup/restore tooling with operations documentation.

### Changed

- Frontend build is code-split: the three.js atlas/city viewports and the Query
  Store, Live, and Findings tabs load as lazy chunks, and three.js is isolated
  into its own vendor chunk. The initial-path bundle drops from ~848 KiB to
  ~220 KiB and three.js is no longer on the first-paint critical path.
- The Query Store `database_workload_summary` probes now bound the runtime-stats
  interval join by overlap (`end_time > @StartTime AND start_time < @EndTime`),
  matching `runtime_stats_summary` and `wait_stats_summary`, so the atlas
  database-wide totals reconcile with the per-plan drill-down over the same window.

### Fixed

- Rejected edge batches no longer create phantom targets, reserve ownership, mutate partial groups,
  advance generation state, or consume idempotency entries; both accepted-batch indexes now evict
  coherently at a deterministic bound.
- The local Edge Compose example now uses a genuinely loopback HTTP connection by sharing the central
  service network namespace; production delivery remains HTTPS-only.
- Both runtime images now declare the repository's Apache-2.0 license and contain `LICENSE`/`NOTICE`.
- A rejected lazy-chunk import no longer unmounts the application: every lazy
  surface is wrapped in an error boundary that renders a focused, announced
  alert with a reload action.
- Connected live-incident sampling no longer fails on every cycle. The transaction-log probe
  emits exact `total_log_size_bytes`/`used_log_space_bytes`, but the live-incident executor read
  `total_log_size_mb`/`used_log_space_mb`, so every sample threw `IndexOutOfRangeException` against
  a real server. It now reads the byte columns and converts to the megabytes the contract, findings
  rule, and UI all expect. This was invisible to the unit tests, which substitute a fake probe
  executor for the real `SqlDataReader` path, so a corpus-wide guard now asserts that every column
  the Atlas and live-incident executors read by name is actually emitted somewhere in the probe SQL.

### Security

- A persistent, color-independent trusted-network / no-built-in-login notice is
  now shown on every analysis view, including on mobile, reinforcing the
  documented `AllowedHosts` and reverse-proxy guidance.

### Known limitations

- **Live SQL Server validation is partial.** Connected Atlas collection and live-incident sampling
  have now been exercised end to end against a real local SQL Server (Kerberos/integrated auth),
  which is what surfaced the transaction-log column defect above. No Azure SQL Database or Managed
  Instance target was available, so platform-specific behavior on those, and every Entra
  authentication strategy, remains exercised only against fakes and deterministic fixtures.
- GHCR image publication, SBOM, and provenance attestation are defined in the
  release workflow but are not executed as part of this candidate; their outputs
  are unverified until a tagged release runs.
- Behind a reverse proxy, forwarded-header processing is intentionally disabled,
  so API rate-limit partitioning collapses all clients into one bucket. This is
  correct for the documented loopback/trusted-network model.
