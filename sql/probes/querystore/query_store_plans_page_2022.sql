-- SQL Server 2022+ keyset plan metadata variant.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT TOP (@PageSize)
    p.plan_id, p.query_id, p.query_plan_hash, p.plan_group_id,
    p.is_forced_plan, p.plan_forcing_type_desc,
    p.force_failure_count, p.last_force_failure_reason_desc,
    p.engine_version, p.compatibility_level, p.last_execution_time,
    p.plan_type, p.plan_type_desc
FROM sys.query_store_plan AS p
WHERE p.last_execution_time >= @StartTime
  AND p.last_execution_time < @EndTime
  AND (p.last_execution_time > @AfterExecutionTime
       OR (p.last_execution_time = @AfterExecutionTime AND p.plan_id > @AfterPlanId))
ORDER BY p.last_execution_time, p.plan_id;
