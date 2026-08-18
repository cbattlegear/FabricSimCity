-- Probe: server.host_info
-- Purpose: Host operating system platform/distribution detail, supplemental to server.identity.
-- Connection scope: any (conventionally master); values are instance-wide, not database-scoped.
-- Minimum platform: SQL Server 2017 (14.x) -- sys.dm_os_host_info was introduced in 2017.
-- Azure SQL Database: NOT SUPPORTED. sys.dm_os_host_info's own documented platform list is SQL
--   Server and Azure SQL Managed Instance only; it does not include Azure SQL Database (EngineEdition
--   = 5), and calling it there fails. Use server.identity alone on Azure SQL Database; this probe
--   is only meaningful when the collector already knows (from server.identity.engine_edition) that
--   it is talking to SQL Server or Azure SQL Managed Instance.
-- Permission: SQL Server 2019 (15.x) and earlier require VIEW SERVER STATE. SQL Server 2022 (16.x)
--   and later require VIEW SERVER PERFORMANCE STATE.
-- Result contract: exactly one row describing the host operating system of the connected instance
--   (or Managed Instance).
-- Relative cost: trivial (in-memory server state, no per-database scan).
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    hi.host_platform,
    hi.host_distribution,
    hi.host_release,
    hi.host_service_pack_level
FROM sys.dm_os_host_info AS hi;
