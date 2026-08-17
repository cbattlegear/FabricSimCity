-- Probe: server.identity
-- Purpose: Server/platform identity for feature-detection before running other probes.
-- Connection scope: any (conventionally master); values are instance-wide, not database-scoped.
-- Minimum platform: SQL Server 2017 (14.x) -- sys.dm_os_host_info was introduced in 2017.
-- Permission: SERVERPROPERTY() requires no special permission.
--   sys.dm_os_sys_info / sys.dm_os_host_info: SQL Server 2019 (15.x) and earlier require
--   VIEW SERVER STATE; SQL Server 2022 (16.x) and later require VIEW SERVER PERFORMANCE STATE.
-- Azure SQL Database: supported (EngineEdition = 5). cpu_count / physical_memory_kb from
--   sys.dm_os_sys_info "might return the number of logical CPUs/total physical memory of the
--   machine hosting the database or elastic pool" per Microsoft's own documentation -- they are
--   NOT reliable indicators of the tenant's assigned vCore/DTU capacity and must not be treated as
--   such. For the tenant's actual compute limit, query sys.dm_user_db_resource_governance.cpu_limit
--   (vCore purchasing model only; NULL for DTU databases) and sys.dm_os_job_object.process_memory_limit_mb
--   separately -- both are Azure SQL Database-specific DMVs deliberately out of scope for this
--   cross-platform probe. sqlserver_start_time reflects the most recent failover/restart of the
--   tenant, not necessarily the physical node uptime.
-- Result contract: exactly one row describing the connected instance.
-- Relative cost: trivial (in-memory server state, no per-database scan).
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    CAST(SERVERPROPERTY('ServerName')            AS nvarchar(128))  AS server_name,
    CAST(SERVERPROPERTY('MachineName')            AS nvarchar(128)) AS machine_name,
    CAST(SERVERPROPERTY('InstanceName')           AS nvarchar(128)) AS instance_name,
    CAST(SERVERPROPERTY('ProductVersion')         AS nvarchar(128)) AS product_version,
    CAST(SERVERPROPERTY('ProductMajorVersion')    AS nvarchar(128)) AS product_major_version, -- NULL before SQL Server 2017
    CAST(SERVERPROPERTY('ProductLevel')           AS nvarchar(128)) AS product_level,
    CAST(SERVERPROPERTY('Edition')                AS nvarchar(128)) AS edition,
    CAST(SERVERPROPERTY('EngineEdition')          AS int)           AS engine_edition, -- 1/2/3/4=on-prem tiers,5=Azure SQL DB,6=Azure Synapse,8=Managed Instance,9=Azure SQL Edge,11=Azure Synapse serverless
    CAST(SERVERPROPERTY('IsHadrEnabled')          AS int)           AS is_hadr_enabled,
    CAST(SERVERPROPERTY('Collation')              AS nvarchar(128)) AS server_collation,
    hi.host_platform,
    hi.host_distribution,
    hi.host_release,
    hi.host_service_pack_level,
    si.cpu_count,
    si.scheduler_count,
    si.physical_memory_kb / 1024 AS physical_memory_mb, -- MiB in effect (KB reported is binary KiB)
    si.sqlserver_start_time
FROM sys.dm_os_sys_info AS si
CROSS JOIN sys.dm_os_host_info AS hi;
