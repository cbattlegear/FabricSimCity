# SQLSimCity

SQLSimCity is a self-hosted, evidence-first visual atlas for SQL Server performance data. This foundation is deliberately **fixture-driven**: it proves the end-to-end contract, API, accessible analytical shell, and imperative three.js viewport without connecting to SQL Server.

The fixture is not a benchmark or a description of a real server. SQLSimCity is independent software and is not affiliated with, sponsored by, or endorsed by Microsoft, Electronic Arts, Maxis, the SimCity franchise, or the PGSimCity project. No SimCity assets are included.

## What works

- ASP.NET Core .NET 10 serves `/api/v1/atlas`, `/api/v1/capabilities`, `/healthz`, `/readyz`, a minimal `/hubs/current-snapshot` SignalR seam, and the production Vite bundle.
- Eight deterministic databases cover known, zero, and unknown allocation; live fresh, stale, disconnected, permission-denied, and unknown states; and varied Query Store capability and health.
- React owns selection, detail, tables, and request state. `AtlasScene` owns three.js objects and animation imperatively; no frame updates pass through React state.
- Database footprint follows the documented allocated-KiB mapping. Unknown allocation is marked with an × and never receives a quantitative footprint.
- A keyboard and screen-reader-friendly table contains the same records. Exact bytes and Query Store integer aggregates cross the wire as nonnegative decimal strings and are formatted with `BigInt`, avoiding JavaScript precision loss.

## Accuracy boundary

The contract keeps three evidence classes separate:

1. **Query Store aggregate history** describes a time window. It is not current execution activity. Duration is microseconds and logical reads are counts of 8-KiB pages.
2. **Live DMV samples** are point-in-time observations with explicit observation and freshness timestamps. Missing, stale, disconnected, and permission-denied values remain unavailable, never numeric zero.
3. **Topology is inferred evidence.** Confirmed, probable, and unknown confidence carry rationale; the atlas is not claiming a complete dependency graph.

There is no opaque health score. Query Store capability, health, data status, and reasons remain separate. This version does not execute SQL, discover topology, retain history, or validate production collection behavior. It ships a source-neutral `Microsoft.Data.SqlClient` connection and authentication library (`SqlSimCity.SqlServer`, see below) that is not yet wired into the running application.

## Architecture

```text
src/SqlSimCity.Contracts  versioned transport records and evidence enums
src/SqlSimCity.Domain     fixture source and source seam
src/SqlSimCity.Storage    optional AES-256-GCM encrypted embedded record store
src/SqlSimCity.SqlServer  source-neutral SQL Server connection/authentication library
src/SqlSimCity.Collection SQL probe catalog loader and capability negotiation layer
src/SqlSimCity.Api        same-origin HTTP API, SignalR seam, static hosting
sql/                      versioned probe catalog (manifest.json + probes/*.sql)
fixtures/                 deterministic JSON fixtures for the atlas and capabilities APIs
web/                      strict TypeScript React shell and three.js scene
 tests/                    serialization, fixture, endpoint, storage, connection, catalog, and negotiation tests
```

The API is the source of truth. The frontend fetches `/api/v1/atlas`; fixture records are not duplicated in TypeScript.

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

`SqlSimCity.Storage` is an optional, source-neutral encrypted embedded record store for future use by SQL Server collection. It ships **disabled by default** and is unused by the fixture path in this release. When enabled it:

- encrypts every payload with AES-256-GCM inside a versioned envelope (format version, key version, nonce, tag, ciphertext) before any byte reaches SQLite, with record kind, opaque record ID, and key version bound as authenticated associated data so ciphertext cannot be swapped between records;
- loads its key ring only from an explicitly configured file (see [SECURITY.md](SECURITY.md) for the exact JSON format, key rotation, and backup guidance) and never logs key material;
- fails closed: a missing/wrong key, corrupt or tampered envelope, failed canary check, or migration error prevents the application from becoming ready rather than silently degrading to an unencrypted or partially working store;
- exposes only opaque record IDs, record kind, captured timestamp, and resolution (`Detail`/`HourlyRollup`) as plaintext metadata — payload bytes are always encrypted;
- prunes at most `ProtectedStorage:Retention:PruneBatchSize` expired records per invocation (call again to drain more), under a default retention of 7 days for `Detail` and 90 days for `HourlyRollup`; the batch size is bounded from 1 through 500.
- restricts the database filename to a simple filename, record-kind metadata to 128 characters (maximum 1,024), and plaintext payloads to 1 MiB (maximum 16 MiB); `MaxRecordKindLength` and `MaxPayloadBytes` are explicit protected-storage configuration limits.

