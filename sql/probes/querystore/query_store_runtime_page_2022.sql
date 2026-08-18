-- SQL Server 2022+ keyset runtime variant with replica groups.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

WITH buckets AS (
    SELECT
        rs.runtime_stats_interval_id, rs.plan_id, rs.execution_type, rs.replica_group_id,
        rsi.start_time, rsi.end_time,
        SUM(CONVERT(decimal(38,0), rs.count_executions)) AS execution_count,
        SUM(CONVERT(float, rs.avg_duration) * CONVERT(float, rs.count_executions))
          / NULLIF(SUM(CONVERT(float, rs.count_executions)), 0.0) AS average_duration_us,
        SUM(CONVERT(float, rs.avg_cpu_time) * CONVERT(float, rs.count_executions))
          / NULLIF(SUM(CONVERT(float, rs.count_executions)), 0.0) AS average_cpu_us,
        SUM(CONVERT(float, rs.avg_logical_io_reads) * CONVERT(float, rs.count_executions))
          / NULLIF(SUM(CONVERT(float, rs.count_executions)), 0.0) AS average_logical_reads_pages
    FROM sys.query_store_runtime_stats AS rs
    JOIN sys.query_store_runtime_stats_interval AS rsi
      ON rsi.runtime_stats_interval_id = rs.runtime_stats_interval_id
    WHERE rsi.end_time > @StartTime AND rsi.start_time < @EndTime
    GROUP BY rs.runtime_stats_interval_id, rs.plan_id, rs.execution_type, rs.replica_group_id,
             rsi.start_time, rsi.end_time
)
SELECT TOP (@PageSize) *
FROM buckets
WHERE runtime_stats_interval_id > @AfterIntervalId
   OR (runtime_stats_interval_id = @AfterIntervalId AND plan_id > @AfterPlanId)
   OR (runtime_stats_interval_id = @AfterIntervalId AND plan_id = @AfterPlanId
       AND execution_type > @AfterExecutionType)
   OR (runtime_stats_interval_id = @AfterIntervalId AND plan_id = @AfterPlanId
       AND execution_type = @AfterExecutionType AND replica_group_id > @AfterReplicaGroupId)
ORDER BY runtime_stats_interval_id, plan_id, execution_type, replica_group_id;
