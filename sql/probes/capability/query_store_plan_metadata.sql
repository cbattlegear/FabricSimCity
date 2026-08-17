-- Probe: capability.query_store_plan_metadata
-- Purpose: Confirms, by reading catalog metadata rather than trusting major version alone,
--   whether the connected engine build's Query Store plan/runtime-stats catalog views carry the
--   columns that Parameter Sensitive Plan optimization (PSP), Optional Parameter Plan Optimization
--   (OPPO), and readable-secondary-replica Query Store reporting depend on:
--   sys.query_store_plan.plan_type_desc (distinguishes Compiled/Dispatcher/Query Variant plans,
--   the PSP/OPPO plan-variant signal -- SQL Server 2022 (16.x)+) and
--   sys.query_store_runtime_stats.replica_group_id (separates primary vs. readable-secondary
--   runtime stats -- SQL Server 2022 (16.x)+). Feature selection combines this metadata
--   confirmation with the database's own compatibility_level (from server.database_discovery):
--   database compatibility level 160+ is required for PSP, 170+ for OPPO, and neither compat
--   level nor engine version alone is sufficient on its own.
-- Connection scope: database (Query Store catalog views are evaluated in the current database
--   context; column presence reflects the connected engine build and is the same for every
--   database on that instance).
-- Minimum platform: SQL Server 2016 (13.x). Both columns checked here do not exist before SQL
--   Server 2022 (16.x); on earlier engines this probe still runs safely and returns zero rows.
-- Permission: sys.all_columns / OBJECT_ID(): none (public). This probe reads catalog metadata
--   only -- no Query Store data rows (plan text, query text, or runtime statistics) are read.
-- Azure SQL Database: supported; Azure SQL Database always runs a current engine, so both columns
--   are present there.
-- Result contract: zero to four rows, one per (view_name, column_name) pair that exists on this
--   engine build. Absence of a row for a given column is the reliable signal that the column (and
--   therefore the dependent feature) does not exist on this engine build.
-- Relative cost: trivial.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT N'sys.query_store_plan' AS view_name, c.name AS column_name
FROM sys.all_columns AS c
WHERE c.object_id = OBJECT_ID(N'sys.query_store_plan', N'V')
  AND c.name IN (N'plan_type', N'plan_type_desc', N'is_optimized_plan_forcing_disabled', N'has_compile_replay_script')
UNION ALL
SELECT N'sys.query_store_runtime_stats' AS view_name, c.name AS column_name
FROM sys.all_columns AS c
WHERE c.object_id = OBJECT_ID(N'sys.query_store_runtime_stats', N'V')
  AND c.name IN (N'replica_group_id')
UNION ALL
SELECT N'sys.query_store_query_variant', N'<view>'
WHERE OBJECT_ID(N'sys.query_store_query_variant', N'V') IS NOT NULL
UNION ALL
SELECT N'sys.query_store_replicas', N'<view>'
WHERE OBJECT_ID(N'sys.query_store_replicas', N'V') IS NOT NULL
UNION ALL
SELECT N'sys.query_store_query_text', c.name
FROM sys.all_columns AS c
WHERE c.object_id = OBJECT_ID(N'sys.query_store_query_text', N'V')
  AND c.name = N'has_restricted_text';
