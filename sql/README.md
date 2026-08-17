# SQL probe catalog

This directory is a self-contained, strictly read-only catalog of T-SQL probes intended
for future collection via `Microsoft.Data.SqlClient`. It has no dependency on any
application code in this repository -- it is pure `.sql` text plus a JSON manifest
describing how to run each file safely.

- `manifest.json` -- one entry per probe: id, file path, connection scope, minimum
  platform, required permission, cadence class, parameters, result contract summary,
  relative cost, and Azure SQL Database support/limitations.
- `probes/` -- the T-SQL files themselves, one probe (one logical unit of collection)
  per file, grouped by capability.

Nothing under `sql/` executes automatically. A future collector is expected to load
`manifest.json`, read the referenced file, bind the declared `SqlParameter`s by name,
and execute it with `Microsoft.Data.SqlClient`.

## Design rules every probe file follows

1. **Static SQL only.** Every probe is a `SELECT` / `CTE` / `APPLY` pipeline, optionally
   preceded by safe session `SET` statements. No dynamic SQL (`sp_executesql`,
   string-built `EXEC`), no `USE` with an interpolated name, no DDL/DML
   (`ALTER`/`CREATE`/`DROP`/`INSERT`/`UPDATE`/`DELETE`/`MERGE`/`TRUNCATE`/`GRANT`/`DENY`/
   `REVOKE`), no `DBCC`, and no Query Store administrative procedures
   (`sp_query_store_force_plan`, `sp_query_store_remove_*`, `ALTER DATABASE ... SET
   QUERY_STORE CLEAR`, etc.). Runtime values are always named parameters (`@Name`) that
   map 1:1 to `SqlParameter` objects the collector supplies -- never string concatenation.
2. **Safe session settings first.** Every file starts with
   `SET NOCOUNT ON; SET DEADLOCK_PRIORITY LOW; SET LOCK_TIMEOUT 5000;` so a probe can
   never out-wait or out-prioritize real application work, and a runaway lock wait fails
   fast instead of hanging the collector. No probe sets
   `READ UNCOMMITTED`/`NOLOCK` by default; DMV/catalog-view reads are already
   effectively lock-free snapshots of engine-maintained counters, so there is nothing to
   gain from relaxed isolation and doing so would risk seeing torn, cross-index
   inconsistent data on any lower-cost catalog joins a probe does perform (for example
   joining `sys.indexes` to a DMV).
3. **No eager plan XML.** Live-session and memory-grant probes resolve
   `plan_handle`/`sql_handle` to text via `sys.dm_exec_sql_text`, but never
   `CROSS/OUTER APPLY sys.dm_exec_query_plan`. A single query plan can be tens of KB of
   XML; fetching it for every row of a live-session sweep turns a cheap poll into an
   expensive one. If a future collector needs a plan, it should be a separate,
   explicitly-requested, single-plan lookup.
4. **Root-blocker inputs, not root-blocker answers.** `sessions/blocking_inputs.sql`
   returns raw blocked-request and idle-open-transaction facts, preserving
   `blocking_session_id` exactly as the engine reports it (including the negative
   sentinel values). It does not walk the chain or decide which session is the root
   blocker -- that graph-construction logic belongs in the application, where it can be
   tested independently of any one server's live state.
