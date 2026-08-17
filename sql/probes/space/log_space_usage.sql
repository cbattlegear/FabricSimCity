-- Probe: space.log_space_usage
-- Purpose: Transaction log size and utilization for the current database.
-- Connection scope: database (assumes the client opened a connection to the target database).
-- Minimum platform: SQL Server 2016 (13.x).
-- Permission: SQL Server 2016 (13.x) through 2019 (15.x) require VIEW DATABASE STATE.
--   SQL Server 2022 (16.x) and later require VIEW DATABASE PERFORMANCE STATE.
-- Result contract: exactly one row for the current database. Sizes are converted from bytes to
--   MiB; used_log_space_in_percent is already a 0-100 percentage as reported by the engine and is
--   relative to total_log_size_in_bytes, not to any configured log growth limit.
-- Relative cost: trivial.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    ls.database_id,
    DB_NAME(ls.database_id)                    AS database_name,
    ls.total_log_size_in_bytes / 1048576.0      AS total_log_size_mb,
    ls.used_log_space_in_bytes / 1048576.0      AS used_log_space_mb,
    ls.used_log_space_in_percent
FROM sys.dm_db_log_space_usage AS ls;
