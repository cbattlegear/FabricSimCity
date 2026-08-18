-- Probe: io.file_io_stats
-- Purpose: Cumulative, since-startup I/O counters per database file, for the application to
--   compute deltas between successive polls (rate = delta / elapsed time between two samples).
-- Connection scope: server (sys.dm_io_virtual_file_stats(NULL, NULL) returns every file the caller
--   can see across the instance).
-- Minimum platform: SQL Server 2016 (13.x); io_stall_queued_read_ms/io_stall_queued_write_ms
--   require SQL Server 2014 (12.x)+ (Resource Governor IO governance) and are always 0 outside
--   Resource-Governor-managed IOPS limits.
-- Azure SQL Database: NOT SUPPORTED as written. This probe joins to sys.master_files to resolve
--   type_desc/physical_name, and sys.master_files is not available on Azure SQL Database (only
--   SQL Server, SQL Managed Instance, and Analytics Platform System). Use
--   io.file_io_stats_current_db on Azure SQL Database (and, optionally, anywhere a per-database
--   rather than per-instance file list is preferred); it joins to sys.database_files instead and
--   is bounded to the current database, which matches how sys.dm_io_virtual_file_stats already
--   behaves on Azure SQL Database (restricted to the current database's own files, because Azure
--   SQL Database does not expose other databases' file identifiers).
-- Permission: SQL Server 2019 (15.x) and earlier require VIEW SERVER STATE. SQL Server 2022 (16.x)
--   and later require VIEW SERVER PERFORMANCE STATE.
-- Result contract: one row per (database_id, file_id) visible to the caller. All *_ms columns are
--   milliseconds; num_of_bytes_read/num_of_bytes_written are raw bytes (not pages).
--   sample_ms is documented by Microsoft as "the number of milliseconds since the computer was
--   started" -- it is COMPUTER (OS) uptime, not Database Engine uptime, and the two are different
--   clocks: the SQL Server service can restart (a failover, a service restart, a container
--   recreate) without the underlying computer restarting. The num_of_reads/num_of_bytes_read/etc.
--   counters themselves are documented as reset ("initialized to empty") whenever the SQL Server
--   service starts -- a different, typically more frequent event than a computer restart. Because
--   of this, a decreasing sample_ms reliably proves a computer restart happened, but the absence of
--   a decreasing sample_ms does NOT prove the counters did not reset: an engine-only restart leaves
--   sample_ms on its same ever-increasing computer-uptime clock while still zeroing the counters.
--   A collector must not rely on sample_ms alone to detect a counter reset. Detect a reset either
--   by comparing this poll's sys.dm_os_sys_info.sqlserver_start_time (see server/server_identity.sql)
--   against the previous poll's value, or directly by counter regression -- any of num_of_reads,
--   num_of_writes, num_of_bytes_read, num_of_bytes_written, io_stall, io_stall_read_ms, or
--   io_stall_write_ms reading lower than the immediately preceding poll for the same
--   (database_id, file_id) means the engine restarted since that poll; discard that delta instead
--   of treating it as negative throughput.
-- Relative cost: low-to-medium; scans an in-memory per-file counter array, not the files themselves.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    vfs.database_id,
    DB_NAME(vfs.database_id)       AS database_name,
    vfs.file_id,
    mf.type_desc,
    mf.physical_name,
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
FROM sys.dm_io_virtual_file_stats(NULL, NULL) AS vfs
JOIN sys.master_files AS mf
    ON mf.database_id = vfs.database_id
   AND mf.file_id = vfs.file_id;
