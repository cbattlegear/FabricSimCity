-- Probe: city.object_inventory_page
-- Purpose: keyset-bounded tables/indexed views with exact 8-KiB reserved/used page counts and
--   attached index metadata for the database-city projection.
-- Connection scope: database.
-- Minimum platform: SQL Server 2016 (13.x).
-- Azure SQL Database: supported and current-database scoped.
-- Permission: ordinary catalog visibility plus VIEW DATABASE STATE (SQL Server 2016-2019) or
--   VIEW DATABASE PERFORMANCE STATE (SQL Server 2022+) for sys.dm_db_partition_stats.
-- Result contract: one or more rows per selected object, including an indexless object row. The
--   object keyset is bounded
--   by TOP (@TopN) and object_id > @AfterObjectId before index expansion. reserved_pages and
--   used_pages are exact bigint totals over all partitions and remain object totals on each
--   attached-index row. Missing partition counters remain NULL rather than measured zero. Tables
--   with a heap retain index_id 0; only indexed views are included.
-- Relative cost: low; keyset bounded by @TopN.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

WITH selected_objects AS
(
    SELECT TOP (@TopN)
        o.object_id,
        o.schema_id,
        (SELECT COUNT(*) FROM sys.schemas AS earlier_schema WHERE earlier_schema.schema_id < o.schema_id) AS schema_layout_ordinal,
        o.name AS object_name,
        o.type
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
),
object_space AS
(
    SELECT
        partitions.object_id,
        SUM(CONVERT(bigint, partitions.reserved_page_count)) AS reserved_pages,
        SUM(CONVERT(bigint, partitions.used_page_count)) AS used_pages
    FROM sys.dm_db_partition_stats AS partitions
    JOIN selected_objects AS selected
      ON selected.object_id = partitions.object_id
    GROUP BY partitions.object_id
)
SELECT
    selected.object_id,
    selected.schema_id,
    selected.schema_layout_ordinal,
    schemas.name AS schema_name,
    selected.object_name,
    CASE selected.type WHEN 'V' THEN 'INDEXED_VIEW' ELSE 'TABLE' END AS object_type,
    space.reserved_pages,
    space.used_pages,
    indexes.index_id,
    indexes.name AS index_name,
    indexes.type_desc AS index_type_desc
FROM selected_objects AS selected
JOIN sys.schemas AS schemas
  ON schemas.schema_id = selected.schema_id
LEFT JOIN sys.indexes AS indexes
  ON indexes.object_id = selected.object_id
LEFT JOIN object_space AS space
  ON space.object_id = selected.object_id
ORDER BY selected.object_id, indexes.index_id;
