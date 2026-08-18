# Connected SQL Server mode

Connected mode runs only the embedded, startup-validated, static read-only SQL probe catalog. It
never executes grants or tuning changes.

## Connection settings instead of a raw connection string

SQLSimCity uses a typed `ConnectionProfile` rather than accepting a raw connection string. This
prevents passwords or access tokens from being placed in environment variables, logs, or process
arguments.

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

      # Retained Query Store history requires encrypted storage.
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

`QueryStoreHistory__Mode=Connected` requires Atlas connected mode and protected storage. The
collector uses keyset pages, overlap watermarks, reset epochs, active-interval replacement, bounded
encrypted generations, and a final publication pointer.

Raw SQL and Showplan XML are fetched only on demand and stored as 7-day encrypted detail. Normalized
facts and hourly history are retained for 90 days by default.

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
