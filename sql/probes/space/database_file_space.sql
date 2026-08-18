-- Probe: space.database_file_space
-- Purpose: Allocated vs. used space per data file, plus the raw allocated size of log files (log
--   *usage* -- not just allocation -- is reported separately by space/log_space_usage.sql, because
--   sys.dm_db_file_space_usage only tracks data/ROWS files, not the log).
-- Connection scope: database (assumes the client opened a connection to the target database).
-- Minimum platform: SQL Server 2016 (13.x).
-- Permission: sys.dm_db_file_space_usage requires VIEW SERVER STATE (SQL Server 2016-2019 (13.x-
--   15.x)) or VIEW SERVER PERFORMANCE STATE (SQL Server 2022 (16.x)+) -- despite its per-database
--   output, Microsoft documents this as a server-level, not database-level, permission. On Azure
--   SQL Database Basic/S0/S1 and elastic pools, the equivalent server-level views require the
--   server admin, Microsoft Entra admin account, or ##MS_ServerStateReader## server-role
--   membership; on other Azure SQL Database service objectives, VIEW DATABASE STATE or
--   ##MS_ServerStateReader## membership is sufficient. Querying sys.database_files itself only
--   requires ordinary access to the database.
-- Result contract: one row per file in the current database. Exact *_bytes columns are computed
--   from 8-KiB pages; size/max_size/growth on sys.database_files are already expressed in 8-KiB
--   pages by that catalog view's own definition.
-- Relative cost: trivial.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    df.file_id,
    df.name                                          AS logical_name,
    df.physical_name,
    df.type_desc,
    df.state_desc,
    CONVERT(bigint, df.size) * 8192                   AS allocated_bytes, -- exact, all file types
    CONVERT(bigint, fs.total_page_count) * 8192       AS data_total_bytes,       -- NULL for LOG files
    CONVERT(bigint, fs.total_page_count - fs.unallocated_extent_page_count) * 8192
                                                       AS data_used_bytes,       -- NULL for LOG files
    fs.unallocated_extent_page_count * 8.0 / 1024.0  AS data_free_mb,        -- NULL for LOG files
    fs.version_store_reserved_page_count * 8.0 / 1024.0 AS version_store_mb, -- NULL for LOG files
    df.max_size,      -- 8-KiB pages; -1 means unlimited growth
    df.growth,        -- 8-KiB pages, or percent when is_percent_growth = 1
    df.is_percent_growth
FROM sys.database_files AS df
LEFT JOIN sys.dm_db_file_space_usage AS fs
    ON fs.file_id = df.file_id
ORDER BY df.file_id;
