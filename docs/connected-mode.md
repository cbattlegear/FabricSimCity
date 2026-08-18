# Connected SQL Server mode

Connected mode runs only the embedded, startup-validated, static read-only SQL probe catalog. It
never executes grants or tuning changes.

## Quick start: a single connection string

The fastest way to point SQLSimCity at a real server is one ordinary ADO.NET connection string:

```text
ConnectionStrings__SqlSimCity=Server=sql01.example.internal,1433;Database=master;User Id=sqlsimcity_reader;Password=...;TrustServerCertificate=true
```

`SQLSIMCITY_CONNECTION_STRING` works identically, for parity with the edge connector's naming.

Setting either one turns connected mode on by itself — Atlas, live incidents, and Query Store
history all switch off the fixture path with no `Atlas:Mode`, `LiveIncidents:Mode`, or
`QueryStoreHistory:Mode` needed. With no connection string configured, fixtures stay the default.

Query Store history stores query *text*, so it requires encryption at rest and has no plaintext
fallback. Rather than make you turn that on by hand, a connection string provisions the key for you:
an AES-256 key ring is generated at a `sqlsimcity-keys` directory beside `ProtectedStorage:DataDirectory`
and announced at startup with a warning naming the path. **Back that file up and keep it — if it is
lost or replaced, every stored query history record becomes permanently unrecoverable and the store
refuses to open.** It is deliberately placed outside the data directory so a data backup cannot carry
its own decryption key; `tools/backup-data.sh` refuses to run when the two are nested. In a
container, that path needs a persistent writable volume (see the Compose example below) or the key
will not survive recreation. If the key cannot be written at all, Query Store history disables itself
with a warning rather than blocking startup.

To keep key custody entirely in your own hands, set `ProtectedStorage:Enabled=true` and mount your
own key file at `ProtectedStorage:KeyFilePath`; nothing is then generated, and a missing key fails
closed as before. `QueryStoreHistory:Mode=Disabled` opts out of collection completely.

The connection string is parsed into exactly the same validated `ConnectionProfile` the settings
below produce, so every downstream guarantee still holds: the password is passed as a
`SqlCredential` and never appears in a connection string, log, or diagnostic; `ApplicationIntent`
is forced to `ReadOnly`; and the application name is forced to `SQLSimCity`.

**This is a convenience, not the hardened path.** A password in a connection string is readable by
anything that can read the process environment and cannot be rotated without a restart, unlike the
mounted secret files the settings path uses. The API logs a warning at startup when one is
configured. Use it for local development and evaluation; prefer the settings below in production.
See [SECURITY.md](../SECURITY.md).

What a connection string cannot express, and what SQLSimCity does about it:

| Concern | Behavior |
| --- | --- |
| Engine platform | Inferred from the host name: `*.database.windows.net` is taken as Azure SQL Database, everything else as SQL Server on-premises. Managed Instance shares that suffix, so it must be stated explicitly. |
| `Atlas:KnownDatabases` | Defaults to the connection string's own `Database` when the host is Azure SQL. Explicit configuration always wins. |
| `Encrypt=false` | Rejected. SQLSimCity supports only `Mandatory` (the SqlClient default) and `Strict`. |
| Workload identity, service principal, `Active Directory Default` | Rejected. These need a tenant id a connection string cannot carry, or are banned outright; use the settings below. |
| `Connect Timeout=0` / `Command Timeout=0` | Rejected. Timeouts are bounded, never infinite. |
| `Max Pool Size` | Defaults to 20, matching the settings below, not SqlClient's own default of 100. An explicit value always wins. |
| `Server=admin:host`, `np:`, `lpc:` | Rejected. SQLSimCity rebuilds the connection string as TCP, so honoring a different protocol or endpoint is not possible; silently connecting elsewhere would be worse. `tcp:` is accepted. |

Supported authentication in a connection string: SQL login (`User Id` + `Password`), Kerberos
(`Integrated Security=true`), and managed identity
(`Authentication=Active Directory Managed Identity`, with `User Id` as the user-assigned client id).

A connection string **cannot be combined with any `Atlas:Connection` or `LiveIncidents:Connection`
field it already covers** — host, port, instance, database, timeouts, pool bounds, encryption,
certificate trust, or authentication. Configuring both is rejected at startup rather than silently
resolved in the connection string's favor, because `ConnectionStrings__SqlSimCity` is a conventional
name that some hosting platforms inject automatically: without this check, one appearing in the
environment would quietly replace a hardened profile's authentication strategy, TLS trust setting,
and mounted password file. Labels a connection string cannot express stay configurable alongside
one: `Atlas:Connection:ProfileId`, and `LiveIncidents:Connection`'s `TargetId`, `DisplayName`,
`Platform`, and `Secrets`.

