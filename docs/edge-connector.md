# SQLSimCity edge connector

The edge connector monitors SQL Servers that the central SQLSimCity container **cannot reach**. A
small connector process runs near SQL Server, connects **outward** to a configured central ingestion
endpoint over HTTPS, and forwards the same source-neutral observations the built-in collectors
produce. It never accepts inbound control, never centralizes SQL credentials, and never mutates SQL
Server.

This document covers deployment, security, and operations. For the transport contract and internals,
see the `SqlSimCity.Edge` and `SqlSimCity.Edge.Connector` projects.

> **No live SQL target validated.** As with the rest of SQLSimCity, the connector ships with a
> deterministic fixture observation provider and has been validated end to end against fixtures and a
> fake HTTP collector only. The connected `SqlSimCity.Collection` provider is the intended production
> path; no real SQL Server was contacted during development.

## Architecture

```text
[ SQL Server ] <-- read-only --> [ edge connector ]  --HTTPS + HMAC-->  [ central SQLSimCity ]
                                   |  bounded encrypted spool                 |  opt-in POST /api/v1/edge/ingest
                                   |  outward only, no inbound API            |  verify -> validate -> ingest
                                                                              |  assemble generations -> read endpoints
```

- The connector packages evidence into a versioned **observation envelope** (`ObservationEnvelopeV1`)
  and batches (`ObservationBatchV1`): opaque connector/target ids, per-target sequence, boot epoch,
  captured time, section/chunk type, content digest, idempotency key, compression, and source
  freshness. Raw SQL and Showplan XML are never transmitted; text and plans are normalized/redacted by
  the producing seam before they reach the envelope.
- Delivery is **durable and ordered**: every batch is sealed into a bounded AES-256-GCM spool first,
  then drained oldest-first. Offline windows never lose evidence up to the spool bound.
- The central server ingests only when **explicitly enabled**. The normal application stays GET-only;
  ingestion adds exactly one bounded `POST /api/v1/edge/ingest`.

## Security model

- **Transport.** HTTPS only. Plain HTTP is refused unless the endpoint is an explicit loopback
  development address (`SQLSIMCITY_EDGE_ALLOW_LOOPBACK_HTTP=true`). The connector disables HTTP
  redirect following so a downgrade to `http://` cannot be forced.
- **Authentication.** Each request is signed with **HMAC-SHA-256** over a canonical string of method,
  path, timestamp, nonce, connector id, key id, and the body's SHA-256 digest. The central server
  verifies in constant time, enforces a bounded clock skew, rejects connectors not on its allowlist,
  rejects unknown key ids, and persists accepted nonces to a durable journal so a captured request
  cannot be replayed even across a central restart.
- **Secrets are files, never environment plaintext.** The connector's HMAC secret and spool key are
  read from files/Docker secrets. The central allowlist and per-connector secrets come from a catalog
  file plus a secrets directory. There is no fallback secret and no `DefaultAzureCredential`/interactive
  auth anywhere in this path.
- **Key rotation.** A connector key id lets old and new secrets overlap: add the new key to the
  central catalog, roll the connector's `SQLSIMCITY_EDGE_KEY_ID` and secret file, then retire the old
  catalog entry.
- **Spool encryption.** Spooled batches are AES-256-GCM sealed with a **separate** mounted key,
  written atomically (temp + rename), one writer, no symlink/traversal/special files. A wrong or
  corrupt key fails closed.
- **Central hardening.** The ingest endpoint enforces strict `Content-Type`/`Content-Length`, a body
  bound, a rate limit, schema/digest/signature/sequence/epoch validation, safe gzip decompression
  (compression-bomb guarded), atomic all-or-nothing persistence, idempotent duplicate acceptance, and
  conflict rejection. Curated errors never echo secrets, headers, or payloads.

## Central configuration (`EdgeIngestion` section)

Disabled by default. Enable with:

| Setting | Meaning |
| --- | --- |
| `EdgeIngestion:Enabled` | `true` to map the ingestion endpoint. |
| `EdgeIngestion:SecretCatalogFile` | Path to the connector allowlist/secret catalog JSON. |
| `EdgeIngestion:SecretsDirectory` | Directory holding the per-connector secret files. |
| `EdgeIngestion:NonceJournalPath` | Durable replay-nonce journal path (persist across restarts). |
| `EdgeIngestion:ClockSkewSeconds` | Allowed timestamp skew (default 300). |
| `EdgeIngestion:MaxBatchBytes` | Maximum accepted batch body size (default 4 MiB). |

### Connector secret catalog

```json
{
  "formatVersion": 1,
  "connectors": [
    { "connectorId": "edge-a", "keys": [ { "keyId": "2026-08", "secretFile": "edge-a-hmac" } ] }
  ]
}
```

