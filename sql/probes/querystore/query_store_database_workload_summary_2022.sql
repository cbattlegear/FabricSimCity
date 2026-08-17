-- Probe: querystore.database_workload_summary_2022
-- Purpose: Bounded database-wide Query Store workload totals with replica-aware deduplication.
-- Connection scope: database.
-- Minimum platform: SQL Server 2022 (16.x).
-- Permission: VIEW DATABASE PERFORMANCE STATE.
-- Parameters: @StartTime inclusive and @EndTime exclusive, both datetimeoffset(7).
-- Result contract: at most one row per execution_type. Active-interval duplicate rows are first
-- combined per plan/interval/type/replica, then replica groups and the bounded window are aggregated.
-- Durations and CPU are microseconds; logical reads are 8-KiB pages. No plan XML.
-- Query Store averages are float. Keep them as float through weighting and both sums so fractional
-- contributions survive; the final decimal(38,0) conversion rounds to the integral contract unit
-- and raises on an out-of-range total instead of risking decimal multiplication overflow.
-- Relative cost: medium.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

WITH per_plan_interval AS
(
    SELECT
        rs.plan_id,
        rs.runtime_stats_interval_id,
        rs.execution_type,
        rs.replica_group_id,
        SUM(CONVERT(decimal(38,0), rs.count_executions)) AS execution_count,
        SUM(CONVERT(float, rs.avg_duration) *
            CONVERT(float, rs.count_executions)) AS total_duration_us,
        SUM(CONVERT(float, rs.avg_cpu_time) *
            CONVERT(float, rs.count_executions)) AS total_cpu_us,
        SUM(CONVERT(float, rs.avg_logical_io_reads) *
            CONVERT(float, rs.count_executions)) AS logical_reads_pages
    FROM sys.query_store_runtime_stats AS rs
    JOIN sys.query_store_runtime_stats_interval AS rsi
        ON rsi.runtime_stats_interval_id = rs.runtime_stats_interval_id
    WHERE rsi.start_time >= @StartTime
      AND rsi.start_time < @EndTime
    GROUP BY
        rs.plan_id,
        rs.runtime_stats_interval_id,
        rs.execution_type,
        rs.replica_group_id
)
SELECT
    execution_type,
    SUM(execution_count) AS execution_count,
    CONVERT(decimal(38,0), ROUND(SUM(total_duration_us), 0)) AS total_duration_us,
    CONVERT(decimal(38,0), ROUND(SUM(total_cpu_us), 0)) AS total_cpu_us,
    CONVERT(decimal(38,0), ROUND(SUM(logical_reads_pages), 0)) AS logical_reads_pages
FROM per_plan_interval
GROUP BY execution_type
ORDER BY execution_type;
