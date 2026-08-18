# SQLSimCity

SQLSimCity is a self-hosted visual performance tool for Microsoft SQL Server. It combines:

- a server atlas and database-city map;
- Query Store history and compiled-plan comparison;
- sampled live requests, waits, blocking, memory grants, tempdb, I/O, and log pressure;
- evidence-backed findings with caveats and next checks;
- offline archives and an optional outward-only edge connector.

**Heavily inspired by [PGSimCity](https://github.com/NikolayS/PGSimCity).**

SQLSimCity is strictly read-only against monitored SQL Servers. Query Store history is aggregate
evidence, live DMVs are point-in-time samples, and inferred relationships are always labelled with
their confidence.

> **Security:** SQLSimCity has no built-in login. Keep it on loopback or a trusted network, or place
> it behind an authenticating reverse proxy. The UI repeats this warning on every view.

## Quick start with Docker

### Fixture mode

Fixture mode needs no SQL Server and is the fastest way to explore the product.

```powershell
docker build -t sqlsimcity:local .

docker run --rm --name sqlsimcity `
  --publish 127.0.0.1:8080:8080 `
  --read-only `
  --tmpfs /tmp:rw,noexec,nosuid,size=64m `
  --tmpfs /data:rw,noexec,nosuid,size=64m `
  --cap-drop ALL `
  --security-opt no-new-privileges `
  sqlsimcity:local
```

Open <http://127.0.0.1:8080>.

The equivalent Compose command is:

```powershell
docker compose up --build
```

### Connect to SQL Server

SQLSimCity intentionally does **not** accept a raw semicolon-delimited connection string because
those strings commonly expose passwords. Set the connection fields as environment variables and
mount the password as a read-only file secret.

A conventional connection string such as:

```text
Server=sql01.example.internal,1433;Initial Catalog=master;Encrypt=True;User ID=sqlsimcity_reader
```

maps to:

| Connection-string field | SQLSimCity setting |
| --- | --- |
| `Server` | `Atlas__Connection__Host` plus `Atlas__Connection__Port` or `Instance` |
| `Initial Catalog` | `Atlas__Connection__InitialDatabase` |
| `Encrypt=True` | `Atlas__Connection__Encryption=Mandatory` |
| `TrustServerCertificate` | `Atlas__Connection__TrustServerCertificate` |
| `User ID` | `Atlas__Connection__Authentication__Username` |
| `Password` | mounted secret named by `Atlas__Connection__Authentication__PasswordSecret` |

Create a password file without placing the password in shell history:

```powershell
New-Item -ItemType Directory -Force .\secrets | Out-Null
$credential = Get-Credential -UserName "sqlsimcity_reader" -Message "Enter the SQL login password"
[IO.File]::WriteAllText(
  (Join-Path (Resolve-Path .\secrets) "sql-password"),
  $credential.GetNetworkCredential().Password)
Remove-Variable credential
```

Then run the connected atlas:

```powershell
$passwordFile = (Resolve-Path .\secrets\sql-password).Path

docker run --rm --name sqlsimcity `
  --publish 127.0.0.1:8080:8080 `
  --read-only `
  --tmpfs /tmp:rw,noexec,nosuid,size=64m `
  --mount type=volume,src=sqlsimcity-data,dst=/data `
  --mount "type=bind,src=$passwordFile,dst=/run/secrets/sql-password,readonly" `
  --cap-drop ALL `
  --security-opt no-new-privileges `
  --env ASPNETCORE_ENVIRONMENT=Production `
  --env Atlas__Mode=Connected `
  --env Atlas__TargetId=primary `
  --env Atlas__DisplayName="Production SQL Server" `
  --env Atlas__Connection__Host=sql01.example.internal `
  --env Atlas__Connection__Port=1433 `
  --env Atlas__Connection__InitialDatabase=master `
  --env Atlas__Connection__Encryption=Mandatory `
  --env Atlas__Connection__Authentication__Mode=SqlLogin `
  --env Atlas__Connection__Authentication__Username=sqlsimcity_reader `
  --env Atlas__Connection__Authentication__PasswordSecret=sql-password `
  --env Atlas__SecretsDirectory=/run/secrets `
  sqlsimcity:local
```

Replace the host, port, database, and login with values reachable **from the container**. For Azure
SQL Database, list databases explicitly with `Atlas__KnownDatabases__0`, `__1`, and so on.

This basic profile enables the connected atlas and database city. Encrypted Query Store history and
live incidents require additional settings because they have retention and cadence controls. See
[`docs/connected-mode.md`](docs/connected-mode.md) for a complete Compose override, permissions, all
authentication modes, protected-storage keys, Query Store, and live sampling.

## Documentation

| Guide | Contents |
| --- | --- |
| [Architecture and evidence](docs/architecture.md) | Components, evidence boundaries, visual semantics, scale, and API surfaces |
| [Connected mode](docs/connected-mode.md) | SQL connection profiles, permissions, Query Store, live incidents, TLS, and secrets |
| [Operations](docs/operations.md) | Reverse proxy and `AllowedHosts`, backup/restore, upgrades, rollback, SBOM, and provenance |
| [Security](SECURITY.md) | Threat model, key rotation, Kerberos, Microsoft Entra ID, and fail-closed behavior |
| [Offline archives](docs/archive-format.md) | Redacted export format and offline import |
| [Edge connector](docs/edge-connector.md) | Outward-only remote collection, signing, replay defense, and encrypted spool |
| [SQL probe catalog](sql/README.md) | Read-only probe contracts, permissions, platform scope, and units |
| [Fixture contract](fixtures/v1/README.md) | Sanitized deterministic evidence used by tests and demos |

## Development

Requires .NET SDK 10 and Node.js 24 (Node 22.12+ is also supported by the frontend toolchain).

```powershell
# Terminal 1
dotnet run --project src\SqlSimCity.Api --urls http://127.0.0.1:5080

# Terminal 2
Set-Location web
npm install
npm run dev
```

Vite serves the UI and proxies API/SignalR traffic to port 5080.

## Validation

```powershell
npm test
node --test fixtures\v1\test\validate-fixtures.test.mjs
dotnet test SqlSimCity.slnx

Set-Location web
npm test
npm run typecheck
npm run build
```

See [CHANGELOG.md](CHANGELOG.md) for shipped changes and known validation gaps.

## Project status and affiliation

No real SQL Server, Azure SQL Database, or Azure SQL Managed Instance target was available during
development; connected paths are covered by deterministic fakes, production composition tests, and
fail-closed container smokes.

SQLSimCity is independent software. It is not affiliated with, sponsored by, or endorsed by
Microsoft, Electronic Arts, Maxis, the SimCity franchise, or the PostgreSQL project. No SimCity
assets are included.

## License

Copyright 2026 SQLSimCity contributors. Licensed under Apache-2.0; see [LICENSE](LICENSE) and
[NOTICE](NOTICE).
