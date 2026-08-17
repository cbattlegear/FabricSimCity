-- Probe: index.operational_stats
-- Purpose: Lower-level access/locking/latching statistics for a specific table or view's indexes,
--   for diagnosing contention (lock waits, latch waits) on a known hot object.
-- Connection scope: database (assumes the client opened a connection to the target database).
-- Minimum platform: SQL Server 2016 (13.x).
-- Permission: no special permission beyond ordinary access to the database and SELECT/VIEW
--   DEFINITION on the target object; this DMF is not gated by VIEW SERVER STATE.
-- Parameters:
--   @ObjectId        (int, REQUIRED, no default) -- object_id of the table/view to inspect. This
--     probe deliberately does not accept NULL for @ObjectId: passing NULL here (with NULL
--     @IndexId/@PartitionNumber) makes the engine enumerate every index in every table in the
--     database, which Microsoft's own documentation flags as resource-intensive. Callers must
--     resolve a specific object_id (e.g. from index.usage_summary.sql or OBJECT_ID()) first.
--   @IndexId         (int, optional, default NULL) -- NULL returns all indexes on @ObjectId.
--   @PartitionNumber (int, optional, default NULL) -- NULL returns all partitions.
-- Result contract: zero or more rows, one per (object_id, index_id, partition_number). Counters
--   are cumulative since the last engine restart or the index's last rebuild, whichever is more
--   recent; *_wait_in_ms columns are milliseconds, *_count columns are raw counts (not pages).
-- Relative cost: low-to-medium, bounded by requiring a specific @ObjectId (never a full-database
--   scan).
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    ios.object_id,
    ios.index_id,
    i.name AS index_name,
    ios.partition_number,
    ios.leaf_insert_count,
    ios.leaf_delete_count,
    ios.leaf_update_count,
    ios.leaf_ghost_count,
    ios.range_scan_count,
    ios.singleton_lookup_count,
    ios.page_latch_wait_count,
    ios.page_latch_wait_in_ms,
    ios.page_io_latch_wait_count,
    ios.page_io_latch_wait_in_ms,
    ios.row_lock_count,
    ios.row_lock_wait_count,
    ios.row_lock_wait_in_ms,
    ios.page_lock_count,
    ios.page_lock_wait_count,
    ios.page_lock_wait_in_ms,
    ios.index_lock_promotion_attempt_count,
    ios.index_lock_promotion_count
FROM sys.dm_db_index_operational_stats(DB_ID(), @ObjectId, @IndexId, @PartitionNumber) AS ios
LEFT JOIN sys.indexes AS i
    ON i.object_id = ios.object_id
   AND i.index_id = ios.index_id;
