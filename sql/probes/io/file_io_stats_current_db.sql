-- Probe: io.file_io_stats_current_db
-- Purpose: Cumulative, since-startup I/O counters for the files of the CURRENT database only, for
--   the application to compute deltas between successive polls. Azure SQL Database-safe variant of
--   io.file_io_stats.
-- Connection scope: database (bounded to DB_ID(), the connection's current database).
-- Minimum platform: SQL Server 2016 (13.x).
-- Azure SQL Database: SUPPORTED. Unlike io.file_io_stats, this probe joins to sys.database_files
--   (a per-database catalog view available on every platform, including Azure SQL Database)
--   instead of sys.master_files (not available on Azure SQL Database). Passing DB_ID() explicitly
--   to sys.dm_io_virtual_file_stats also matches the DMV's own documented Azure SQL Database
--   behavior of returning only the current database's files.
-- Permission: SQL Server 2019 (15.x) and earlier require VIEW SERVER STATE. SQL Server 2022 (16.x)
--   and later require VIEW SERVER PERFORMANCE STATE. Azure SQL Database: VIEW DATABASE STATE, or
--   server admin/Microsoft Entra admin/##MS_ServerStateReader## membership on Basic/S0/S1/elastic
--   pool tiers, per the same tiered rule documented in sql/README.md for other state DMVs.
-- Result contract: one row per file_id in the current database. All *_ms columns are milliseconds;
--   num_of_bytes_read/num_of_bytes_written are raw bytes (not pages). See io/file_io_stats.sql's
--   header for the full sample_ms-versus-engine-restart discussion: sample_ms is milliseconds
--   since the COMPUTER (OS) started, not since the last Database Engine restart, so a collector
--   must detect an engine restart via sys.dm_os_sys_info.sqlserver_start_time or direct counter
--   regression, not via sample_ms alone.
-- Relative cost: trivial-to-low; scans an in-memory per-file counter array bounded to one database.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    vfs.database_id,
    DB_NAME(vfs.database_id)       AS database_name,
    vfs.file_id,
    df.type_desc,
    df.physical_name,
    vfs.sample_ms, -- milliseconds since the computer (OS) started, NOT since the last engine restart
    vfs.num_of_reads,
    vfs.num_of_bytes_read,
    vfs.io_stall_read_ms,
    vfs.num_of_writes,
    vfs.num_of_bytes_written,
    vfs.io_stall_write_ms,
    vfs.io_stall,
    vfs.io_stall_queued_read_ms,
    vfs.io_stall_queued_write_ms,
    vfs.size_on_disk_bytes
FROM sys.dm_io_virtual_file_stats(DB_ID(), NULL) AS vfs
JOIN sys.database_files AS df
    ON df.file_id = vfs.file_id;
