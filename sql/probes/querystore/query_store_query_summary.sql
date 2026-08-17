-- Probe: querystore.query_summary
-- Purpose: Query Store query identity, parameterization, and compile-time statistics for queries
--   executed since the given time bound. Does not include runtime execution statistics (see
--   query_store_runtime_stats_summary.sql) or plan XML.
-- Connection scope: database (assumes the client opened a connection to the target database).
-- Minimum platform: SQL Server 2016 (13.x). Column set is stable through SQL Server 2022 (16.x)+
--   and Azure SQL Database; no version split is required for this probe.
-- Permission: SQL Server 2016 (13.x) through 2019 (15.x) require VIEW DATABASE STATE.
--   SQL Server 2022 (16.x) and later require VIEW DATABASE PERFORMANCE STATE.
-- Parameters:
--   @StartTime (datetimeoffset(7), required) -- inclusive lower bound on last_execution_time.
--   @TopN      (int, required)               -- caps the row count; must be a positive, bounded value.
-- Result contract: at most @TopN rows, ordered by last_execution_time descending. compile
--   durations are microseconds (avg_compile_duration, last_compile_duration); compile memory is KiB.
-- Relative cost: low-to-medium, bounded by @TopN; scans Query Store's in-memory query catalog.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT TOP (@TopN)
    q.query_id,
    q.query_text_id,
    q.context_settings_id,
    q.object_id,
    q.query_hash,
    q.is_internal_query,
    q.query_parameterization_type,
    q.query_parameterization_type_desc,
    q.initial_compile_start_time,
    q.last_compile_start_time,
    q.last_execution_time,
    q.count_compiles,
    q.avg_compile_duration,  -- microseconds
    q.last_compile_duration, -- microseconds
    q.avg_bind_duration,     -- microseconds
    q.avg_optimize_duration, -- microseconds
    q.avg_compile_memory_kb  -- KiB
FROM sys.query_store_query AS q
WHERE q.last_execution_time >= @StartTime
ORDER BY q.last_execution_time DESC;
