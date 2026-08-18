# Changelog

All notable changes to SQLSimCity are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

SQLSimCity is independent software and is not affiliated with, sponsored by, or
endorsed by Microsoft, Electronic Arts, Maxis, the SimCity franchise, or the
PGSimCity project. No SimCity assets are included.

## [Unreleased]

First MVP release candidate. There is no tagged release yet.

### Added

- Fixture-mode and opt-in read-only connected server **atlas** (`/api/v1/atlas`,
  `/api/v1/atlas/status`) with a three.js scene backed by a keyboard- and
  screen-reader-accessible database evidence table.
- **Database-city semantic zoom** (`/api/v1/database-city`, `/api/v1/database-city/{databaseId}`)
  with exact page geometry, separated direct-DMV and Query-Store-attributed heat,
  and confidence-graded co-reference routes.
- **Live-incident** point-in-time DMV sampling (`/api/v1/live`) and a
  `/hubs/current-snapshot` SignalR hub, with explicit freshness/staleness and
  never-numeric-zero unavailable states.
- Encrypted, paged **Query Store history** (`/api/v1/query-store/*`) with plan
  history, a hardened Showplan parser (DTD/resolver prohibited, bounded), and
  structural plan comparison from sanitized fixtures.
- Evidence-backed **findings** engine and read-only API (`/api/v1/findings/*`)
  with redacted export.
- Source-neutral SQL Server connection library with SQL/Kerberos/Microsoft Entra
  authentication and file-referenced secrets.
- Optional AES-256-GCM encrypted SQLite record store (disabled by default) with
  fail-closed initialization, key rotation, and bounded retention/pruning.
- Versioned static, read-only SQL probe catalog (`sql/manifest.json` + `sql/probes/*.sql`).
- HTTP hardening: `AllowedHosts` pinning, strict CSP and security headers,
  64-KiB request-body bounds, and per-client API rate limiting that excludes the
  long-lived SignalR hub.
- Container hardening (non-root, dropped capabilities, read-only rootfs,
  `no-new-privileges`, loopback binding), locked dependencies, CI/release
  workflows with SBOM and provenance attestation, Docker fixture smoke, and
  backup/restore tooling with operations documentation.

### Changed

- Frontend build is code-split: the three.js atlas/city viewports and the Query
  Store, Live, and Findings tabs load as lazy chunks, and three.js is isolated
  into its own vendor chunk. The initial-path bundle drops from ~848 KiB to
  ~220 KiB and three.js is no longer on the first-paint critical path.
- The Query Store `database_workload_summary` probes now bound the runtime-stats
  interval join by overlap (`end_time > @StartTime AND start_time < @EndTime`),
  matching `runtime_stats_summary` and `wait_stats_summary`, so the atlas
  database-wide totals reconcile with the per-plan drill-down over the same window.

### Fixed

- A rejected lazy-chunk import no longer unmounts the application: every lazy
  surface is wrapped in an error boundary that renders a focused, announced
  alert with a reload action.

### Security

- A persistent, color-independent trusted-network / no-built-in-login notice is
  now shown on every analysis view, including on mobile, reinforcing the
  documented `AllowedHosts` and reverse-proxy guidance.

### Known limitations

- **No live SQL Server execution has been validated.** Connected-mode collection
  is exercised only against fakes and deterministic fixtures; no real SQL Server,
  Azure SQL Database, or Managed Instance target was available for end-to-end
  validation.
- GHCR image publication, SBOM, and provenance attestation are defined in the
  release workflow but are not executed as part of this candidate; their outputs
  are unverified until a tagged release runs.
- Behind a reverse proxy, forwarded-header processing is intentionally disabled,
  so API rate-limit partitioning collapses all clients into one bucket. This is
  correct for the documented loopback/trusted-network model.
