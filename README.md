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

There is no opaque health score. Query Store capability, health, data status, and reasons remain separate. This version does not include `Microsoft.Data.SqlClient`, execute SQL, discover topology, retain history, or validate production collection behavior.

## Architecture

```text
src/SqlSimCity.Contracts  versioned transport records and evidence enums
src/SqlSimCity.Domain     fixture source and source seam
src/SqlSimCity.Api        same-origin HTTP API, SignalR seam, static hosting
web/                      strict TypeScript React shell and three.js scene
 tests/                    serialization, fixture, endpoint, and mapping tests
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

Compose publishes only `127.0.0.1:8080`, runs as the .NET image's non-root user, drops all Linux capabilities, enables `no-new-privileges`, uses a read-only root filesystem, mounts `/tmp` as tmpfs, and reserves named `/data`. The fixture slice writes nothing to `/data`.

The image targets Linux containers on x86-64 and ARM64 where the selected official .NET and Node images are available. Current Chromium, Firefox, and Safari with WebGL2 are the browser targets; the complete text/table view remains usable when the 3D viewport cannot render.

## Security and privacy

SQLSimCity has no login and is intended for a trusted network. Loopback is the safe default; do not expose it through a reverse proxy until authentication and authorization exist. The application sends no analytics or telemetry and loads no CDN, remote font, image, or script. It has no application network dependency after loading.

Collection is intended to be read-only, but no collector exists yet. Future authentication and encrypted storage must fail closed: unavailable keys or identity providers must prevent collection and disclosure rather than fall back to plaintext or anonymous access. The `/data` volume is not encrypted by SQLSimCity; a plain Docker volume must not be represented as production-safe storage. See [SECURITY.md](SECURITY.md).

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
