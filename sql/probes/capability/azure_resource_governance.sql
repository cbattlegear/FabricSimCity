-- Probe: capability.azure_resource_governance
-- Purpose: Azure SQL Database's tenant-level compute limits, used to populate Azure resource
--   metrics in the capability profile instead of the host-level sys.dm_os_sys_info counters
--   (server.identity), which Microsoft documents as possibly reflecting the underlying machine or
--   elastic pool rather than the tenant's own assigned capacity.
-- Connection scope: database (both DMVs report the current database/tenant's own limits; there is
--   no server-wide equivalent on Azure SQL Database).
-- Minimum platform: Azure SQL Database only. sys.dm_user_db_resource_governance and
--   sys.dm_os_job_object's process_memory_limit_mb are Azure SQL Database-specific catalog views;
--   the negotiator must not run this probe against SQL Server on-premises or Azure SQL Managed
--   Instance targets.
-- Permission: sys.dm_user_db_resource_governance requires VIEW DATABASE STATE (or
--   VIEW DATABASE PERFORMANCE STATE) on Azure SQL Database. sys.dm_os_job_object requires no
--   additional permission beyond database connectivity there.
-- Azure SQL Database: supported; this probe is Azure SQL Database's own tenant-scoped replacement
--   for host-level compute sizing, precisely because server.identity's cpu_count/physical_memory_kb
--   are not reliable tenant-capacity indicators on this platform.
-- Result contract: zero or one row combining the current database's vCore CPU limit (NULL for
--   DTU-based databases, per Microsoft's own documentation) with the process memory limit in MiB.
-- Relative cost: trivial.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    g.cpu_limit,
    j.process_memory_limit_mb
FROM sys.dm_user_db_resource_governance AS g
CROSS JOIN sys.dm_os_job_object AS j;
