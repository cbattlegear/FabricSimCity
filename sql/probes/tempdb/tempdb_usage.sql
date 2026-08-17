-- Probe: tempdb.usage
-- Purpose: tempdb space usage broken down by file, session, and task -- for spotting a runaway
--   session/task before tempdb fills up.
-- Connection scope: tempdb, EXPLICITLY. Unlike most probes in this catalog, the client must open
--   (or switch, via a fresh connection from the pool) its connection with tempdb as the current
--   database before running this file. sys.dm_db_file_space_usage returns space usage for
--   whichever database is current, so it must be run while connected to tempdb to get tempdb's
--   breakdown; sys.dm_db_session_space_usage and sys.dm_db_task_space_usage report only tempdb
--   allocations regardless of the current database, but are grouped here with the tempdb-context
--   requirement for a single, unambiguous connection-scope contract. Microsoft documents that a
--   T-SQL USE statement cannot be used to change database context on Azure SQL Database -- the
--   client must instead "create a new connection to that database" -- which is exactly the
--   fresh-connection-from-the-pool pattern this probe requires; see the differences page cited in
--   sql/README.md. Each Azure SQL Database has its own private, per-database tempdb, so this
--   pattern works there the same as on SQL Server/Managed Instance.
-- Minimum platform: SQL Server 2016 (13.x).
-- Permission: sys.dm_db_file_space_usage / sys.dm_db_session_space_usage / sys.dm_db_task_space_usage
--   on SQL Server/Managed Instance require VIEW SERVER STATE (SQL Server 2016-2019 (13.x-15.x)) or
--   VIEW SERVER PERFORMANCE STATE (SQL Server 2022 (16.x)+). On Azure SQL Database Basic/S0/S1 and
--   elastic pools, the equivalent server-level views require the server admin, Microsoft Entra
--   admin account, or ##MS_ServerStateReader## server-role membership; on other Azure SQL Database
--   service objectives, VIEW DATABASE STATE (in tempdb) or ##MS_ServerStateReader## membership is
--   sufficient.
-- Parameters:
--   @IncludeSystemSessions (bit, optional, default 0) -- when 0, session_id <= 50 (system
--     sessions) are excluded from the session/task result sets.
-- Result contract: THREE result sets, in this order -- (1) one row per tempdb data file from
--   sys.dm_db_file_space_usage, (2) one row per session from sys.dm_db_session_space_usage, and
--   (3) one row per task from sys.dm_db_task_space_usage. Consume via NextResult(); page counts are
--   8-KiB pages, converted here to MiB.
-- Relative cost: low; in-memory allocation counters, no page scan.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

-- Result set 1: tempdb file-level space usage (requires current database = tempdb).
SELECT
    fs.database_id,
    fs.file_id,
    fs.filegroup_id,
    fs.total_page_count * 8.0 / 1024.0                  AS total_mb,
    fs.allocated_extent_page_count * 8.0 / 1024.0        AS allocated_mb,
    fs.unallocated_extent_page_count * 8.0 / 1024.0      AS free_mb,
    fs.version_store_reserved_page_count * 8.0 / 1024.0  AS version_store_mb,
    fs.user_object_reserved_page_count * 8.0 / 1024.0    AS user_objects_mb,
    fs.internal_object_reserved_page_count * 8.0 / 1024.0 AS internal_objects_mb,
    fs.mixed_extent_page_count * 8.0 / 1024.0            AS mixed_extent_mb
FROM sys.dm_db_file_space_usage AS fs;

-- Result set 2: per-session tempdb page allocation/deallocation.
SELECT
    ss.session_id,
    ss.database_id,
    ss.user_objects_alloc_page_count,
    ss.user_objects_dealloc_page_count,
    ss.internal_objects_alloc_page_count,
    ss.internal_objects_dealloc_page_count
FROM sys.dm_db_session_space_usage AS ss
WHERE @IncludeSystemSessions = 1 OR ss.session_id > 50;

-- Result set 3: per-task tempdb page allocation/deallocation (exec_context_id preserved for
-- parallel requests).
SELECT
    ts.session_id,
    ts.request_id,
    ts.exec_context_id,
    ts.database_id,
    ts.user_objects_alloc_page_count,
    ts.user_objects_dealloc_page_count,
    ts.internal_objects_alloc_page_count,
    ts.internal_objects_dealloc_page_count
FROM sys.dm_db_task_space_usage AS ts
WHERE @IncludeSystemSessions = 1 OR ts.session_id > 50;
