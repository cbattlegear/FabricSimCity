-- Probe: index.usage_summary
-- Purpose: Seek/scan/lookup/update counts per index in the current database, for finding unused or
--   write-heavy indexes.
-- Connection scope: database (assumes the client opened a connection to the target database);
--   filtered to database_id = DB_ID() even though the DMV is instance-wide, because on Azure SQL
--   Database only the current database's rows are visible anyway (rows for other databases are
--   silently filtered by the engine, not returned as an error).
-- Minimum platform: SQL Server 2016 (13.x).
-- Permission: SQL Server/Managed Instance -- VIEW SERVER STATE (SQL Server 2016 (13.x) through
--   2019 (15.x)) or VIEW SERVER PERFORMANCE STATE (SQL Server 2022 (16.x)+).
--   Azure SQL Database -- Basic/S0/S1 tiers and databases in an elastic pool require the server
--   admin account, an Azure AD/Entra admin account, or membership in the ##MS_ServerStateReader##
--   server role; other (higher) service tiers require VIEW DATABASE STATE, or membership in
--   ##MS_ServerStateReader## / the VIEW DATABASE PERFORMANCE STATE permission on SQL Server 2022
--   (16.x)-equivalent Azure SQL Database.
-- Result contract: zero or more rows, one per (object_id, index_id) that has been touched by a
--   plan since the counters last reset. An index with NO row here has not been used at all since
--   that reset -- it does not mean the index has zero rows or is otherwise empty. Microsoft
--   documents the counters as reset ("initialized to empty") only in two cases: (1) whenever the
--   Database Engine (re)starts, or (2) whenever the database is detached or shut down (for example
--   because AUTO_CLOSE is ON) -- and in case (2) all rows for that database are removed entirely,
--   not merely zeroed. No official documentation states that rebuilding or recreating an index
--   resets its counters; do not assume a rebuild clears this history. Delta calculations must
--   detect and discard a reset across engine restarts/AUTO_CLOSE cycles the same way other
--   cumulative-since-restart probes in this catalog do. This DMV excludes memory-optimized and
--   spatial indexes (see sys.dm_db_xtp_index_stats for memory-optimized index usage).
-- Relative cost: trivial-to-low, bounded to the current database.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    ius.object_id,
    OBJECT_SCHEMA_NAME(ius.object_id) AS schema_name,
    OBJECT_NAME(ius.object_id)        AS object_name,
    ius.index_id,
    i.name                            AS index_name,
    i.type_desc                       AS index_type_desc,
    ius.user_seeks,
    ius.user_scans,
    ius.user_lookups,
    ius.user_updates,
    ius.last_user_seek,
    ius.last_user_scan,
    ius.last_user_lookup,
    ius.last_user_update,
    ius.system_seeks,
    ius.system_scans,
    ius.system_lookups,
    ius.system_updates
FROM sys.dm_db_index_usage_stats AS ius
JOIN sys.indexes AS i
    ON i.object_id = ius.object_id
   AND i.index_id = ius.index_id
WHERE ius.database_id = DB_ID();