A section-scoped key overrides the shared one for a single subsystem — `Atlas:ConnectionString` and
`LiveIncidents:Connection:ConnectionString`. Resolution order is section key, then
`ConnectionStrings:SqlSimCity`, then `SQLSIMCITY_CONNECTION_STRING`.

## Connection settings instead of a raw connection string

For production, SQLSimCity prefers a typed `ConnectionProfile` over a raw connection string. This
keeps passwords and access tokens out of environment variables, logs, and process arguments
entirely: only a *reference* to a mounted secret file is configured, and the bytes are read from
that file at use time.

The Atlas profile is configured under `Atlas:Connection`:

| Setting | Purpose |
| --- | --- |
| `Host` | SQL Server DNS name or IPv4 address reachable from the container |
| `Port` | TCP port; mutually exclusive with `Instance` |
| `Instance` | Named instance; mutually exclusive with `Port` |
| `InitialDatabase` | Initial database, usually `master` for SQL Server/Managed Instance |
| `ConnectTimeoutSeconds` / `CommandTimeoutSeconds` | Bounded connection and probe timeouts |
| `MaxPoolSize` | Bounded SqlClient pool |
| `Encryption` | `Mandatory` or `Strict` |
| `HostNameInCertificate` | Optional expected TLS certificate name |
| `TrustServerCertificate` | Explicit per-profile opt-in; rejected with `Strict` |

The corresponding environment variable replaces `:` with `__`, for example:

```text
Atlas__Connection__Host=sql01.example.internal
Atlas__Connection__Port=1433
Atlas__Connection__InitialDatabase=master
```

## Compose override

Keep the default [`compose.yaml`](../compose.yaml) and add a local
`compose.connected.yaml` (do not commit real secret files):

```yaml
services:
  sqlsimcity:
    environment:
      # Development shortcut -- one variable, no mounted secret file. The password
      # is readable from the container environment; see the quick start above.
      # ConnectionStrings__SqlSimCity: "Server=sql01.example.internal,1433;Database=master;User Id=sqlsimcity_reader;Password=...;TrustServerCertificate=true"
      Atlas__Mode: Connected
      Atlas__TargetId: production-east
      Atlas__DisplayName: Production East
      Atlas__Connection__Host: sql01.example.internal
      Atlas__Connection__Port: "1433"
      Atlas__Connection__InitialDatabase: master
      Atlas__Connection__Encryption: Mandatory
      Atlas__Connection__Authentication__Mode: SqlLogin
      Atlas__Connection__Authentication__Username: sqlsimcity_reader
      Atlas__Connection__Authentication__PasswordSecret: sql-password
      Atlas__SecretsDirectory: /run/secrets

      # Retained Query Store history requires encrypted storage. This is the
      # operator-managed key path: because ProtectedStorage__Enabled is set
      # explicitly, nothing is generated and a missing key file fails closed.
      # (Drive the connection from a connection string instead and the key is
      # provisioned for you — give it a persistent volume, as in compose.yaml.)
      QueryStoreHistory__Mode: Connected
      ProtectedStorage__Enabled: "true"
      ProtectedStorage__DataDirectory: /data
      ProtectedStorage__KeyFilePath: /run/secrets/storage-key

      # Live sampling has its own cadence/profile and must name the same target
      # when its counts should appear in the Atlas.
      LiveIncidents__Mode: Connected
      LiveIncidents__Connection__TargetId: production-east
      LiveIncidents__Connection__DisplayName: Production East
      LiveIncidents__Connection__Platform: SqlServerOnPremises
      LiveIncidents__Connection__Server__Host: sql01.example.internal
      LiveIncidents__Connection__Server__Port: "1433"
      LiveIncidents__Connection__Database: master
      LiveIncidents__Connection__Encryption: Mandatory
      LiveIncidents__Connection__Authentication__Mode: SqlLogin
      LiveIncidents__Connection__Authentication__Username: sqlsimcity_reader
      LiveIncidents__Connection__Authentication__PasswordSecretFile: sql-password
      LiveIncidents__Connection__Secrets__Directory: /run/secrets
    secrets:
      - sql-password
      - storage-key

secrets:
  sql-password:
    file: ./secrets/sql-password
  storage-key:
    file: ./secrets/storage-key.json
```

