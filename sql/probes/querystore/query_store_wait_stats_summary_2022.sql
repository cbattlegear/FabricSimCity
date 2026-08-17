-- Probe: querystore.wait_stats_summary_2022
-- Purpose: Query Store wait statistics, aggregated per plan/interval/execution-type/wait-category
--   and replica, rolled up into weighted totals across the requested time window. Adds the
--   secondary-replica identifier introduced for Query Store on readable secondary replicas.
-- Connection scope: database (assumes the client opened a connection to the target database).
-- Minimum platform: SQL Server 2022 (16.x) -- replica_group_id does not exist before SQL Server
--   2022 (16.x) and querying it on an older engine raises "Invalid column name". Use
--   wait_stats_summary_2017.sql for SQL Server 2017 (14.x) through 2019 (15.x).
-- Permission: Requires VIEW DATABASE PERFORMANCE STATE on the database (SQL Server 2022 (16.x)+).
-- Parameters:
--   @StartTime (datetimeoffset(7), required) -- inclusive lower bound on interval start_time.
--   @EndTime   (datetimeoffset(7), required) -- exclusive upper bound on interval start_time.
-- Result contract: zero or more rows, one per (plan_id, runtime_stats_interval_id, execution_type,
--   wait_category, replica_group_id). replica_group_id is 0 (or the primary's group) when Query
--   Store for secondary replicas is not enabled; join sys.query_store_replicas to resolve it to a
--   replica name. As with runtime stats, the currently active interval can carry more than one row
--   per that grouping; this probe SUMs across them so each output row is already de-duplicated.
--   All wait-time columns are MILLISECONDS -- unlike Query Store's duration/CPU columns, which are
--   microseconds.
--   total_query_wait_time_ms and count_executions are both bigint; weighted_avg_query_wait_time_ms_per_execution
--   explicitly CASTs the numerator to decimal(19,4) before dividing so the result is never silently
--   truncated to an integer by T-SQL's bigint/bigint division rule.
--   exec_agg is grouped by (plan_id, runtime_stats_interval_id, execution_type, replica_group_id) and
--   joined on all four keys -- grouping/joining without replica_group_id would sum execution counts
--   across every replica into one total and apply that inflated total to each replica's wait row.
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
        ws.replica_group_id,
        SUM(ws.total_query_wait_time_ms) AS total_query_wait_time_ms,
        MIN(ws.min_query_wait_time_ms)   AS min_query_wait_time_ms,
        MAX(ws.max_query_wait_time_ms)   AS max_query_wait_time_ms
    FROM sys.query_store_wait_stats AS ws
    JOIN sys.query_store_runtime_stats_interval AS rsi
        ON rsi.runtime_stats_interval_id = ws.runtime_stats_interval_id
    WHERE rsi.start_time >= @StartTime
      AND rsi.start_time < @EndTime
    GROUP BY
        ws.plan_id, ws.runtime_stats_interval_id, ws.execution_type,
        ws.execution_type_desc, ws.wait_category, ws.wait_category_desc, ws.replica_group_id
),
exec_agg AS (
    SELECT
        rs.plan_id,
        rs.runtime_stats_interval_id,
        rs.execution_type,
        rs.replica_group_id,
        SUM(rs.count_executions) AS total_count_executions
    FROM sys.query_store_runtime_stats AS rs
    JOIN sys.query_store_runtime_stats_interval AS rsi
        ON rsi.runtime_stats_interval_id = rs.runtime_stats_interval_id
    WHERE rsi.start_time >= @StartTime
      AND rsi.start_time < @EndTime
    GROUP BY rs.plan_id, rs.runtime_stats_interval_id, rs.execution_type, rs.replica_group_id
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
    wa.replica_group_id,
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
   AND ea.execution_type = wa.execution_type
   AND ea.replica_group_id = wa.replica_group_id;