5. **Bounded cost.** Any probe whose cost scales with database size takes an explicit,
   required parameter that bounds it: `index.operational_stats` requires `@ObjectId`
   (passing `NULL` there forces a resource-intensive whole-database enumeration per
   Microsoft's own documentation); the Query Store summaries require a time window
   (`@StartTime`/`@EndTime`) or `@TopN`.

## Permissions: SQL Server 2019 vs. SQL Server 2022+

Microsoft split several coarse-grained `VIEW SERVER STATE` / `VIEW DATABASE STATE`
permissions into more specific ones in SQL Server 2022 (16.x). This catalog's
diagnostic probes generally follow this pattern:

| Probe family | SQL Server 2016-2019 | SQL Server 2022+ |
| --- | --- | --- |
| Server/session/task/scheduler/memory-grant/file-IO DMVs (`sys.dm_exec_sessions`, `sys.dm_exec_requests`, `sys.dm_os_waiting_tasks`, `sys.dm_os_schedulers`, `sys.dm_exec_query_memory_grants`, `sys.dm_io_virtual_file_stats`, `sys.dm_db_task_space_usage`, `sys.dm_db_session_space_usage`) | `VIEW SERVER STATE` | `VIEW SERVER PERFORMANCE STATE` |
| Query Store catalog views (`sys.database_query_store_options`, `sys.query_store_*`) | `VIEW DATABASE STATE` | `VIEW DATABASE PERFORMANCE STATE` (or `VIEW DATABASE STATE`, which still covers it) |
| `sys.dm_db_file_space_usage`, `sys.dm_db_log_space_usage` | `VIEW DATABASE STATE` | `VIEW DATABASE PERFORMANCE STATE` |
| `sys.dm_db_index_usage_stats` | `VIEW SERVER STATE` (server/MI); Azure SQL DB: server admin/Entra admin/`##MS_ServerStateReader##` on Basic/S0/S1/elastic pool, else `VIEW DATABASE STATE`/`##MS_ServerStateReader##` | `VIEW SERVER PERFORMANCE STATE` (server/MI); same Azure SQL DB rules as the prior column |
| `sys.dm_db_index_operational_stats` (single object, this catalog's usage) | `CONTROL` on the specified object | `CONTROL` on the specified object |
| `sys.databases`, `SERVERPROPERTY()` | none (public) | none (public) |

Whole-database or whole-server calls to `sys.dm_db_index_operational_stats` (passing `NULL`
for `@ObjectId`/`@DatabaseId`, which this catalog's probe deliberately never does) instead
require `VIEW DATABASE STATE`/`VIEW DATABASE PERFORMANCE STATE` or
`VIEW SERVER STATE`/`VIEW SERVER PERFORMANCE STATE` respectively, and those grants/denies
override a per-object `CONTROL` grant/deny.

Each probe file's header comment and the matching `manifest.json` entry state its exact
requirement; this table is a summary, not a substitute for either.

### Azure SQL Database scope limitations

- **`sys.databases`** (`server.database_discovery`) visibility depends on connection
  context and permission, not a blanket restriction. Connected to `master` with
  sufficient permission (server admin, Microsoft Entra admin, or an equivalent role),
  it can enumerate every database visible on the logical server. Connected to a user
  database instead, it returns only `master` and that database itself. A collector that
  needs full-server enumeration on Azure SQL Database should open its `master`
  connection specifically for this probe.
- **`sys.dm_db_index_usage_stats`** requires the server admin account, a Microsoft Entra
  admin account, or `##MS_ServerStateReader##` server-role membership on Basic/S0/S1
  tiers and databases in an elastic pool; other service tiers require `VIEW DATABASE
  STATE` or `##MS_ServerStateReader##` membership.
- **`sys.dm_os_sys_info`** (`server.identity`): `cpu_count`/`physical_memory_kb` on Azure
  SQL Database "might return the number of logical CPUs/total physical memory of the
  machine hosting the database or elastic pool" per Microsoft's documentation -- they do
  not reflect the tenant's assigned vCore/DTU capacity. Use
  `sys.dm_user_db_resource_governance.cpu_limit` (vCore purchasing model; `NULL` for DTU)
  and `sys.dm_os_job_object.process_memory_limit_mb` for the tenant's actual compute
  limits; both are Azure SQL Database-specific and intentionally out of scope for the
  cross-platform `server.identity` probe.
- **Session/request/memory-grant DMVs** (`sys.dm_exec_sessions`,
  `sys.dm_exec_requests`, `sys.dm_exec_query_memory_grants`) require `VIEW DATABASE
  STATE` on Azure SQL Database rather than `VIEW SERVER STATE`, and are filtered to the
  current tenant database's own sessions; `scheduler_id`, `wait_order`, `pool_id`, and
  `group_id` are filtered to `NULL` in `sys.dm_exec_query_memory_grants` to avoid
  exposing cross-tenant placement information.
- **`sys.dm_io_virtual_file_stats`** is restricted to the current database's own files
  on Azure SQL Database.
- **`sys.dm_os_schedulers`** works, but the visible scheduler count reflects the
  database's assigned vCore/DTU allocation, not a physical host's processor count, and
  the required permission on Basic/S0/S1 tiers and elastic pools is narrower (server
  admin, Microsoft Entra admin, or `##MS_ServerStateReader##` membership) than on other
  service objectives (`VIEW DATABASE STATE` or `##MS_ServerStateReader##`).
- **`tempdb.usage`** still applies: every Azure SQL Database has its own private
  `tempdb`.

See `manifest.json`'s per-probe `azureSqlDatabase` field for the authoritative,
per-probe statement. No probe in this catalog is flagged blanket-`unsupported` on Azure
SQL Database as of this revision; several instead document narrower visibility, a
different required permission, or a preference for a newer version-split variant.

## Units

- **Query Store duration and CPU time are MICROSECONDS.** This applies to
  `sys.query_store_query` (`avg_compile_duration`, `avg_bind_duration`,
  `avg_optimize_duration`, ...), `sys.query_store_plan` (`avg_compile_duration`,
  `last_compile_duration`), and `sys.query_store_runtime_stats` (`avg_duration`,
  `avg_cpu_time`, and their `min`/`max`/`last`/`stdev` variants).
- **Query Store wait time is MILLISECONDS.** `sys.query_store_wait_stats`
  (`total_query_wait_time_ms`, `avg_query_wait_time_ms`, ...) uses a different unit
  from the duration/CPU columns above -- do not mix them in a single comparison without
  converting.
- **Most other DMV time columns are MILLISECONDS**, including
  `sys.dm_exec_requests.total_elapsed_time`/`cpu_time`, `sys.dm_os_waiting_tasks.wait_duration_ms`,
  `sys.dm_io_virtual_file_stats.io_stall*`, `sys.dm_db_index_operational_stats.*_wait_in_ms`, and
  `sys.dm_db_log_space_usage`'s percentage (which is a 0-100 value, not a fraction).
- **Logical/physical reads and page counts are 8-KiB pages** wherever the underlying
  DMV documents them that way: `sys.query_store_runtime_stats.avg_logical_io_reads`,
  `sys.dm_exec_requests.logical_reads`, `sys.dm_db_file_space_usage`'s `*_page_count`
  columns, and `sys.database_files.size`/`max_size`/`growth`. Probes in this catalog
  convert page counts to MiB (`pages * 8.0 / 1024.0`) only when the column name says
  `_mb`; anything ending in `_page_count` or without a unit suffix is left as raw pages
  for the caller to convert.
- **`sys.dm_io_virtual_file_stats` byte columns are raw bytes**, not pages
  (`num_of_bytes_read`, `num_of_bytes_written`, `size_on_disk_bytes`).
- Binary units (KiB/MiB/GiB) are used throughout this documentation and in column
  aliases; SQL Server's own `KB`/`MB` naming in its DMVs is binary (1024-based) despite
  the decimal-looking suffix, and this catalog's `_mb` aliases follow the same
  convention.

## Timestamps

- Query Store timestamps (`sys.query_store_query.last_execution_time`,
  `sys.query_store_plan.last_execution_time`,
  `sys.query_store_runtime_stats_interval.start_time`/`end_time`, etc.) are
  `datetimeoffset` and represent the *end* time of an execution/interval, not the start,
  unless documented otherwise on the specific column.
- `sys.dm_exec_requests.start_time` and `sys.dm_os_sys_info.sqlserver_start_time` are
  plain `datetime` in server local time (no offset).
- `sys.dm_io_virtual_file_stats.sample_ms` and `sys.dm_os_schedulers`'s cumulative
  columns are milliseconds since the Database Engine's last restart, not wall-clock
  timestamps.

## Reset semantics (cumulative counters)

Most DMV counters in this catalog (`sys.dm_io_virtual_file_stats`,
`sys.dm_os_schedulers.total_cpu_usage_ms`/`total_scheduler_delay_ms`,
`sys.dm_db_index_usage_stats`) are **cumulative since the Database Engine's last
restart**, or since the specific index's last rebuild/creation, whichever is more
recent. `sys.dm_db_index_operational_stats` counters follow a different rule: they are
maintained only while the heap/B-tree's metadata-cache entry for that object exists in
memory, so they reset to zero whenever that metadata is (re)cached -- which includes,
but is not limited to, an engine restart -- and they disappear entirely when the
underlying object, index, or partition is dropped or truncated; certain other DDL
against the object can also reset the counters to zero without dropping anything. Do
not assume a long-standing `sys.dm_db_index_operational_stats` value implies a
long-uninterrupted server uptime the way the other cumulative-since-restart counters
in this catalog do. A collector computing a rate must:

1. Track the previous poll's counter value and its `sample_ms`/wall-clock time.
2. Detect a restart (a lower reading than the previous poll, or `sample_ms` resetting
   toward zero) and discard that delta instead of treating it as negative throughput.
3. Never assume a counter is a rate; every counter in this catalog is either a
   cumulative total or an instantaneous gauge (e.g. `current_tasks_count`), and the
   per-probe header comment says which.

Query Store's own rows are not "cumulative since restart" in the same sense: they are
scoped to an aggregation interval (`interval_length_minutes` in
`sys.database_query_store_options`, typically 60 minutes) and a fixed retention window
(`stale_query_threshold_days`), independent of engine restarts.

## Weighted aggregation and active-interval duplicates

Per Microsoft's own documentation, `sys.query_store_runtime_stats` and
`sys.query_store_wait_stats` can each return **more than one row** for the same
`(plan_id, runtime_stats_interval_id, execution_type[, wait_category][, replica_group_id])`
key when that interval is still the *currently active* one: typically one row already
flushed to disk and one or more rows still in memory. Both
`querystore/query_store_runtime_stats_summary_2016.sql`/`_2022.sql` and both
`querystore/query_store_wait_stats_summary_2017.sql`/`_2022.sql` files `GROUP BY` exactly
that key (including `replica_group_id` in the 2022+ variants) and `SUM()` across it, so
each row returned to the caller is already the correct, de-duplicated total for its
interval -- do not re-aggregate client-side by anything looser than that key, and do not
`AVG()` across rows that share the key (that would silently halve a total that Query
Store itself considers a single logical interval). On SQL Server 2022 (16.x)+, never drop
`replica_group_id` from that key: doing so combines a primary replica's runtime/wait
statistics with a secondary readable replica's under one inflated total.

"Weighted" total/average means execution-count-weighted:
`weighted_avg_duration_us = SUM(avg_duration * count_executions) / SUM(count_executions)`,
which is different from a naive `AVG(avg_duration)` across intervals or plans, because
each interval's `avg_duration` already represents a different number of executions.
`sys.query_store_wait_stats` has no `count_executions` column of its own, so the wait
probes join `sys.query_store_runtime_stats`'s execution count in separately (as
`total_count_executions`, grouped by `replica_group_id` too on the 2022+ variant) rather
than inventing a weight from wait-time columns alone. `total_query_wait_time_ms` and
`count_executions` are both `bigint`; both wait-stats probes explicitly `CAST` the
numerator to `decimal(19,4)` before dividing so the per-execution average is never
silently truncated to an integer by T-SQL's `bigint`/`bigint` division rule.

## Null / unavailable meanings

- A Query Store `wait_stats_capture_mode`/`capture_policy_*` column read from a probe
  targeting the 2016 base view is simply absent from the result set (the file doesn't
  select it) rather than `NULL` -- use `querystore.options_2019` when those columns are
  needed.
- `sys.query_store_plan.plan_forcing_type`/`plan_forcing_type_desc` do not exist as
  columns before SQL Server 2017 (14.x) -- selecting them on SQL Server 2016 (13.x)
  raises "Invalid column name", not `NULL`. `querystore.plan_summary_2016` is a true
  SQL Server 2016-only column set that omits them entirely; use
  `querystore.plan_summary_2017` (SQL Server 2017 (14.x) through 2019 (15.x)) or
  `querystore.plan_summary_2022` (SQL Server 2022 (16.x)+) when forcing-type columns
  are needed.
- `sys.dm_exec_requests.blocking_session_id` (and the same-named column in
  `sys.dm_os_waiting_tasks`): `NULL` or `0` means "not blocked, or the blocking
  session's identity is unavailable" -- these two cases are indistinguishable from this
  column alone. Negative values are documented sentinels, not real session ids:
  `-2` = an orphaned distributed transaction owns the resource, `-3` = a deferred
  recovery transaction owns the resource, `-4` = the blocking latch owner could not be
  determined because of an internal latch-state transition, `-5` = the blocking latch
  owner is not tracked for this latch type (commonly benign, e.g. SH latches).
- `sys.dm_db_index_usage_stats`: an index with **no row at all** has not been touched by
  a compiled plan since the engine last restarted (or since the index was last
  rebuilt/created) -- it does **not** mean the index is empty, unused forever, or safe
  to drop without checking a longer observation window.
- `sys.database_query_store_options`'s documented, authoritative signal for whether
  Query Store is enabled is `actual_state`/`actual_state_desc`. Microsoft's own
  documentation does not state that this view returns zero rows when Query Store was
  never enabled for a database; do not rely on row absence as a proxy for that -- check
  `actual_state_desc = 'OFF'` (or the query returning no row at all, which this catalog
  treats as "unknown/not queryable" rather than "never enabled") explicitly instead.

## Cadence and overhead boundaries

`manifest.json` assigns every probe a `cadenceClass`; the intent behind each class:

- **`realtime`** (sessions/waiting-tasks/blocking facts) -- safe to poll sub-minute; all
  three read from small, in-memory, fixed-cost structures with no page or plan-cache
  scan.
- **`frequent`** (log space, memory grants, tempdb usage, file I/O counters, scheduler
  pressure) -- intended for 1-5 minute polling; still cheap, but less urgent than live
  session state.
- **`standard`** (Query Store summaries, database/file space, index usage) -- intended
  for 5-15 minute polling; Query Store queries in particular are bounded by
  `@StartTime`/`@EndTime`/`@TopN` and should not be run more often than the collector's
  own window advances.
- **`low_frequency`** (server identity, database discovery, Query Store options) --
  configuration-shaped facts that rarely change; hourly or on-connect is sufficient.
- **`on_demand`** (`index.operational_stats`) -- never put on a fixed timer; only run
  once a specific object has already been identified as interesting by a cheaper probe
  (e.g. `index.usage_summary`), because `@ObjectId` is a required parameter specifically
  to prevent a whole-database enumeration.

No probe in this catalog samples every executing query (Query Store's own capture
policy -- `ALL`/`AUTO`/`NONE`/`CUSTOM` -- decides what gets captured before any probe
here ever runs), and no probe infers causality across databases; every result set is
scoped to the single connection's server or database context, and any cross-database
correlation is the calling application's responsibility, not this catalog's.

## Sources

- [sys.database_query_store_options (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-database-query-store-options-transact-sql)
- [sys.query_store_query (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-query-store-query-transact-sql)
- [sys.query_store_plan (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-query-store-plan-transact-sql)
- [sys.query_store_runtime_stats (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-query-store-runtime-stats-transact-sql)
- [sys.query_store_wait_stats (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-query-store-wait-stats-transact-sql)
- [sys.dm_exec_requests (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-exec-requests-transact-sql)
- [sys.dm_os_waiting_tasks (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-os-waiting-tasks-transact-sql)
- [sys.dm_exec_query_memory_grants (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-exec-query-memory-grants-transact-sql)
- [sys.dm_tran_session_transactions (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-tran-session-transactions-transact-sql)
- [sys.dm_db_task_space_usage (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-db-task-space-usage-transact-sql)
- [sys.dm_db_session_space_usage (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-db-session-space-usage-transact-sql)
- [sys.dm_db_file_space_usage (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-db-file-space-usage-transact-sql)
- [sys.dm_db_log_space_usage (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-db-log-space-usage-transact-sql)
- [sys.dm_io_virtual_file_stats (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-io-virtual-file-stats-transact-sql)
- [sys.dm_os_schedulers (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-os-schedulers-transact-sql)
- [sys.dm_db_index_usage_stats (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-db-index-usage-stats-transact-sql)
- [sys.dm_db_index_operational_stats (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-db-index-operational-stats-transact-sql)
- [sys.dm_os_sys_info (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-os-sys-info-transact-sql)
- [sys.dm_user_db_resource_governance (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-user-db-resource-governor-azure-sql-database)
- [sys.dm_os_job_object (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-os-job-object-transact-sql)
- [T-SQL differences between SQL Server and Azure SQL Database](https://learn.microsoft.com/en-us/azure/azure-sql/database/transact-sql-tsql-differences-sql-server)
