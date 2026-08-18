-- Probe: space.log_space_usage
-- Purpose: Transaction log size and utilization for the current database.
-- Connection scope: database (assumes the client opened a connection to the target database).
-- Minimum platform: SQL Server 2016 (13.x).
-- Permission: sys.dm_db_log_space_usage requires VIEW SERVER STATE (SQL Server 2016-2019 (13.x-
--   15.x)) or VIEW SERVER PERFORMANCE STATE (SQL Server 2022 (16.x)+) -- despite its per-database
--   output, Microsoft documents this as a server-level, not database-level, permission. On Azure
--   SQL Database Basic/S0/S1 and elastic pools, the equivalent server-level views require the
--   server admin, Microsoft Entra admin account, or ##MS_ServerStateReader## server-role
--   membership; on other Azure SQL Database service objectives, VIEW DATABASE STATE or
--   ##MS_ServerStateReader## membership is sufficient.
-- Result contract: exactly one row for the current database. Sizes remain exact bytes;
--   used_log_space_in_percent is already a 0-100 percentage as reported by the engine and is
--   relative to total_log_size_in_bytes, not to any configured log growth limit.
-- Relative cost: trivial.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    ls.database_id,
    DB_NAME(ls.database_id)                    AS database_name,
    CONVERT(bigint, ls.total_log_size_in_bytes) AS total_log_size_bytes,
    CONVERT(bigint, ls.used_log_space_in_bytes) AS used_log_space_bytes,
    ls.used_log_space_in_percent
FROM sys.dm_db_log_space_usage AS ls;
