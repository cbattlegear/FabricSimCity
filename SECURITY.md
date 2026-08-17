# Security policy

## Foundation threat model

This repository currently serves deterministic fixtures. `SqlSimCity.Api` has no SQL Server connector, credentials, login, user account, analytics, or telemetry wired into it. A separate, opt-in `SqlSimCity.SqlServer` library (see below) provides source-neutral connection and authentication building blocks for a future collector, but nothing in the running application calls it yet. An optional encrypted protected storage layer exists (see below) but is disabled by default and unused by this release's fixture path. The intended future collector is read-only, but that intent is not yet a security control.

The application exposes operational-shaped evidence to every client that can reach it. **There is no authentication or authorization.** Run the default Compose configuration on loopback or another explicitly trusted network only. Do not publish port 8080 on all interfaces or place the service on the public internet.

Security headers enforce a same-origin baseline: no permissive CORS, no remote scripts, no `unsafe-eval`, and locked-down object, base, and frame-ancestor policies. SignalR uses same-origin `connect-src 'self'`. Health probes return only generic status and no target identity.

## Data and storage

The `/data` mount now hosts an optional encrypted protected storage layer for future SQL Server collection metadata. It is **disabled by default**; this release ships no SQL Server connector and nothing writes to `/data` unless an operator explicitly enables it and provides a key. A standard Docker named volume is not application-level encryption by itself; protected storage's AES-256-GCM envelope is what makes retained bytes unreadable without the key, and the volume must still be backed up and access-controlled like any other data at rest.

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

### Still missing: SQL Server collection

`SqlSimCity.SqlServer` (see below) is a connection and authentication library only: it opens a validated, authenticated `SqlConnection` and nothing else. It is not wired into `SqlSimCity.Api`, executes no SQL, and does not discover topology, retain history, or perform collection. Everything below remains true of the running application until a collector is built on top of this library:

- use a least-privilege, read-only SQL Server principal and document every required permission;
- keep target secrets out of images, source, logs, URLs, and atlas responses;
- introduce authentication and authorization before non-loopback deployment;
- write any retained per-target credentials or collected evidence through protected storage rather than a new unencrypted table;
- fail closed when authentication, key retrieval, integrity validation, or encrypted storage is unavailable, matching protected storage's existing fail-closed behavior;
- distinguish permission denial, unsupported capability, disconnection, staleness, and unknown data rather than substituting zero;
- avoid logging query text or other potentially sensitive workload content by default.

Supported host targets are Linux containers on x86-64 and ARM64 using official .NET 10 images. Browser targets are current Chromium, Firefox, and Safari. Real SQL Server versions are not yet supported because this release performs no collection; future support claims require versioned fixtures and integration verification.

## SQL Server connection and authentication

`SqlSimCity.SqlServer` builds and opens `SqlConnection`s from an immutable, validated `ConnectionProfile`. It has no fallback between authentication strategies: a strategy either succeeds on its own terms or the connection attempt fails. Every connection is built through `SqlConnectionStringBuilder` only; a password or Entra token is never concatenated into a connection string, logged, or returned from the diagnostic `SafeConnectionSettings` DTO.

### Authentication strategies (closed set, no fallback)

- **SQL login** — username plus a `SecretFileReference` (never a plaintext password field). The password is read once per connection attempt and handed to `SqlCredential`, never the connection string.
- **Linux Kerberos service identity (Integrated Security/SSPI)** — uses the container's own Kerberos identity. There is no interactive/browser user delegation and nothing falls back to SQL login if Kerberos fails. Deployment requires:
  - a keytab file mounted as a Docker/Compose secret (never baked into an image or committed to source);
  - `KRB5_CONFIG` pointing at a `krb5.conf` that names the realm and KDC;
  - `KRB5_KTNAME` pointing at that mounted keytab;
  - a `MSSQLSvc/<target FQDN>:<port>` service principal name registered for the SQL Server target (for example `MSSQLSvc/sql01.internal.example.com:1433`);
  - working forward and reverse DNS for the target FQDN, and clock synchronization with the KDC (Kerberos rejects clock skew beyond a small tolerance, commonly five minutes).
- **Microsoft Entra ID** (`ManagedIdentity`, `WorkloadIdentity`, `ServicePrincipalCertificate`, `ServicePrincipalSecret`) — every strategy maps to exactly one explicit `Azure.Core.TokenCredential` (`ManagedIdentityCredential`, `WorkloadIdentityCredential`, `ClientCertificateCredential`, or `ClientSecretCredential`). **`DefaultAzureCredential` and any other credential chain are never used** — a static test asserts this. The resulting token is supplied only through `SqlConnection.AccessTokenCallback` for the `https://database.windows.net/.default` scope; it never appears in a connection string, log, or exception. There is no interactive/browser sign-in flow. Deployment requires outbound HTTPS reachability to:
  - the Entra token endpoint, `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token` (or the equivalent Entra ID endpoint for the deployment's cloud environment);
  - for `ManagedIdentity` only, the Azure Instance Metadata Service (IMDS) at `http://169.254.169.254/metadata/identity/oauth2/token`, reachable only from within Azure compute — this strategy cannot succeed outside Azure;
  - for `WorkloadIdentity`, the platform-projected federated token file (normally `AZURE_FEDERATED_TOKEN_FILE`, overridable per profile) must be present and refreshed by the platform; this library re-reads it on every token request and does nothing extra to handle rotation;
  - for `ServicePrincipalCertificate`/`ServicePrincipalSecret`, the certificate (PKCS#12/PFX) or client secret is read once per connection attempt from a `SecretFileReference`, never held as a plaintext field on the strategy type.

### Secret resolution (`ISecretFileProvider`)

Secret references are simple file names only (no path separators, drive letters, or `.`/`..` segments — rejected at construction, before any file-system access) resolved under one configured directory (default `/run/secrets`, the conventional Docker/Compose secrets mount). Every candidate path is canonicalized and re-checked against that directory as defense in depth. Reads are size-bounded (default 16 KiB), happen once per connection attempt, and never log secret content. A missing, unreadable, oversized, or invalid (non-UTF-8, where text is expected) secret fails closed with `SecretResolutionException` — never a partially usable value and never a fallback to another authentication mode.

### `TrustServerCertificate` and encryption policy

Every profile sets an explicit `EncryptionPolicy` — `Mandatory` (TLS required; supported since SQL Server 2019) or `Strict` (TDS 8.0 strict TLS; requires SQL Server 2022+ or Azure SQL) — there is no "optional" encryption. `TrustServerCertificate` is a per-profile opt-in only; it is never inherited, defaulted, or applied globally, and enabling it always surfaces a `ConnectionWarning.TrustServerCertificateEnabled` on that connection's result, regardless of encryption policy.

### Package versions

- `Microsoft.Data.SqlClient` 7.0.2
- `Azure.Identity` 1.21.0
- `Azure.Core` 1.61.0

SqlClient 7 removed Entra ID authentication providers from its core package into `Microsoft.Data.SqlClient.Extensions.Azure`; this library does not take that dependency because it authenticates through `SqlConnection.AccessTokenCallback` plus directly constructed `Azure.Identity` credentials, a core-SqlClient mechanism unrelated to the extracted `Authentication=Active Directory ...` connection-string modes.

## Reporting

Report suspected vulnerabilities privately through the repository owner's GitHub security advisory channel. Do not include real credentials, query text, customer names, or production snapshots in a report. Include the affected version, reproduction steps using synthetic data, and expected impact.
