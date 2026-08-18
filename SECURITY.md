# Security policy

## Foundation threat model

The application defaults to deterministic fixture mode, which creates no SQL connection. Operators may explicitly enable connected mode with a validated read-only target profile and file-mounted credentials. Connected collection runs only embedded, manifest-validated static probes; it does not accept SQL text through the API. The application has no login, user account, analytics, or telemetry. Optional encrypted protected storage is disabled by default and is not used by atlas collection.

The application exposes operational-shaped evidence to every client that can reach it. **There is no authentication or authorization.** Run the default Compose configuration on loopback or another explicitly trusted network only. Do not publish port 8080 on all interfaces or place the service on the public internet.

Security headers enforce a same-origin baseline: no permissive CORS, no remote scripts, no `unsafe-eval`, and locked-down object, base, and frame-ancestor policies. SignalR uses same-origin `connect-src 'self'`. Health probes return only generic status and no target identity.

### Connected edge connector

The outward-only connector defaults to fixtures. `SQLSIMCITY_EDGE_SOURCE_MODE=Connected` requires a
complete platform/TLS/pool/timeout profile and exactly one SQL login, Kerberos, managed identity,
workload identity, service-principal certificate, or service-principal secret strategy. Passwords,
client secrets, certificates, certificate passwords, and workload tokens are file references under
the configured secrets directory; plaintext secret environment variables and credential-chain
fallback are rejected. Required authentication files are checked before collection starts.

Connected edge Query Store collection reads normalized facts only and never calls raw query-text or
Showplan XML lookups. Live probes set `@IncludeSqlText=0`, preventing `sys.dm_exec_sql_text` from
being invoked, and identity/text fields are cleared defensively before signing. Query Store working
state uses a bounded process-memory `IProtectedRecordStore`; it is never persisted as plaintext and
owned buffers are zeroed on replacement and shutdown. Permit outbound traffic only to the configured
central HTTPS endpoint, SQL endpoint, and the identity/Kerberos endpoints required by the selected
strategy. The connector exposes no inbound control API.

## Data and storage

The `/data` mount hosts an optional encrypted protected storage layer. It is **disabled by default**, and atlas collection does not persist snapshots there. Nothing writes to `/data` unless an operator explicitly enables protected storage and provides a key. A standard Docker named volume is not application-level encryption by itself; protected storage's AES-256-GCM envelope is what makes retained bytes unreadable without the key, and the volume must still be backed up and access-controlled like any other data at rest.

### Offline archive trust boundary

Observation archives are untrusted input even when copied from another SQLSimCity installation.
Archive mode resolves one simple filename under an operator-controlled allowed directory and rejects
traversal, symbolic links/reparse points, directories, unsupported major versions, noncanonical
manifests, duplicate/undeclared names, unknown required features, corrupt digests, truncation,
trailing bytes, oversized files/entries/strings/numbers/arrays, excessive JSON depth, non-UTC or
out-of-range timestamps, and inconsistent indexes before registering any source. The format is
uncompressed and has no extraction step, so archive-controlled paths, decompression bombs, ratio
attacks, XXE, executable/plugin content, filesystem writes, and network fetches do not exist in the
reader. Payload strings reach React only as ordinary text under the existing CSP; they are never
treated as HTML.

The archive file must be mounted read-only. Do not place credentials or protected-storage database
files in the archive directory. Archive mode performs no SQL Server or identity operation and fails
startup on any integrity or compatibility error rather than publishing a partial state. An archive is
not encrypted storage or a backup; protect it in transit and at rest according to the evidence it
contains.

### Enabling protected storage

Set `ProtectedStorage:Enabled` to `true` and provide two mandatory settings:

- `ProtectedStorage:DataDirectory` — a writable directory for the SQLite database file (the container image sets this to `/data`).
- `ProtectedStorage:KeyFilePath` — the path to a key ring file, normally a Docker/Compose secret mounted at `/run/secrets/sqlsimcity-storage-key`.

If either is missing when `Enabled` is `true`, the process fails at startup rather than falling back to an unencrypted or partially configured store. If the key file is missing, unreadable, malformed, or declares an invalid key, resolving the storage service fails with `SqlSimCity.Storage.KeyRingConfigurationException` and the process does not become ready. This is intentional: there is no unencrypted fallback mode.