Enable it with `ProtectedStorage:Enabled=true`, `ProtectedStorage:DataDirectory`, and `ProtectedStorage:KeyFilePath` (see `compose.yaml` for a commented example). This release does not use protected storage for anything; it exists so a future SQL Server collector has an already-hardened place to put retained evidence and credentials instead of a new unencrypted table.

## SQL Server connection and authentication

`SqlSimCity.SqlServer` is a source-neutral connection and authentication library for a future SQL Server collector. It is **not wired into `SqlSimCity.Api`** in this release — no request path opens a SQL Server connection. It exists as a standalone, independently tested library so a future collector builds on already-hardened connection handling instead of new ad hoc code. It ships:

- an immutable, fully validated `ConnectionProfile` (DNS/FQDN or IPv4 host, optional named instance or explicit port — never both, initial database, bounded connect/command timeouts and pool bounds, a fixed `SQLSimCity` application name, an explicit `EncryptionPolicy`, and a per-profile `TrustServerCertificate` opt-in that is never inherited or global; IPv6 literals are rejected until their SqlClient TCP syntax is implemented);
- a closed authentication-strategy hierarchy with **no fallback between strategies**: SQL login (username plus a secret-file password reference), a Linux Kerberos/SSPI service identity, and four explicit Microsoft Entra ID strategies (`ManagedIdentity`, `WorkloadIdentity`, `ServicePrincipalCertificate`, `ServicePrincipalSecret`) — **never `DefaultAzureCredential` or any credential chain**, enforced by a static test;
- an `ISecretFileProvider` that resolves only simple, validated file-name references under one configured secrets directory (default `/run/secrets`), enforces a size limit, and fails closed (`SecretResolutionException`) on anything missing, oversized, or invalid — never logging secret content;
- an `ISqlConnectionFactory` that builds every connection through `SqlConnectionStringBuilder` only (a password or Entra token is never concatenated into the connection string); retains SQL-login credentials, and Entra credentials plus their `AccessTokenCallback` delegate, for the lifetime of their pool — reusing the exact same callback delegate per stable security context, since `AccessTokenCallback` is itself part of SqlClient's connection pool key (see the [official documentation](https://learn.microsoft.com/sql/connect/ado-net/sql/azure-active-directory-authentication#using-accesstokencallback)) — and provides explicit per-profile invalidation after password, certificate, or client-secret rotation, clearing each credential's pool before releasing its material; and a secret-free `SafeConnectionSettings` DTO for authorized UI and protected storage. `SafeConnectionSettings` contains operationally sensitive target and identity metadata, so it must not be logged or exposed indiscriminately.

See [SECURITY.md](SECURITY.md) for the Kerberos keytab/SPN/DNS/clock-sync and Entra endpoint/IMDS deployment requirements.

## Capability negotiation

`SqlSimCity.Collection` is an implementation-ready capability negotiation layer for a
future SQL Server/Azure SQL collector. It is deliberately **not the full atlas
collector**: it decides what a target can safely be asked for, not how to gather bulk
telemetry from it.

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

## Security and privacy

SQLSimCity has no login and is intended for a trusted network. Loopback is the safe default; do not expose it through a reverse proxy until authentication and authorization exist. The application sends no analytics or telemetry and loads no CDN, remote font, image, or script. It has no application network dependency after loading.

Collection is intended to be read-only, but no collector exists yet. Future authentication must fail closed: unavailable keys or identity providers must prevent collection and disclosure rather than fall back to plaintext or anonymous access. The `/data` volume itself is not encrypted by the platform; protected storage (above) is what makes bytes written there unreadable without the configured key, and it is unused unless explicitly enabled. See [SECURITY.md](SECURITY.md).

## Validation

```powershell
dotnet test SqlSimCity.slnx
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
