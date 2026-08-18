-- SQL Server 2017+ through 2019 keyset wait variant.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

WITH buckets AS (
    SELECT ws.runtime_stats_interval_id, ws.plan_id, ws.execution_type, ws.wait_category,
           ws.wait_category_desc, CAST(0 AS bigint) AS replica_group_id,
           SUM(CONVERT(decimal(38,0), ws.total_query_wait_time_ms)) AS total_wait_ms
    FROM sys.query_store_wait_stats AS ws
    JOIN sys.query_store_runtime_stats_interval AS rsi
      ON rsi.runtime_stats_interval_id = ws.runtime_stats_interval_id
    WHERE rsi.end_time > @StartTime AND rsi.start_time < @EndTime
    GROUP BY ws.runtime_stats_interval_id, ws.plan_id, ws.execution_type,
             ws.wait_category, ws.wait_category_desc
)
SELECT TOP (@PageSize) *
FROM buckets
WHERE runtime_stats_interval_id > @AfterIntervalId
   OR (runtime_stats_interval_id = @AfterIntervalId AND plan_id > @AfterPlanId)
   OR (runtime_stats_interval_id = @AfterIntervalId AND plan_id = @AfterPlanId
       AND execution_type > @AfterExecutionType)
   OR (runtime_stats_interval_id = @AfterIntervalId AND plan_id = @AfterPlanId
       AND execution_type = @AfterExecutionType AND wait_category > @AfterWaitCategory)
ORDER BY runtime_stats_interval_id, plan_id, execution_type, wait_category;