Run:

```powershell
docker compose -f compose.yaml -f compose.connected.yaml up --build
```

The protected-storage key-ring format, generation commands, rotation rules, and backup requirements
are documented in [`SECURITY.md`](../SECURITY.md).

## Authentication modes

Exactly one strategy is selected. Authentication never falls back to another strategy.

| Mode | Required settings |
| --- | --- |
| `SqlLogin` | username plus password secret-file reference |
| `Kerberos` | Linux service identity/keytab configured outside the connection string |
| `ManagedIdentity` | optional user-assigned client ID |
| `WorkloadIdentity` | tenant ID, client ID, projected federated-token file |
| `ServicePrincipalCertificate` | tenant/client IDs plus certificate and optional password secret files |
| `ServicePrincipalSecret` | tenant/client IDs plus client-secret file |

SQLSimCity never uses `DefaultAzureCredential` or an interactive credential chain. See
[`SECURITY.md`](../SECURITY.md) for Kerberos SPN/DNS/clock requirements, Microsoft Entra endpoints,
IMDS, certificate handling, and credential rotation.

## Azure SQL Database

Azure SQL Database is database-scoped:

- set `Atlas__Connection__InitialDatabase` to a user database;
- set `LiveIncidents__Connection__Platform=AzureSqlDatabase`;
- list every collected database explicitly:

```text
Atlas__KnownDatabases__0=sales
Atlas__KnownDatabases__1=warehouse
```

SQLSimCity does not assume logical-server-wide visibility, connect to `tempdb`, or treat Azure
database IDs as globally unique.

## Least-privilege permissions

The exact required visibility depends on platform, version, service tier, and enabled surfaces.
SQLSimCity reports missing permission as evidence and never grants it.

Typical SQL Server grants:

- SQL Server 2016-2019: `VIEW SERVER STATE` plus `VIEW DATABASE STATE` in collected databases.
- SQL Server 2022+: `VIEW SERVER PERFORMANCE STATE` plus `VIEW DATABASE PERFORMANCE STATE`.
- `CONNECT` to every collected database.
- Keep `VIEW ANY DATABASE` only when automatic database discovery is desired.

Azure SQL Database should use the smallest documented database-scoped permission or role supported
by its service tier. Review the per-probe permission and platform notes in
[`sql/README.md`](../sql/README.md) before deploying a production principal.

## Connected subsystems

### Atlas and database city

`Atlas__Mode=Connected` discovers at most 100 databases (except explicit Azure lists), collects
capacity, Query Store summaries, and file-I/O counters with bounded concurrency, and never overlaps
refresh cycles. Database-city object/index pages are queried only when entered.

### Query Store history

Connected Query Store history is enabled by a connection string, or explicitly with
`QueryStoreHistory__Mode=Connected`. Either way it requires Atlas connected mode and protected
storage, which a connection string provisions automatically (see the quick start above). The
collector uses keyset pages, overlap watermarks, reset epochs, active-interval replacement, bounded
encrypted generations, and a final publication pointer.

Raw SQL and Showplan XML are fetched only on demand and stored as 7-day encrypted detail. Normalized
facts and hourly history are retained for 90 days by default.

Collection needs Query Store to be enabled on the databases themselves (`ALTER DATABASE ... SET
QUERY_STORE = ON`); databases with it off are discovered and skipped. It cannot be enabled on
`master`, so a connection string pointing only at `master` collects nothing.

### Live incidents

Live incidents use an independent profile because their sampling cadence, initial database, and
platform scope can differ from historical collection. Give it the same `TargetId` as Atlas to project
fresh live counts into the database atlas.

Sampling is not a trace: a request or blocking chain that begins and ends between polls can be missed.
Every result carries source/freshness timestamps and explicit stale, disconnected, permission-denied,
or unsupported states.

## TLS and reverse proxies

- `Mandatory` requires encrypted transport and supports an explicit per-profile
  `TrustServerCertificate` opt-in.
- `Strict` uses strict TLS and rejects `TrustServerCertificate=true`.
- Behind an authenticating reverse proxy, configure `AllowedHosts` to the exact externally accepted
  host names. SQLSimCity does not trust forwarded headers by default.
- Keep the backend network path private even when the proxy provides TLS and authentication.

See [`docs/operations.md`](operations.md) for complete deployment, upgrade, rollback, and recovery
guidance.
