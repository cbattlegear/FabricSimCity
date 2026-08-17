-- Probe: space.database_file_space
-- Purpose: Allocated vs. used space per data file, plus the raw allocated size of log files (log
--   *usage* -- not just allocation -- is reported separately by space/log_space_usage.sql, because
--   sys.dm_db_file_space_usage only tracks data/ROWS files, not the log).
-- Connection scope: database (assumes the client opened a connection to the target database).
-- Minimum platform: SQL Server 2016 (13.x).
-- Permission: SQL Server 2016 (13.x) through 2019 (15.x) require VIEW DATABASE STATE.
--   SQL Server 2022 (16.x) and later require VIEW DATABASE PERFORMANCE STATE for the DMV; querying
--   sys.database_files itself only requires ordinary access to the database.
-- Result contract: one row per file in the current database. All *_mb columns are computed from
--   8-KiB pages (1 MiB = 128 pages); size/max_size/growth on sys.database_files are already
--   expressed in 8-KiB pages by that catalog view's own definition.
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
    df.size * 8.0 / 1024.0                           AS allocated_mb, -- from sys.database_files (all file types)
    fs.total_page_count * 8.0 / 1024.0               AS data_total_mb,       -- NULL for LOG files
    (fs.total_page_count - fs.unallocated_extent_page_count) * 8.0 / 1024.0
                                                       AS data_used_mb,       -- NULL for LOG files
    fs.unallocated_extent_page_count * 8.0 / 1024.0  AS data_free_mb,        -- NULL for LOG files
    fs.version_store_reserved_page_count * 8.0 / 1024.0 AS version_store_mb, -- NULL for LOG files
    df.max_size,      -- 8-KiB pages; -1 means unlimited growth
    df.growth,        -- 8-KiB pages, or percent when is_percent_growth = 1
    df.is_percent_growth
FROM sys.database_files AS df
LEFT JOIN sys.dm_db_file_space_usage AS fs
    ON fs.file_id = df.file_id
ORDER BY df.file_id;
