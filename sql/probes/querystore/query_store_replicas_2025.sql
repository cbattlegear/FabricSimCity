-- SQL Server 2025+ readable-secondary Query Store replica labels.
-- Capability negotiation must confirm the view before running this probe on Azure SQL.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    r.replica_group_id,
    r.replica_name
FROM sys.query_store_replicas AS r;
