# Telemetry fixture pack v1

This is a self-contained, dependency-free fixture pack for future SQLSimCity
.NET and TypeScript tests. Every identifier, database name, query shape, source
label, timestamp, and numeric value is synthetic and sanitized. It contains no
production connection strings, credentials, hosts, or customer data.

## Documents

- `target-capabilities.json` records target/platform capabilities. Every
  capability has an explicit state: `supported`, `unsupported`, `not-probed`,
  or `permission-denied`; it is never inferred from a missing Boolean.
- `database-query-store.json` captures database Query Store state separately
  from its availability, including requested versus actual state and quota
  reason `65536`.
- `atlas-projection.json` is a sanitized eight-database inventory. `zero` is a
  measured zero allocation; `unknown` is deliberately null, never zero.
- `query-store-runtime.json` models aggregate pitfalls and plan features.
  Durations are microseconds, and the supplied weighted mean is derived from
  executions, not the mean of means.
- `live-cases.json` models race-prone live DMV observations, wait task context,
  blocking, plan availability, Azure SQL Database scope, memory grants
  (including the `grant_time IS NULL` still-waiting state), tempdb file/
  session/task usage, per-file cumulative I/O counters, per-scheduler
  cumulative CPU/delay counters, transaction log space, and the server
  identity fact (`sqlServerStartTimeUtc`) used as the counter-delta epoch
  marker.
- `cross-database-evidence.json` keeps confidence and rationale alongside each
  relationship instead of treating every inferred edge as fact.

## Schemas and units

`schema/common.schema.json` defines reusable JSON Schema 2020-12 terms for
availability, confidence, freshness, timestamps, exact bytes/pages, durations,
sources, availability reasons, and stable compound IDs.
`schema/fixture-document.schema.json` defines the versioned document envelope.
The Node test intentionally performs domain validation in addition to parsing;
it is not a JSON Schema implementation.

All timestamps are UTC ISO 8601. `Bytes` are exact bytes, `KiB` are binary
(1 KiB = 1024 bytes), pages are 8 KiB SQL Server pages, durations called
`Microseconds` use us, and durations called `Milliseconds` use ms.

## Cross-file invariants

- The atlas contains exactly the eight documented databases.
- Ledger and warehouse have equal known allocations; sales is larger.
- Zero allocation and unavailable allocation remain distinguishable.
- Query Store's active duplicate rows sum to 47 executions.
- A weighted duration uses `sum(executions * mean) / sum(executions)`.
- A plan's recency comes from `lastExecutionAt`, not its numeric plan ID.
- `-5` is a blocking sentinel, not a normal session link.

## Official references

- [Query Store catalog views](https://learn.microsoft.com/sql/relational-databases/system-catalog-views/sys-database-query-store-options-transact-sql)
- [Query Store runtime statistics](https://learn.microsoft.com/sql/relational-databases/system-catalog-views/sys-query-store-runtime-stats-transact-sql)
- [Blocking session ID semantics](https://learn.microsoft.com/sql/relational-databases/system-dynamic-management-views/sys-dm-exec-requests-transact-sql)
- [Waiting tasks](https://learn.microsoft.com/sql/relational-databases/system-dynamic-management-views/sys-dm-os-waiting-tasks-transact-sql)
- [Parameter Sensitive Plan optimization](https://learn.microsoft.com/sql/relational-databases/performance/parameter-sensitive-plan-optimization)
- [Optional Parameter Plan Optimization](https://learn.microsoft.com/sql/relational-databases/performance/optional-parameter-optimization)
- [Azure SQL Database DMV differences](https://learn.microsoft.com/azure/azure-sql/database/monitoring-with-dmvs)

Run validation with `node --test fixtures/v1/test/validate-fixtures.test.mjs`.
