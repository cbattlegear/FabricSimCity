-- On-demand sensitive payload. The caller must encrypt the returned XML in IProtectedRecordStore.
-- Never run this as a summary or background bulk probe.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    p.plan_id,
    p.query_id,
    p.query_plan
FROM sys.query_store_plan AS p
WHERE p.plan_id = @PlanId;
