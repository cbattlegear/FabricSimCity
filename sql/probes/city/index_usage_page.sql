-- Probe: city.index_usage_page
-- Purpose: direct cumulative index usage only for the same keyset-bounded parent object page used
--   by city.object_inventory_page.
-- Connection scope: database.
-- Minimum platform: SQL Server 2016 (13.x).
-- Azure SQL Database: supported and current-database scoped.
-- Permission: SQL Server/Managed Instance requires VIEW SERVER STATE (SQL Server 2016-2019) or
--   VIEW SERVER PERFORMANCE STATE (SQL Server 2022+). Azure SQL Database follows its tiered
--   server-state-reader/database-state rules.
-- Result contract: zero or more rows for indexes of at most @TopN parent tables/indexed views.
--   The parent keyset is selected before joining sys.dm_db_index_usage_stats, preventing a whole
--   database activity payload for every object page. Counters are cumulative but the DMV does not
--   expose the database detach/shutdown reset timestamp, so the application leaves reset epoch null.
-- Relative cost: low; keyset bounded by @TopN.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

WITH selected_objects AS
(
    SELECT TOP (@TopN)
        o.object_id
    FROM sys.objects AS o
    WHERE o.object_id > @AfterObjectId
      AND o.is_ms_shipped = 0
      AND
      (
          o.type = 'U'
          OR
          (
              o.type = 'V'
              AND EXISTS
              (
                  SELECT 1
                  FROM sys.indexes AS indexed_view_index
                  WHERE indexed_view_index.object_id = o.object_id
                    AND indexed_view_index.index_id > 0
              )
          )
      )
    ORDER BY o.object_id
)
SELECT
    usage.object_id,
    usage.index_id,
    usage.user_seeks,
    usage.user_scans,
    usage.user_lookups,
    usage.user_updates
FROM sys.dm_db_index_usage_stats AS usage
JOIN selected_objects AS selected
  ON selected.object_id = usage.object_id
WHERE usage.database_id = DB_ID()
ORDER BY usage.object_id, usage.index_id;
