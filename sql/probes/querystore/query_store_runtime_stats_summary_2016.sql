-- Probe: querystore.runtime_stats_summary_2016
-- Purpose: Query Store runtime execution statistics, aggregated per plan/interval/execution-type
--   and rolled up into weighted totals across the requested time window.
-- Connection scope: database (assumes the client opened a connection to the target database).
-- Minimum platform: SQL Server 2016 (13.x). Column set here is stable through SQL Server 2019
--   (15.x)/Azure SQL Database. It intentionally omits replica_group_id, which does not exist as a
--   column before SQL Server 2022 (16.x) and raises "Invalid column name" if selected there. Use
--   runtime_stats_summary_2022.sql on SQL Server 2022 (16.x)+ to keep secondary-replica runtime
--   stats separated by replica instead of silently summed together.
-- Permission: Requires VIEW DATABASE STATE on the database.
-- Parameters:
--   @StartTime (datetimeoffset(7), required) -- inclusive lower bound on interval start_time.
--   @EndTime   (datetimeoffset(7), required) -- exclusive upper bound on interval start_time.
-- Result contract: zero or more rows, one per (plan_id, runtime_stats_interval_id, execution_type).
--   For the *currently active* interval, sys.query_store_runtime_stats can carry more than one row
--   per that grouping -- one flushed-to-disk row and one or more in-memory rows -- per Microsoft's
--   own documentation. This probe SUMs across all rows in that grouping so each output row already
--   represents the correct de-duplicated total for its interval; do not re-aggregate client-side by
--   anything looser than (plan_id, runtime_stats_interval_id, execution_type).
--   All duration and CPU-time columns are microseconds. Logical/physical IO columns are counts of
--   8-KiB pages. weighted_avg_duration_us is the count-weighted mean, i.e.
--   SUM(avg_duration * count_executions) / SUM(count_executions), which is not the same number as a
--   simple AVG(avg_duration) across intervals.
-- Relative cost: medium; bounded by the @StartTime/@EndTime window via the interval join.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    rs.plan_id,
    rs.runtime_stats_interval_id,
    rsi.start_time  AS interval_start_time,
    rsi.end_time    AS interval_end_time,
    rs.execution_type,
    rs.execution_type_desc, -- 0=Regular,3=Aborted,4=Exception
    SUM(CONVERT(decimal(38,0), rs.count_executions))            AS total_count_executions,
    SUM(CONVERT(decimal(38,0), rs.avg_duration) * CONVERT(decimal(38,0), rs.count_executions))
        / NULLIF(SUM(CONVERT(decimal(38,0), rs.count_executions)), 0) AS weighted_avg_duration_us,
    SUM(CONVERT(decimal(38,0), rs.avg_duration) * CONVERT(decimal(38,0), rs.count_executions)) AS total_duration_us,
    MIN(rs.min_duration)                                        AS min_duration_us,
    MAX(rs.max_duration)                                        AS max_duration_us,
    SUM(CONVERT(decimal(38,0), rs.avg_cpu_time) * CONVERT(decimal(38,0), rs.count_executions))
        / NULLIF(SUM(CONVERT(decimal(38,0), rs.count_executions)), 0) AS weighted_avg_cpu_time_us,
    SUM(CONVERT(decimal(38,0), rs.avg_cpu_time) * CONVERT(decimal(38,0), rs.count_executions)) AS total_cpu_time_us,
    SUM(CONVERT(decimal(38,0), rs.avg_logical_io_reads) * CONVERT(decimal(38,0), rs.count_executions))
        / NULLIF(SUM(CONVERT(decimal(38,0), rs.count_executions)), 0) AS weighted_avg_logical_io_reads_pages,
    SUM(CONVERT(decimal(38,0), rs.avg_logical_io_reads) * CONVERT(decimal(38,0), rs.count_executions)) AS total_logical_io_reads_pages,
    SUM(rs.avg_physical_io_reads * rs.count_executions)         AS total_physical_io_reads_pages,
    SUM(rs.avg_rowcount * rs.count_executions)                  AS total_rowcount,
    MAX(rs.last_execution_time)                                 AS last_execution_time
FROM sys.query_store_runtime_stats AS rs
JOIN sys.query_store_runtime_stats_interval AS rsi
    ON rsi.runtime_stats_interval_id = rs.runtime_stats_interval_id
WHERE rsi.start_time >= @StartTime
  AND rsi.start_time < @EndTime
GROUP BY
    rs.plan_id,
    rs.runtime_stats_interval_id,
    rsi.start_time,
    rsi.end_time,
    rs.execution_type,
    rs.execution_type_desc;
