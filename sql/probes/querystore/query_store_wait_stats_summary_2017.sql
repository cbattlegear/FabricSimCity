-- Probe: querystore.wait_stats_summary_2017
-- Purpose: Query Store wait statistics, aggregated per plan/interval/execution-type/wait-category
--   and rolled up into weighted totals across the requested time window.
-- Connection scope: database (assumes the client opened a connection to the target database).
-- Minimum platform: SQL Server 2017 (14.x) -- sys.query_store_wait_stats does not exist on
--   SQL Server 2016 (13.x). Use wait_stats_summary_2022.sql on SQL Server 2022 (16.x)+ / Azure SQL
--   Database to also collect the secondary-replica identifier.
-- Permission: SQL Server 2017 (14.x) through 2019 (15.x) require VIEW DATABASE STATE.
--   SQL Server 2022 (16.x) and later require VIEW DATABASE PERFORMANCE STATE.
-- Parameters:
--   @StartTime (datetimeoffset(7), required) -- inclusive lower bound on interval start_time.
--   @EndTime   (datetimeoffset(7), required) -- exclusive upper bound on interval start_time.
-- Result contract: zero or more rows, one per (plan_id, runtime_stats_interval_id, execution_type,
--   wait_category). As with runtime stats, the *currently active* interval can carry more than one
--   row per that grouping (one flushed row plus one or more in-memory rows); this probe SUMs across
--   them so each output row is already the correct de-duplicated total. sys.query_store_wait_stats
--   has no count_executions column of its own, so a true per-execution weighted average requires
--   the execution count from sys.query_store_runtime_stats for the same (plan_id,
--   runtime_stats_interval_id, execution_type); this probe joins that count in as
--   total_count_executions rather than inventing a weight from wait-time columns alone.
--   All wait-time columns are MILLISECONDS -- unlike Query Store's duration/CPU columns, which are
--   microseconds. Do not mix the two units when comparing wait time against duration/CPU time.
--   total_query_wait_time_ms and count_executions are both bigint; weighted_avg_query_wait_time_ms_per_execution
--   explicitly CASTs the numerator to decimal(19,4) before dividing so the result is never silently
--   truncated to an integer by T-SQL's bigint/bigint division rule.
-- Relative cost: medium; each CTE now joins and filters by the @StartTime/@EndTime window itself,
--   so aggregation never touches rows outside the requested interval.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

WITH wait_agg AS (
    SELECT
        ws.plan_id,
        ws.runtime_stats_interval_id,
        ws.execution_type,
        ws.execution_type_desc,
        ws.wait_category,
        ws.wait_category_desc,
        SUM(ws.total_query_wait_time_ms) AS total_query_wait_time_ms,
        MIN(ws.min_query_wait_time_ms)   AS min_query_wait_time_ms,
        MAX(ws.max_query_wait_time_ms)   AS max_query_wait_time_ms
    FROM sys.query_store_wait_stats AS ws
    JOIN sys.query_store_runtime_stats_interval AS rsi
        ON rsi.runtime_stats_interval_id = ws.runtime_stats_interval_id
    WHERE rsi.end_time > @StartTime
      AND rsi.start_time < @EndTime
    GROUP BY
        ws.plan_id, ws.runtime_stats_interval_id, ws.execution_type,
        ws.execution_type_desc, ws.wait_category, ws.wait_category_desc
),
exec_agg AS (
    SELECT
        rs.plan_id,
        rs.runtime_stats_interval_id,
        rs.execution_type,
        SUM(rs.count_executions) AS total_count_executions
    FROM sys.query_store_runtime_stats AS rs
    JOIN sys.query_store_runtime_stats_interval AS rsi
        ON rsi.runtime_stats_interval_id = rs.runtime_stats_interval_id
    WHERE rsi.end_time > @StartTime
      AND rsi.start_time < @EndTime
    GROUP BY rs.plan_id, rs.runtime_stats_interval_id, rs.execution_type
)
SELECT
    wa.plan_id,
    wa.runtime_stats_interval_id,
    rsi.start_time  AS interval_start_time,
    rsi.end_time    AS interval_end_time,
    wa.execution_type,
    wa.execution_type_desc, -- 0=Regular,3=Aborted,4=Exception
    wa.wait_category,
    wa.wait_category_desc,
    wa.total_query_wait_time_ms,
    wa.min_query_wait_time_ms,
    wa.max_query_wait_time_ms,
    ea.total_count_executions,
    CAST(wa.total_query_wait_time_ms AS decimal(19,4)) / NULLIF(ea.total_count_executions, 0) AS weighted_avg_query_wait_time_ms_per_execution
FROM wait_agg AS wa
JOIN sys.query_store_runtime_stats_interval AS rsi
    ON rsi.runtime_stats_interval_id = wa.runtime_stats_interval_id
LEFT JOIN exec_agg AS ea
    ON ea.plan_id = wa.plan_id
   AND ea.runtime_stats_interval_id = wa.runtime_stats_interval_id
   AND ea.execution_type = wa.execution_type;
