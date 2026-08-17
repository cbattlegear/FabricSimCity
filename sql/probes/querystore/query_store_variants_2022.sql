-- SQL Server 2022+ PSP variant relations.
-- OPPO must only be labelled after separate SQL Server 2025 capability negotiation.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT TOP (@PageSize)
    qv.query_variant_query_id,
    qv.parent_query_id,
    qv.dispatcher_plan_id
FROM sys.query_store_query_variant AS qv
WHERE qv.query_variant_query_id > @AfterVariantQueryId
ORDER BY qv.query_variant_query_id;