`secretFile` must be a **simple file name** resolved strictly under `SecretsDirectory`; path
separators, `..`, and rooted paths are rejected. Each secret file holds base64 of at least 32 bytes.

## Connector configuration (environment)

| Variable | Meaning |
| --- | --- |
| `SQLSIMCITY_EDGE_CONNECTOR_ID` | Opaque connector identity (must be allowlisted centrally). |
| `SQLSIMCITY_EDGE_TARGET_ID` | Opaque monitored-target identity. |
| `SQLSIMCITY_EDGE_KEY_ID` | Signing key id (for rotation). |
| `SQLSIMCITY_EDGE_INGEST_ENDPOINT` | Absolute central ingestion URL (HTTPS in production). |
| `SQLSIMCITY_EDGE_SIGNING_SECRET_FILE` | File holding the base64 HMAC secret. |
| `SQLSIMCITY_EDGE_SPOOL_DIR` | Spool directory (a bounded volume). |
| `SQLSIMCITY_EDGE_SPOOL_KEY_FILE` | Separate AES-256 spool key file. |
| `SQLSIMCITY_EDGE_FIXTURES_DIR` | Directory of the validated fixtures the connector forwards. |
| `SQLSIMCITY_EDGE_COLLECT_INTERVAL_SECONDS` | Collection cadence (default 15). |
| `SQLSIMCITY_EDGE_DELIVER_INTERVAL_SECONDS` | Delivery cadence (default 5). |
| `SQLSIMCITY_EDGE_SPOOL_MAX_BYTES` / `_MAX_ITEMS` / `_MAX_AGE_SECONDS` | Spool bounds. |
| `SQLSIMCITY_EDGE_ALLOW_LOOPBACK_HTTP` | Allow plain HTTP only for a loopback dev endpoint. |
| `SQLSIMCITY_EDGE_LOOPBACK_HEALTH_PORT` | Optional loopback-only generic health port (0 disables). |

Spool key file format:

```json
{ "formatVersion": 1, "keyVersion": 1, "key": "<base64 of exactly 32 bytes>" }
```

## Backpressure and cadence

- Bounded collection and delivery loops never overlap a cycle with the previous one.
- Exceeding a spool bound applies **explicit backpressure** (the batch is rejected and the connector
  reports paused) — never a silent drop. Age-based pruning reports a `droppedByAge` count.
- Transient failures back off exponentially with jitter. `429` honors `Retry-After`. A `413` splits
  the batch at existing chunk boundaries and re-spools the halves. An authentication failure **stops**
  delivery instead of retry-storming; it clears when credentials are corrected.
- On shutdown the connector performs one bounded final drain; anything unsent stays safely spooled for
  the next run.

## Least-privilege SQL grants

The connector uses the same read-only collection as connected central mode. Grant the connector login
`VIEW SERVER STATE` + `VIEW DATABASE STATE` (SQL Server 2016–2019) or `VIEW SERVER PERFORMANCE STATE`
+ `VIEW DATABASE PERFORMANCE STATE` (SQL Server 2022+), plus `CONNECT` to each collected database.
SQLSimCity never executes grants. See the main `README.md` and `SECURITY.md`.

## Central read endpoints

When enabled, the central server also exposes read-only, `no-store` status:

- `GET /api/v1/edge/status` and `GET /api/v1/edge/targets` — per-target status (connector id, last
  sequence, epoch, freshness, published sections). Generic; no secrets.
- `GET /api/v1/edge/targets/{targetId}/sections/{section}` — the reconstructed observation generation
  for one delivered section.

The central UI adds a source/status panel from these; existing analysis surfaces are unchanged. A
connector that stops delivering goes stale/disconnected in status; the central Live UI does not claim
a continuous trace from a cadence-based edge feed.

## Spool backup is not a delivery guarantee

The spool bounds evidence retention: exceeding max bytes/items applies backpressure, and batches older
than the max age are dropped (reported, never silent). Copying the spool volume does **not** guarantee
delivery — sealed batches are only readable with the spool key, and an outage longer than the spool's
bounds necessarily drops the oldest evidence. Size the bounds for your longest expected outage.

## Troubleshooting

- **`401` from central:** connector not allowlisted, unknown key id, clock skew beyond bound, replayed
  nonce, wrong secret, or body/digest mismatch. Check the catalog, the connector's `KEY_ID`, and clock
  sync; rotate the secret if compromise is suspected.
- **`409` from central:** sequence rollback, a retired epoch replay, a reused batch id with different
  content, or a target already owned by another connector. Confirm the connector/target id mapping.
- **`413` from central:** batch exceeds `MaxBatchBytes`; the connector splits and retries automatically.
- **Connector `paused` / `droppedByAge` > 0:** the central endpoint has been unreachable long enough to
  fill or age out the spool. Restore connectivity or raise the spool bounds.
- **HTTP refused at startup:** the endpoint is not HTTPS and is not a loopback dev address.
