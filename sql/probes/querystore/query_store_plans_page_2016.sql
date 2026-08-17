-- SQL Server 2016 keyset plan metadata variant.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT TOP (@PageSize)
    p.plan_id, p.query_id, p.query_plan_hash, p.plan_group_id,
    p.is_forced_plan, CAST(NULL AS nvarchar(60)) AS plan_forcing_type_desc,
    p.force_failure_count, p.last_force_failure_reason_desc,
    p.engine_version, p.compatibility_level, p.last_execution_time,
    CAST(0 AS tinyint) AS plan_type, CAST(N'Compiled Plan' AS nvarchar(60)) AS plan_type_desc
FROM sys.query_store_plan AS p
WHERE p.last_execution_time >= @StartTime
  AND p.last_execution_time < @EndTime
  AND (p.last_execution_time > @AfterExecutionTime
       OR (p.last_execution_time = @AfterExecutionTime AND p.plan_id > @AfterPlanId))
ORDER BY p.last_execution_time, p.plan_id;