### Key file format

The key file is strict JSON:

```json
{
  "formatVersion": 1,
  "activeKeyVersion": 2,
  "keys": [
    { "version": 1, "key": "<base64, must decode to exactly 32 bytes>" },
    { "version": 2, "key": "<base64, must decode to exactly 32 bytes>" }
  ]
}
```

- `formatVersion` must be `1`.
- `activeKeyVersion` selects the key used to encrypt new data; it must appear in `keys`.
- Every entry in `keys` must have a unique, positive `version` and a `key` that base64-decodes to exactly 32 bytes (AES-256). Duplicate versions, missing versions, non-base64 values, and wrong-length keys are all rejected.
- Older versions may remain in `keys` after rotation so previously written records stay readable; they are never used to encrypt new data once `activeKeyVersion` moves past them.

Generate a key with, for example:

```bash
openssl rand -base64 32
```

Never commit a real key file to source control. This repository does not ship one.

### Key rotation

1. Add a new key version to the file (new random 32 bytes, a new version number) alongside the existing ones, keeping the old `activeKeyVersion` for now.
2. Once the new file is deployed everywhere the app reads it, change `activeKeyVersion` to the new version. New writes use the new key; existing rows remain readable because their key version is still present in `keys`.
3. After enough time has passed that no record can plausibly still need an old key (see retention below), remove the retired version from `keys`. Removing a version that a still-live record depends on makes that record permanently unreadable — there is no recovery path other than restoring from backup.

### Backup and recovery

**The data volume and the key file must be backed up independently, and losing the key file makes every encrypted record it protected permanently unrecoverable — including from a database backup.** A backup of `/data` without the matching key file is worthless for protected storage; a backup of the key without the data is equally worthless. Store the key file with the same care as a production credential (a secrets manager, not a repository, not an unencrypted volume snapshot alongside the data it protects).

### Fail-closed behavior

Protected storage never silently degrades to plaintext. Every one of the following prevents the store from becoming usable rather than being logged and ignored: a missing or unreadable key file; a key file that fails strict format validation; a key that decrypts a database's *canary* record to the wrong value (meaning the configured key does not match the key the store was created or last opened with); a corrupted or tampered ciphertext envelope; or a SQLite schema migration failure. A fresh (empty) store creates its own canary on first use; an existing store must decrypt and verify that canary before any other record is read or written.

### Retention

Default retention is 7 days for `Detail`-resolution records and 90 days for `HourlyRollup` records. `PruneExpiredAsync` deletes at most `PruneBatchSize` rows per invocation, so callers repeat it to drain further expired rows; `PruneBatchSize` must be from 1 through 500. Retention pruning only ever deletes expired rows from the record table; it never touches the canary or schema metadata.

`DatabaseFileName` must be a simple filename, not a rooted path or a path containing separators or traversal. To prevent arbitrary memory, AAD, ciphertext, and SQLite BLOB allocation by future callers, `MaxRecordKindLength` defaults to 128 characters and is capped at 1,024, while `MaxPayloadBytes` defaults to 1 MiB and is capped at 16 MiB; both must be positive when protected storage is enabled.

### Storage engine and `/data`

Protected storage runs SQLite in WAL (write-ahead log) journal mode, which relies on shared-memory locking between the `-wal` and `-shm` sidecar files it creates next to the main database file. This is safe and performant on a local filesystem-backed volume, which is what this repository's `compose.yaml` uses (a standard Docker named volume). **Do not mount `/data` from a network filesystem (NFS, CIFS/SMB, or similar) unless it is verified to support the POSIX advisory locking SQLite's WAL mode requires** — unsupported locking on a network mount can corrupt the database or silently disable the concurrency guarantees WAL is meant to provide.

### Connected SQL Server collection

Connected mode uses `SqlSimCity.SqlServer` through an injected connection factory and `SqlSimCity.Collection` through injected probe executors. It collects database identity, exact space usage, bounded Query Store aggregates, and cumulative file I/O. It does not collect query text, plan XML, or live request traffic. Deployment must:

- use a least-privilege, read-only SQL Server principal and document every required permission;
- keep target secrets out of images, source, logs, URLs, and atlas responses;
- introduce authentication and authorization before non-loopback deployment;
- write any future retained collected evidence through protected storage rather than a new unencrypted table;
- fail closed when authentication, key retrieval, integrity validation, or encrypted storage is unavailable, matching protected storage's existing fail-closed behavior;
- distinguish permission denial, unsupported capability, disconnection, staleness, and unknown data rather than substituting zero;
- avoid logging query text or other potentially sensitive workload content by default.

Supported host targets are Linux containers on x86-64 and ARM64 using official .NET 10 images. Browser targets are current Chromium, Firefox, and Safari. Connected collection supports SQL Server 2016+, Azure SQL Managed Instance, and explicit known-database lists on Azure SQL Database; target-specific integration remains the operator's responsibility.

## SQL Server connection and authentication

`SqlSimCity.SqlServer` builds and opens `SqlConnection`s from an immutable, validated `ConnectionProfile`. It has no fallback between authentication strategies: a strategy either succeeds on its own terms or the connection attempt fails. Every connection is built through `SqlConnectionStringBuilder` only; a password or Entra token is never concatenated into a connection string or logged. `SafeConnectionSettings` excludes secrets and tokens but contains operationally sensitive target and identity metadata; use it only in authorized UI or protected storage, never indiscriminate logs or public diagnostics.

### Authentication strategies (closed set, no fallback)

- **SQL login** — username plus a `SecretFileReference` (never a plaintext password field). One read-only `SecureString` and its exact `SqlCredential` are cached per stable SQL-login profile configuration and retained for the matching SqlClient pool's lifetime; neither enters a connection string. Call `InvalidateSqlLoginProfileAsync` after rotating a mounted password secret (or restart the process). Invalidation clears that credential's pool before zeroing the old password and defers zeroing until every returned `SqlConnectionOpenResult` is disposed. If the pool clear itself fails, invalidation throws instead of zeroing the password anyway, and the cached credential remains valid and reusable for retry. Without explicit invalidation or restart, a mounted password rotation is not observed.
- **Linux Kerberos service identity (Integrated Security/SSPI)** — uses the container's own Kerberos identity. There is no interactive/browser user delegation and nothing falls back to SQL login if Kerberos fails. Deployment requires:
  - a keytab file mounted as a Docker/Compose secret (never baked into an image or committed to source);
  - `KRB5_CONFIG` pointing at a `krb5.conf` that names the realm and KDC;
  - `KRB5_KTNAME` pointing at that mounted keytab;
  - a `MSSQLSvc/<target FQDN>:<port>` service principal name registered for the SQL Server target (for example `MSSQLSvc/sql01.internal.example.com:1433`);
  - working forward and reverse DNS for the target FQDN, and clock synchronization with the KDC (Kerberos rejects clock skew beyond a small tolerance, commonly five minutes).
