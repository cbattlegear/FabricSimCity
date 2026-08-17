# SQLSimCity

SQLSimCity is a self-hosted, evidence-first visual atlas for SQL Server performance data. This foundation is deliberately **fixture-driven**: it proves the end-to-end contract, API, accessible analytical shell, and imperative three.js viewport without connecting to SQL Server.

The fixture is not a benchmark or a description of a real server. SQLSimCity is independent software and is not affiliated with, sponsored by, or endorsed by Microsoft, Electronic Arts, Maxis, the SimCity franchise, or the PGSimCity project. No SimCity assets are included.

## What works

- ASP.NET Core .NET 10 serves `/api/v1/atlas`, `/healthz`, `/readyz`, a minimal `/hubs/current-snapshot` SignalR seam, and the production Vite bundle.
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
src/SqlSimCity.Api        same-origin HTTP API, SignalR seam, static hosting
web/                      strict TypeScript React shell and three.js scene
 tests/                    serialization, fixture, endpoint, storage, connection, and mapping tests
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
- an `ISqlConnectionFactory` that builds every connection through `SqlConnectionStringBuilder` only (a password or Entra token is never concatenated into the connection string), retains SQL-login credentials for the lifetime of their pool, and provides explicit per-profile invalidation after password rotation; and a secret-free `SafeConnectionSettings` DTO for authorized UI and protected storage. `SafeConnectionSettings` contains operationally sensitive target and identity metadata, so it must not be logged or exposed indiscriminately.

See [SECURITY.md](SECURITY.md) for the Kerberos keytab/SPN/DNS/clock-sync and Entra endpoint/IMDS deployment requirements.

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
