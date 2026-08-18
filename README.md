# SQLSimCity

SQLSimCity is a self-hosted, evidence-first visual atlas for SQL Server performance data. It starts in deterministic **fixture mode** and can be explicitly configured for read-only connected collection.

The fixture is not a benchmark or a description of a real server. SQLSimCity is independent software and is not affiliated with, sponsored by, or endorsed by Microsoft, Electronic Arts, Maxis, the SimCity franchise, or the PGSimCity project. No SimCity assets are included.

## What works

- ASP.NET Core .NET 10 serves `/api/v1/atlas`, `/api/v1/atlas/status`, `/api/v1/capabilities`, `/api/v1/live`, health endpoints, a `/hubs/current-snapshot` SignalR hub, and the production Vite bundle.
- Eight deterministic databases cover known, zero, and unknown allocation; live fresh, stale, disconnected, permission-denied, and unknown states; and varied Query Store capability and health.
- React owns selection, detail, tables, and request state. `AtlasScene` owns three.js objects and animation imperatively; no frame updates pass through React state.
- Database footprint follows the documented allocated-KiB mapping. Unknown allocation is marked with an × and never receives a quantitative footprint.
- A keyboard and screen-reader-friendly table contains the same records. Exact bytes and Query Store integer aggregates cross the wire as nonnegative decimal strings and are formatted with `BigInt`, avoiding JavaScript precision loss.
- The Query Store history tab and read-only `/api/v1/query-store/*` endpoints expose paged query families, physical query/context splits, execution-type and replica-separated runtime, plan history, normalized compiled-plan trees, and structural plan comparison from sanitized fixtures.

## Accuracy boundary

The contract keeps three evidence classes separate:

