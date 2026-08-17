-- Probe: tempdb.usage_azure_scoped
-- Purpose: tempdb space usage broken down by session and task ONLY, for Azure SQL Database, where a
--   connection cannot target tempdb as its initial catalog (see tempdb.usage's own header for why).
--   sys.dm_db_session_space_usage and sys.dm_db_task_space_usage report tempdb page allocations
--   regardless of which database the caller is actually connected to, so both run correctly here
--   from the caller's own regular database connection -- no tempdb connection is attempted.
-- Connection scope: database (the caller's own regular Azure SQL Database connection; never
--   tempdb). LiveIncidentCollector only selects this probe when the target's platform is confirmed
--   Azure SQL Database.
-- Deliberately has NO file-level result set: total/allocated/free MiB per tempdb data file requires
--   either a connection whose current database is tempdb, or a three-part cross-database reference
--   such as tempdb.sys.dm_db_file_space_usage -- Azure SQL Database (single database) supports
--   neither. LiveIncidentCollector reports tempdb file usage explicitly Unsupported for this
--   platform rather than fabricating empty or zeroed file rows.
-- Minimum platform: Azure SQL Database only; see tempdb.usage for SQL Server/Managed Instance.
-- Permission: On Azure SQL Database Basic/S0/S1 and elastic pools, the equivalent server-level
--   views require the server admin, Microsoft Entra admin account, or ##MS_ServerStateReader##
--   server-role membership; on other Azure SQL Database service objectives, VIEW DATABASE STATE or
--   ##MS_ServerStateReader## membership is sufficient.
-- Parameters:
--   @IncludeSystemSessions (bit, optional, default 0) -- when 0, session_id <= 50 (system
--     sessions) are excluded from the session/task result sets.
-- Result contract: TWO result sets, in this order -- (1) one row per session from
--   sys.dm_db_session_space_usage, and (2) one row per task from sys.dm_db_task_space_usage.
--   Consume via NextResult(); page counts are 8-KiB pages, converted here to MiB where noted.
-- Relative cost: low; in-memory allocation counters, no page scan.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

-- Result set 1: per-session tempdb page allocation/deallocation.
SELECT
    ss.session_id,
    ss.database_id,
    ss.user_objects_alloc_page_count,
    ss.user_objects_dealloc_page_count,
    ss.internal_objects_alloc_page_count,
    ss.internal_objects_dealloc_page_count
FROM sys.dm_db_session_space_usage AS ss
WHERE @IncludeSystemSessions = 1 OR ss.session_id > 50;

-- Result set 2: per-task tempdb page allocation/deallocation (exec_context_id preserved for
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
