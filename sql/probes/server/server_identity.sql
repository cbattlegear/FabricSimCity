-- Probe: server.identity
-- Purpose: Server/platform identity for feature-detection before running other probes.
-- Connection scope: any (conventionally master); values are instance-wide, not database-scoped.
-- Minimum platform: SQL Server 2016 (13.x).
-- Permission: SERVERPROPERTY() requires no special permission.
--   sys.dm_os_sys_info: SQL Server 2019 (15.x) and earlier require VIEW SERVER STATE; SQL Server
--   2022 (16.x) and later require VIEW SERVER PERFORMANCE STATE.
-- Azure SQL Database: supported (EngineEdition = 5). cpu_count / physical_memory_kb from
--   sys.dm_os_sys_info "might return the number of logical CPUs/total physical memory of the
--   machine hosting the database or elastic pool" per Microsoft's own documentation -- they are
--   NOT reliable indicators of the tenant's assigned vCore/DTU capacity and must not be treated as
--   such. For the tenant's actual compute limit, query sys.dm_user_db_resource_governance.cpu_limit
--   (vCore purchasing model only; NULL for DTU databases) and sys.dm_os_job_object.process_memory_limit_mb
--   separately -- both are Azure SQL Database-specific DMVs deliberately out of scope for this
--   cross-platform probe. sqlserver_start_time reflects the most recent failover/restart of the
--   tenant, not necessarily the physical node uptime. This file deliberately does NOT join
--   sys.dm_os_host_info: that DMV's own documented platform list does not include Azure SQL
--   Database (only SQL Server and Azure SQL Managed Instance), so joining it here would break this
--   probe on Azure SQL Database. Use server.host_info (SQL Server 2017 (14.x)+ / Managed Instance
--   only) for host OS platform detection.
-- NULL columns by platform: SERVERPROPERTY returns NULL for any property not supported on the
--   connected engine, so consumers must never assume a non-NULL scalar. is_hadr_enabled and
--   product_major_version are documented "Applies to: SQL Server" and are therefore NULL on BOTH
--   Azure SQL Database and Azure SQL Managed Instance; machine_name is NULL on Azure SQL Database
--   and instance_name is NULL on both. Availability groups are a SQL Server feature, so a NULL
--   is_hadr_enabled means "not applicable" and is read as not enabled.
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
    si.cpu_count,
    si.scheduler_count,
    si.physical_memory_kb / 1024 AS physical_memory_mb, -- MiB in effect (KB reported is binary KiB)
    si.sqlserver_start_time
FROM sys.dm_os_sys_info AS si;