1. **Query Store aggregate history** describes a time window. It is not current execution activity. Duration is microseconds and logical reads are counts of 8-KiB pages.
2. **Live DMV samples** are point-in-time observations with explicit observation and freshness timestamps. Missing, stale, disconnected, and permission-denied values remain unavailable, never numeric zero. The live-incident sampler below is this class of evidence, taken on a bounded cadence, not a continuous trace: a request that starts and finishes between two samples never appears, and blocking that resolves between samples is invisible to it. See [Live incident sampling](#live-incident-sampling) for exactly what a cadence-based sample can and cannot show, and how it differs from Query Store's retained history.
3. **Topology is inferred evidence.** Confirmed, probable, and unknown confidence carry rationale; the atlas is not claiming a complete dependency graph.

There is no opaque health score. Query Store capability, health, data status, and reasons remain separate. Connected mode executes only validated static SQL embedded in the application. It does not fetch plan XML or fabricate live traffic. When the live sampler and atlas target IDs match, the atlas projects only the latest available request sample; otherwise activity remains explicitly unavailable.

## Architecture

```text
src/SqlSimCity.Contracts  versioned transport records and evidence enums
src/SqlSimCity.Domain     fixture source and API source seam
src/SqlSimCity.Storage    optional AES-256-GCM encrypted embedded record store
src/SqlSimCity.SqlServer  source-neutral SQL Server connection/authentication library
src/SqlSimCity.Collection SQL probe catalog, negotiation, atlas collector, live-incident sampler, and refresh coordination
src/SqlSimCity.Api        same-origin HTTP API, SignalR seam, static hosting
sql/                      versioned probe catalog (manifest.json + probes/*.sql)
fixtures/                 deterministic JSON fixtures for the atlas, capabilities, and live-incident APIs
web/                      strict TypeScript React shell and three.js scene
 tests/                    serialization, fixture, endpoint, storage, connection, catalog, negotiation, and live-incident tests
```

The API is the source of truth. The frontend fetches `/api/v1/atlas`; fixture records are not duplicated in TypeScript.

## Query Store history

Fixture mode includes deterministic, sanitized history covering active-interval duplicate aggregation, fractional count-weighted averages, regular/aborted/exception executions, replica groups, context splits, restricted text, force failures, PSP and SQL Server 2025 OPPO dispatcher/variant relationships. Dispatcher runtime is excluded while variant runtime retains its plan and rolls into the family.

All list/detail routes are GET-only and return versioned contracts with decimal-string integers, explicit source/freshness/caveats, and opaque continuation tokens. Summary probes exclude SQL text and Showplan XML. The two single-record payload probes are on-demand only; `ProtectedQueryStoreRepository` writes those payloads only through `IProtectedRecordStore`. The Showplan parser prohibits DTDs and resolvers, enforces character/depth/node/text limits and cancellation, tolerates namespace version changes, and emits a normalized structural graph. Query Store supplies aggregate query runtime, not actual operator progress or actual operator metrics.

Connected atlas mode never substitutes fixture Query Store history. Set `QueryStoreHistory:Mode=Connected` together with `Atlas:Mode=Connected` and protected storage to opt in. The collector uses static keyset probes, per-database overlap watermarks, bounded pages/concurrency, cancellation, partial failures, reset epochs, and per-bucket active-interval replacement. It publishes encrypted, bounded snapshot chunks through one final encrypted pointer, so a failed cycle or process crash leaves the prior complete snapshot current. `Disabled` remains an explicit unavailable state; fixture mode remains the default.

## Fixture and connected collection

`Atlas:Mode` defaults to `Fixture`; this mode opens no network connection and remains deterministic. Set it to `Connected` only with a validated `Atlas:Connection` profile. Connected collection:

- discovers at most 100 visible databases from `master` on SQL Server and Managed Instance;
- requires `Atlas:KnownDatabases` for Azure SQL Database, where sibling databases cannot be inferred from one database connection;
- records exact data/log allocation and use, bounded Query Store totals, cumulative file I/O plus reset epoch, and per-database partial failures;
- limits database concurrency to 4 by default (hard maximum 16), uses the profile command timeout, never overlaps refresh cycles, and backs off after target-level connection failures.

Example non-secret settings are in `compose.yaml`. Authentication supports the explicit strategies in `SqlSimCity.SqlServer`. Passwords, certificates, and client secrets are file references under `Atlas:SecretsDirectory` (`/run/secrets` by default), never configuration values. For SQL Server 2016–2019 grant the collector login `VIEW SERVER STATE` and `VIEW DATABASE STATE` in each collected database; SQL Server 2022+ uses `VIEW SERVER PERFORMANCE STATE` and `VIEW DATABASE PERFORMANCE STATE`. Also grant `CONNECT` to each database and preserve the default `VIEW ANY DATABASE` only when server discovery is desired. Azure SQL Database should use the smallest documented database-scoped permission/role that exposes the required DMVs for its service tier. SQLSimCity never executes grants.

## Development

Requires .NET SDK 10, Node.js 24 (Node 22.12+ is also supported by the frontend toolchain), and npm.

Terminal 1:

```powershell
dotnet run --project src\SqlSimCity.Api --urls http://localhost:5080
```

Terminal 2:

```powershell
Set-Location web
npm install
npm run dev
```

Vite proxies API and hub paths to port 5080. Production is a single ASP.NET process:

```powershell
Set-Location web
npm ci
npm run build
Set-Location ..
dotnet publish src\SqlSimCity.Api -c Release -o artifacts\publish
dotnet C:\path\to\artifacts\publish\SqlSimCity.Api.dll --urls http://127.0.0.1:8080
```

## Container

```powershell
docker compose up --build
```

Compose publishes only `127.0.0.1:8080`, runs as the .NET image's non-root user, drops all Linux capabilities, enables `no-new-privileges`, uses a read-only root filesystem, mounts `/tmp` as tmpfs, and reserves named `/data`. The fixture slice writes nothing to `/data`: `SqlSimCity.Storage` (see below) is disabled by default and only touches `/data` when explicitly enabled with a key.

The image targets Linux containers on x86-64 and ARM64 where the selected official .NET and Node images are available. Current Chromium, Firefox, and Safari with WebGL2 are the browser targets; the complete text/table view remains usable when the 3D viewport cannot render.

## Protected storage

`SqlSimCity.Storage` is the source-neutral encrypted embedded record store used by opt-in connected Query Store history. It ships **disabled by default** and is unused by the fixture path. When enabled it:

- encrypts every payload with AES-256-GCM inside a versioned envelope (format version, key version, nonce, tag, ciphertext) before any byte reaches SQLite, with record kind, opaque record ID, and key version bound as authenticated associated data so ciphertext cannot be swapped between records;
- loads its key ring only from an explicitly configured file (see [SECURITY.md](SECURITY.md) for the exact JSON format, key rotation, and backup guidance) and never logs key material;
- fails closed: a missing/wrong key, corrupt or tampered envelope, failed canary check, or migration error prevents the application from becoming ready rather than silently degrading to an unencrypted or partially working store;
- exposes only opaque record IDs, record kind, captured timestamp, and resolution (`Detail`/`HourlyRollup`) as plaintext metadata — payload bytes are always encrypted;
- prunes at most `ProtectedStorage:Retention:PruneBatchSize` expired records per invocation (call again to drain more), under a default retention of 7 days for `Detail` and 90 days for `HourlyRollup`; the batch size is bounded from 1 through 500.
- retains published Query Store snapshot pointers, indexes, families, and chunks as `HourlyRollup` records so the readable 90-day history survives a collector outage; raw SQL and raw Showplan XML remain 7-day `Detail` records.
- restricts the database filename to a simple filename, record-kind metadata to 128 characters (maximum 1,024), and plaintext payloads to 1 MiB (maximum 16 MiB); `MaxRecordKindLength` and `MaxPayloadBytes` are explicit protected-storage configuration limits.
- chunks oversized normalized Query Store family and plan records below `MaxPayloadBytes`. Raw Showplan XML above that limit is deliberately not cached; its sanitized normalized plan remains available from bounded encrypted chunks.

Enable it with `ProtectedStorage:Enabled=true`, `ProtectedStorage:DataDirectory`, and `ProtectedStorage:KeyFilePath` (see `compose.yaml` for a commented example). Connected Query Store history refuses to start without it. Raw SQL and Showplan XML enter only protected detail records; normalized facts, watermarks, reset epochs, and atomically published indexes are protected as well. The background collector invokes bounded retention pruning after successful publication.

## SQL Server connection and authentication

`SqlSimCity.SqlServer` is the source-neutral connection and authentication library used by explicitly enabled connected collection. Fixture mode does not instantiate it or open a connection. It ships:

- an immutable, fully validated `ConnectionProfile` (DNS/FQDN or IPv4 host, optional named instance or explicit port — never both, initial database, bounded connect/command timeouts and pool bounds, a fixed `SQLSimCity` application name, an explicit `EncryptionPolicy`, and a per-profile `TrustServerCertificate` opt-in that is never inherited or global; IPv6 literals are rejected until their SqlClient TCP syntax is implemented);
- a closed authentication-strategy hierarchy with **no fallback between strategies**: SQL login (username plus a secret-file password reference), a Linux Kerberos/SSPI service identity, and four explicit Microsoft Entra ID strategies (`ManagedIdentity`, `WorkloadIdentity`, `ServicePrincipalCertificate`, `ServicePrincipalSecret`) — **never `DefaultAzureCredential` or any credential chain**, enforced by a static test;
- an `ISecretFileProvider` that resolves only simple, validated file-name references under one configured secrets directory (default `/run/secrets`), enforces a size limit, and fails closed (`SecretResolutionException`) on anything missing, oversized, or invalid — never logging secret content;
- an `ISqlConnectionFactory` that builds every connection through `SqlConnectionStringBuilder` only (a password or Entra token is never concatenated into the connection string); retains SQL-login credentials, and Entra credentials plus their `AccessTokenCallback` delegate, for the lifetime of their pool — reusing the exact same callback delegate per stable security context, since `AccessTokenCallback` is itself part of SqlClient's connection pool key (see the [official documentation](https://learn.microsoft.com/sql/connect/ado-net/sql/azure-active-directory-authentication#using-accesstokencallback)) — and provides explicit per-profile invalidation after password, certificate, or client-secret rotation, clearing each credential's pool before releasing its material; and a secret-free `SafeConnectionSettings` DTO for authorized UI and protected storage. `SafeConnectionSettings` contains operationally sensitive target and identity metadata, so it must not be logged or exposed indiscriminately.

See [SECURITY.md](SECURITY.md) for the Kerberos keytab/SPN/DNS/clock-sync and Entra endpoint/IMDS deployment requirements.

## Capability negotiation

`SqlSimCity.Collection` contains capability negotiation and the source-neutral atlas collector. Both fixture/fake and real executors use the same typed seams.

- **Versioned, embedded probe catalog.** `sql/manifest.json` and every `sql/probes/**/*.sql`
  file are embedded resources in `SqlSimCity.Collection.dll`, so a published container image
  cannot start with a missing or partial catalog. `ProbeCatalog.Load` validates the manifest
  version, unique probe IDs and files, safe relative paths (no `..`, no absolute or
  drive-rooted paths, forward slashes only), that every referenced file actually exists,
  that declared parameters match exactly what each `.sql` file references, and that every
  `connectionScope`/`cadenceClass`/`relativeCost`/`versionVariantOf` value is one this
  loader documents. It also strips comments and rejects mutating statements, dynamic SQL,
  `SELECT ... INTO`, unsafe top-level shapes, and undocumented `SET` options. Program startup
  eagerly loads this catalog in fixture mode too; any inconsistency throws
  `ProbeCatalogException` before the host is built or can become ready. The JS manifest guard
  (`npm test`) remains an independent CI check; the .NET loader never shells out to Node.
- **Canonical capability contracts** (`SqlSimCity.Contracts.V1`) give every fact -- engine
  platform, product version, edition, database-discovery evidence, per-database compatibility level, Query Store
  desired/actual state, read-only reason, capture mode, size, server-vs-database
  visibility, waits, live sessions, plans/text, Parameter Sensitive Plan (PSP), Optional
  Parameter Plan Optimization (OPPO), readable-secondary Query Store, Azure resource
  metrics, and a source timestamp -- one of six explicit states: `Supported`,
  `Unsupported`, `PermissionDenied`, `Unavailable`, `NotProbed`, `Preview`. A value that
  could not be determined is always one of these states, never a false Boolean or a
  numeric zero standing in for "unknown."
- **Source-neutral negotiation.** `ICapabilityNegotiator`/`IProbeExecutor` let the full
  gating algorithm (`CapabilityNegotiator`) be unit-tested with no SQL Server at all,
  against either a `FixtureProbeExecutor` (backed by `fixtures/v1/target-capabilities.json`
  and `fixtures/v1/database-query-store.json`) or a real `SqlClientProbeExecutor`
  (`ISqlConnectionFactory`, opened connections, static catalog SQL only, named parameters,
  command timeout from the connection profile, cancellation, no mutation).
- **Version-and-metadata-gated feature selection.** Major engine version only narrows
  which probe candidates are even safe to attempt; the actual verdict always requires
  runtime confirmation from `capability.query_store_plan_metadata` plus the database's own
  compatibility level. PSP requires compatibility level 160+ and confirmed plan-variant
  metadata; OPPO requires compatibility level 170+, a supported platform, and the same
  metadata confirmation; readable-secondary Query Store stays `Preview` and is
  platform-policy dependent. Azure SQL Database's database IDs are never treated as
  server-global, and its server-visibility state is explicitly reported as
  database-scoped, not server-scoped.
- **Tight failure classification.** `SqlExceptionClassifier` distinguishes permission
  denial, missing object/column, transient connection failure, timeout/cancellation, and
  Query Store `OFF`/`READ_ONLY`/`ERROR` states from each other and from an unknown/unhandled
  error; nothing is broad-caught into a false `Supported`. Public diagnostics preserve the
  non-secret SQL error number and severity class but never server name, query text, or
  credentials. An exception this classifier does not recognize propagates unhandled rather
  than being silently swallowed into `Unavailable`.
- **Least-privilege guidance, never execution.** `LeastPrivilegeGuidanceGenerator`
  produces the exact `GRANT`/role-membership *text* an operator would run for an observed
  target/version/capability combination (`VIEW SERVER/DATABASE STATE` on SQL Server 2019,
  `VIEW SERVER/DATABASE PERFORMANCE STATE` on 2022+, the tiered Azure SQL Database roles
  above) -- SQLSimCity never executes a grant itself. Every identifier is quoted through a
  tested `QUOTENAME`-equivalent helper (`SqlIdentifierQuoting`) so a hostile principal name
  cannot break out of its bracketed identifier.
- **A deterministic fixture negotiator today.** `FixtureProbeExecutor` maps
  `fixtures/v1/target-capabilities.json` and `fixtures/v1/database-query-store.json` into
  the same canonical `TargetCapabilityProfileV1` a live `SqlClientProbeExecutor` will
  eventually produce, so API and frontend work can consume the real contract before any
  live SQL Server connection exists. `/api/v1/capabilities` (read-only, versioned,
  `Cache-Control: no-store`) exposes exactly this: one negotiated profile per known fixture
  target. There is no corresponding write/mutation endpoint.

`SqlSimCity.Collection.Tests` covers catalog tampering (missing/duplicate/unsafe-path/
parameter/undocumented-variant), the full platform/compatibility matrix across SQL Server
2019/2022/2025 and Azure SQL Database/Managed Instance, PSP/OPPO/secondary-replica gating,
every Query Store operational state, exception classification, cancellation, parameter
binding, least-privilege script quoting, and fixture-to-contract mapping.

## Live incident sampling

`SqlSimCity.Collection`'s live-incident sampler is a second, independent evidence path from
the capability negotiator above: it samples *current* activity — sessions, requests, blocking,
memory grants, tempdb, file I/O, scheduler pressure, and log-space use — on a bounded cadence,
rather than the Query Store aggregates negotiation decides how to request.

- **What "sampled now" means, and what it is not.** Every live-incident snapshot carries its
  own `sourceTimestamp` (when the target produced the data), `collectedAt` (when this process
  observed it), and `freshUntil` (the cadence-derived staleness boundary), so a reader never
  mistakes a sample for a live trace. A request, a lock wait, or a blocking chain that starts
  and fully resolves *between* two samples is invisible to this path; short, fast queries are
  the case most likely to be missed entirely. This is a materially different accuracy claim
  from Query Store: Query Store retains and aggregates every execution across the whole
  retention window, while polling only ever proves what was true at the instant of the last
  sample. Neither the API nor the UI (`web/src/liveIncidents.ts`'s `POLLING_DISCLOSURE`)
  describes this as complete query capture.
- **Canonical, versioned contracts** (`LiveIncidentContractsV1` in
  `src/SqlSimCity.Collection/LiveIncidents/`) cover sampled requests and per-task waits
  (preserving `exec_context_id` so parallel workers are never collapsed onto their
  coordinator's wait), a blocking graph with nodes/edges/roots/cycle state and the four
  negative blocking-session sentinels (`-2` orphaned, `-3` deferred-recovery, `-4`
  interleaved-checkpoint, `-5` untracked latch owner — `-5` is explicitly never described as a
  blocking problem by itself), memory grants (`grant_time IS NULL` is the waiting state),
  tempdb task/session/file use, cumulative file-I/O and scheduler counters expressed as a
  delta against a same-epoch prior sample, log-space pressure, and explicit
  `Unavailable`/`PermissionDenied`/`Timeout` reasons for anything a target does not expose.
  Every bigint count or byte value crosses the wire as a decimal string, never a `number`, so
  large counters survive JSON without silent precision loss.
- **Cumulative counters are epoch-scoped, not free-running.** File I/O, scheduler, and log
  counters only ever produce a rate across two samples of the same target *and* the same
  epoch. A first sample, an engine restart/failover, or any observed counter regression starts
  a new epoch and reports `FirstSample`/`EpochReset` explicitly instead of manufacturing a
  negative or zero rate. `sample_ms` is the sampling process's own OS uptime, never the target
  engine's uptime, and instantaneous gauges (scheduler queue depth, log-space percent) are
  never treated as cumulative.
- **Source-neutral collection.** `ILiveIncidentCollector`/`ILiveIncidentProbeExecutor` let the
  blocking-graph reconstruction, delta math, and sampler cadence be fully unit-tested with no
  SQL Server at all, against either the default `FixtureLiveIncidentCollector` (backed by
  `fixtures/v1/live-cases.json`) or a real `SqlLiveIncidentProbeExecutor`
  (`ISqlConnectionFactory`, static embedded probes, named parameters, bounded command timeouts,
  and negotiated platform/capability scope). Azure SQL Database stays strictly
  database-scoped; server-wide fields it cannot expose remain `Unavailable`, never zero.
- **`LiveIncidentSampler`** runs on a configurable, bounded cadence (default 2-5 seconds), never
  overlaps a cycle with the previous one still running, publishes one immutable latest snapshot
  plus a monotonically increasing sequence number and missed/skipped-cycle counts, supports
  pause/resume, and reconnects through a capped exponential backoff with deterministic jitter.
  All of its cadence/backoff/shutdown behavior is driven by `TimeProvider`, so tests never
  depend on wall-clock timing.
- **API and UI.** `/api/v1/live` (`Cache-Control: no-store`) returns the current
  `LiveIncidentResponseV1`; `/hubs/current-snapshot` pushes the same snapshot to connected
  clients on every successful cycle, keeping only the single latest snapshot in memory (no
  unbounded history). Both are read-only: there is no mutation endpoint anywhere in this path.
  The React "Live Incidents" tab (`web/src/LiveIncidentsPanel.tsx`) is keyboard- and
  screen-reader-accessible: freshness/collector state is a glyph plus text (never color alone),
  motion respects `prefers-reduced-motion`, every parallel wait is listed individually, and
  disappeared requests, sentinel blockers, and unavailable fields are called out explicitly
  rather than silently omitted.

`SqlSimCity.Collection.Tests`' live-incident suite covers blocking roots/chains/cycles/MARS
dedup/sentinels, parallel-wait exposure, disappearing requests, memory-grant waiting state,
first-sample/valid-delta/epoch-reset counter transitions, Azure scope, partial-permission and
timeout handling, and cadence/no-overlap/pause/backoff/shutdown; `SqlSimCity.Api.Tests` covers
the endpoint shape, exact-bigint serialization, GET-only enforcement, and the SignalR push/pull
round-trip; `web/src/liveIncidents.test.ts` covers the same accessibility and disclosure
guarantees on the frontend.

## Security and privacy

SQLSimCity has no login and is intended for a trusted network. Loopback is the safe default; do not expose it through a reverse proxy until authentication and authorization exist. The application sends no analytics or telemetry and loads no CDN, remote font, image, or script. Fixture mode has no application network dependency after loading; connected mode contacts only its configured SQL target and explicit identity endpoints required by the selected authentication strategy.

Atlas and live-incident collection are strictly read-only and fail closed: no probe or endpoint mutates the target, and unavailable secrets or identity providers never fall back to plaintext, anonymous access, or another authentication strategy. The `/data` volume itself is not encrypted by the platform; protected storage (above) is what makes bytes written there unreadable without the configured key, and it is unused unless explicitly enabled. See [SECURITY.md](SECURITY.md).

## Validation

```powershell
dotnet test SqlSimCity.slnx
node --test fixtures/v1/test/validate-fixtures.test.mjs
Set-Location web
npm test
npm run typecheck
npm run build
Set-Location ..
dotnet publish src\SqlSimCity.Api -c Release -o artifacts\publish
docker build -t sqlsimcity:foundation .
```

## License

Copyright 2026 SQLSimCity contributors. Licensed under Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
