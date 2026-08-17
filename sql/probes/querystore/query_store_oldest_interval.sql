SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT MIN(rsi.start_time) AS oldest_interval_start,
       MAX(rsi.runtime_stats_interval_id) AS latest_interval_id
FROM sys.query_store_runtime_stats_interval AS rsi;
