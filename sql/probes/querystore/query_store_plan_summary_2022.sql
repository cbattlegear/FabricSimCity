-- Probe: querystore.plan_summary_2022
-- Purpose: Query Store execution-plan metadata and plan-forcing state, including the
--   parameter-sensitive-plan (PSP) optimization "variant"/"dispatcher" plan columns.
-- Connection scope: database (assumes the client opened a connection to the target database).
-- Minimum platform: SQL Server 2022 (16.x). has_compile_replay_script, is_optimized_plan_forcing_disabled,
--   plan_type, and plan_type_desc do not exist before SQL Server 2022 (16.x) and querying them on an
--   older engine raises "Invalid column name". Use plan_summary_2016.sql for SQL Server 2016 (13.x)
--   only, or plan_summary_2017.sql for SQL Server 2017 (14.x) through 2019 (15.x).
-- Permission: Requires VIEW DATABASE PERFORMANCE STATE on the database (SQL Server 2022 (16.x)+).
-- Parameters:
--   @StartTime (datetimeoffset(7), required) -- inclusive lower bound on last_execution_time.
--   @TopN      (int, required)               -- caps the row count; must be a positive, bounded value.
-- Result contract: at most @TopN rows, ordered by last_execution_time descending. Durations are
--   microseconds. plan_type_desc distinguishes a single "Compiled Plan" from a PSP optimization
--   "Dispatcher Plan" (routes to variants) and "Query Variant Plan" (one shape-specific variant).
--   query_plan (Showplan XML) is intentionally excluded; fetch it as a separate, explicitly
--   requested, single-plan lookup, never as part of a bulk summary.
-- Relative cost: low-to-medium, bounded by @TopN.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT TOP (@TopN)
    p.plan_id,
    p.query_id,
    p.plan_group_id,
    p.engine_version,
    p.compatibility_level,
    p.query_plan_hash,
    p.is_online_index_plan,
    p.is_trivial_plan,
    p.is_parallel_plan,
    p.is_forced_plan,
    p.is_natively_compiled,
    p.force_failure_count,
    p.last_force_failure_reason,
    p.last_force_failure_reason_desc,
    p.count_compiles,
    p.last_compile_start_time,
    p.last_execution_time,
    p.avg_compile_duration,  -- microseconds
    p.last_compile_duration, -- microseconds
    p.plan_forcing_type,
    p.plan_forcing_type_desc,
    p.has_compile_replay_script,          -- SQL Server 2022 (16.x)+
    p.is_optimized_plan_forcing_disabled, -- SQL Server 2022 (16.x)+
    p.plan_type,                          -- SQL Server 2022 (16.x)+: 0=Compiled Plan,1=Dispatcher Plan,2=Query Variant Plan
    p.plan_type_desc                      -- SQL Server 2022 (16.x)+
FROM sys.query_store_plan AS p
WHERE p.last_execution_time >= @StartTime
ORDER BY p.last_execution_time DESC;
