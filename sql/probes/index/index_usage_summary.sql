-- Probe: index.usage_summary
-- Purpose: Seek/scan/lookup/update counts per index in the current database, for finding unused or
--   write-heavy indexes.
-- Connection scope: database (assumes the client opened a connection to the target database);
--   filtered to database_id = DB_ID() even though the DMV is instance-wide, because on Azure SQL
--   Database only the current database's rows are visible anyway (rows for other databases are
--   silently filtered by the engine, not returned as an error).
-- Minimum platform: SQL Server 2016 (13.x).
-- Permission: no special permission beyond ordinary access to the database; this DMV is not gated
--   by VIEW SERVER STATE / VIEW DATABASE STATE the way most other DMVs in this catalog are.
-- Result contract: zero or more rows, one per (object_id, index_id) that has been touched by a
--   plan since the last engine restart. An index with NO row here has not been used at all since
--   startup -- it does not mean the index has zero rows or is otherwise empty. All counters are
--   cumulative since the last engine restart or the index's last rebuild/creation, whichever is
--   more recent, and are reset by either event; they must be delta'd across polls only within a
--   single uptime period. This DMV excludes memory-optimized and spatial indexes (see
--   sys.dm_db_xtp_index_stats for memory-optimized index usage).
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
