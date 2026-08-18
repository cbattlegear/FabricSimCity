-- Probe: index.operational_stats
-- Purpose: Lower-level access/locking/latching statistics for a specific table or view's indexes,
--   for diagnosing contention (lock waits, latch waits) on a known hot object.
-- Connection scope: database (assumes the client opened a connection to the target database).
-- Minimum platform: SQL Server 2016 (13.x).
-- Permission: CONTROL permission on the specified object (the normal case here, since @ObjectId is
--   required). Requesting all objects in a database (an unsupported use of this probe: passing NULL
--   for @ObjectId) additionally requires VIEW DATABASE STATE (SQL Server 2016 (13.x) through 2019
--   (15.x)) or VIEW DATABASE PERFORMANCE STATE (SQL Server 2022 (16.x)+); requesting all databases
--   (also unsupported here) additionally requires VIEW SERVER STATE / VIEW SERVER PERFORMANCE STATE.
--   Granting or denying VIEW DATABASE STATE / VIEW DATABASE PERFORMANCE STATE overrides a per-object
--   CONTROL grant or deny.
-- Parameters:
--   @ObjectId        (int, REQUIRED, no default) -- object_id of the table/view to inspect. This
--     probe deliberately does not accept NULL for @ObjectId: passing NULL here (with NULL
--     @IndexId/@PartitionNumber) makes the engine enumerate every index in every table in the
--     database, which Microsoft's own documentation flags as resource-intensive. Callers must
--     resolve a specific object_id (e.g. from index.usage_summary.sql or OBJECT_ID()) first. As a
--     fail-safe against a caller passing NULL anyway, the query below wraps @ObjectId in
--     COALESCE(@ObjectId, -1): -1 never matches a real object_id, so a NULL parameter returns zero
--     rows instead of silently falling back to the DMF's NULL-is-wildcard behavior and triggering
--     the full-database enumeration this probe is bounded specifically to avoid. (object_id = 0 is
--     NOT a safe sentinel: sys.dm_db_index_operational_stats treats 0 the same as NULL/DEFAULT, i.e.
--     as a wildcard, per Microsoft's documented parameter semantics.)
--   @IndexId         (int, optional, default NULL) -- NULL returns all indexes on @ObjectId.
--   @PartitionNumber (int, optional, default NULL) -- NULL returns all partitions.
-- Result contract: zero or more rows, one per (object_id, index_id, partition_number). Counters are
--   maintained only while the heap/B-tree's metadata-cache entry for that object exists in memory:
--   they reset to zero when that metadata is (re)cached (e.g. after an engine restart, failover, or
--   the object/index being touched for the first time in the cache's lifetime) and the counters
--   disappear entirely when the underlying object, index, or partition is dropped or truncated.
--   Certain other DDL against the object can also reset counters to zero without dropping anything.
--   This is a metadata-cache-eviction-driven reset, not simply "since last restart or rebuild" --
--   do not assume a long-uninterrupted value implies a long-uninterrupted server uptime.
--   *_wait_in_ms columns are milliseconds, *_count columns are raw counts (not pages).
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
FROM sys.dm_db_index_operational_stats(DB_ID(), COALESCE(@ObjectId, -1), @IndexId, @PartitionNumber) AS ios
LEFT JOIN sys.indexes AS i
    ON i.object_id = ios.object_id
   AND i.index_id = ios.index_id;
