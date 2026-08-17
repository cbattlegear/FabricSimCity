-- Probe: io.file_io_stats
-- Purpose: Cumulative, since-startup I/O counters per database file, for the application to
--   compute deltas between successive polls (rate = delta / elapsed time between two samples).
-- Connection scope: server (sys.dm_io_virtual_file_stats(NULL, NULL) returns every file the caller
--   can see across the instance; on Azure SQL Database it is restricted to the current database's
--   own files, because Azure SQL Database does not expose other databases' file identifiers).
-- Minimum platform: SQL Server 2016 (13.x); io_stall_queued_read_ms/io_stall_queued_write_ms
--   require SQL Server 2014 (12.x)+ (Resource Governor IO governance) and are always 0 outside
--   Resource-Governor-managed IOPS limits.
-- Permission: SQL Server 2019 (15.x) and earlier require VIEW SERVER STATE. SQL Server 2022 (16.x)
--   and later require VIEW SERVER PERFORMANCE STATE.
-- Result contract: one row per (database_id, file_id) visible to the caller. All *_ms columns are
--   milliseconds; num_of_bytes_read/num_of_bytes_written are raw bytes (not pages). Counters reset
--   to zero when the Database Engine service restarts (sample_ms is milliseconds since that
--   restart) -- a lower reading than the previous poll means the service restarted, not that I/O
--   went backwards; the application must detect and discard that delta rather than treat it as
--   negative throughput.
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
    vfs.sample_ms,
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