- **Microsoft Entra ID** (`ManagedIdentity`, `WorkloadIdentity`, `ServicePrincipalCertificate`, `ServicePrincipalSecret`) — every strategy maps to exactly one explicit `Azure.Core.TokenCredential` (`ManagedIdentityCredential`, `WorkloadIdentityCredential`, `ClientCertificateCredential`, or `ClientSecretCredential`). **`DefaultAzureCredential` and any other credential chain are never used** — a static test asserts this. There is no interactive/browser sign-in flow.

  `AccessTokenCallback` is itself part of `Microsoft.Data.SqlClient`'s connection pool key (see the [official `AccessTokenCallback` documentation](https://learn.microsoft.com/sql/connect/ado-net/sql/azure-active-directory-authentication#using-accesstokencallback)): a fresh delegate per connection would silently open one physical pool per connection instead of sharing one pool per security context. This library therefore resolves one `TokenCredential` and builds its `AccessTokenCallback` delegate exactly once per stable Entra security context — keyed by profile id, connection string, and every strategy-specific identifier or secret reference (managed-identity client id, tenant/client id, federated token file path, or certificate/secret file reference) — and reuses that exact same delegate instance for every sequential and concurrent open of that profile, mirroring the SQL-login credential cache above. The callback's token scope is derived from `SqlAuthenticationParameters.Resource` at call time (appending `/.default` only if the resource doesn't already carry it), exactly as the official example does, instead of a hardcoded `https://database.windows.net/.default` literal, so sovereign-cloud resources (for example Azure Government or Azure China) resolve to their own resource's scope. Every other `SqlAuthenticationParameters` field is intentionally ignored, since the explicit strategy above already fixes tenant, client, and identity, and honoring a server-supplied override of those would let the server choose the security context instead of the profile. The resulting token never appears in a connection string, log, or exception. Deployment requires outbound HTTPS reachability to:
  - the Entra token endpoint, `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token` (or the equivalent Entra ID endpoint for the deployment's cloud environment);
  - for `ManagedIdentity` only, the Azure Instance Metadata Service (IMDS) at `http://169.254.169.254/metadata/identity/oauth2/token`, reachable only from within Azure compute — this strategy cannot succeed outside Azure;
  - for `WorkloadIdentity`, the platform-projected federated token file (normally `AZURE_FEDERATED_TOKEN_FILE`, overridable per profile) must be present and refreshed by the platform; this library re-reads it on every token request and does nothing extra to handle rotation;
  - for `ServicePrincipalCertificate`/`ServicePrincipalSecret`, the certificate (PKCS#12/PFX) or client secret is read once per cached security context (not once per connection) from a `SecretFileReference`, never held as a plaintext field on the strategy type. `ServicePrincipalCertificate`'s PFX private key is never converted to a `string`; `ServicePrincipalSecret`'s client secret must become a `string` because `ClientSecretCredential`'s constructor only accepts one, so it is not zeroable and is pinned until process exit — prefer the certificate strategy for new deployments. Rotating either requires an explicit `InvalidateEntraProfileAsync` call (or a process restart) before the new certificate or secret takes effect, exactly like SQL-login password rotation. Invalidation clears the associated pool before disposing any certificate this library owns, defers that disposal until every returned `SqlConnectionOpenResult` is disposed, and — like SQL-login invalidation — throws instead of disposing the certificate if the pool clear itself fails, leaving the cached lease valid and reusable for retry. Disposing the factory (`DisposeAsync`) retires every cached SQL-login and Entra lease the same way, collecting any pool-clear failures across all of them into one `AggregateException` rather than swallowing them.

### Secret resolution (`ISecretFileProvider`)

Secret references are simple file names only (no path separators, drive letters, or `.`/`..` segments — rejected at construction, before any file-system access) resolved under one configured directory (default `/run/secrets`, the conventional Docker/Compose secrets mount). Every candidate path is canonicalized and re-checked against that directory as defense in depth. Reads are size-bounded (default 16 KiB) and never log secret content. Both SQL-login passwords and Entra certificate/client-secret material are read exactly once per stable security context, when that context's credential lease is first created, and reused — not re-read per connection — until explicit invalidation or process restart. A missing, unreadable, oversized, or invalid (non-UTF-8, where text is expected) secret fails closed with `SecretResolutionException` — never a partially usable value and never a fallback to another authentication mode, and a failed read is never cached, so the next attempt retries the read.

### `TrustServerCertificate` and encryption policy

Every profile sets an explicit `EncryptionPolicy` — `Mandatory` (TLS required; supported since SQL Server 2019) or `Strict` (TDS 8.0 strict TLS; requires SQL Server 2022+ or Azure SQL) — there is no "optional" encryption. `TrustServerCertificate` is a per-profile opt-in only for `Mandatory`; it is never inherited, defaulted, or applied globally. `Strict` plus `TrustServerCertificate=true` is rejected because SqlClient ignores that trust bypass in Strict mode. Every accepted trust bypass surfaces a `ConnectionWarning.TrustServerCertificateEnabled` on that connection's result.

### Package versions

- `Microsoft.Data.SqlClient` 7.0.2
- `Azure.Identity` 1.21.0
- `Azure.Core` 1.61.0

SqlClient 7 removed Entra ID authentication providers from its core package into `Microsoft.Data.SqlClient.Extensions.Azure`; this library does not take that dependency because it authenticates through `SqlConnection.AccessTokenCallback` plus directly constructed `Azure.Identity` credentials, a core-SqlClient mechanism unrelated to the extracted `Authentication=Active Directory ...` connection-string modes.

## Reporting

Report suspected vulnerabilities privately through the repository owner's GitHub security advisory channel. Do not include real credentials, query text, customer names, or production snapshots in a report. Include the affected version, reproduction steps using synthetic data, and expected impact.
