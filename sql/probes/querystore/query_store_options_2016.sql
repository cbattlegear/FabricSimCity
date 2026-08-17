-- Probe: querystore.options_2016
-- Purpose: Query Store operating mode and configured limits, base column set.
-- Connection scope: database (assumes the client opened a connection to the target database).
-- Minimum platform: SQL Server 2016 (13.x); columns here are stable through SQL Server 2017 (14.x).
--   Use querystore/query_store_options_2019.sql on SQL Server 2019 (15.x) and later, and on Azure
--   SQL Database, to also collect the CUSTOM capture-policy columns.
-- Permission: SQL Server 2016 (13.x) through 2019 (15.x) require VIEW DATABASE STATE.
--   SQL Server 2022 (16.x) and later require VIEW DATABASE PERFORMANCE STATE (or VIEW DATABASE
--   STATE, which still covers it).
-- Result contract: zero rows if Query Store was never enabled for this database, otherwise exactly
--   one row describing the current configuration.
-- Relative cost: trivial.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    qso.desired_state,
    qso.desired_state_desc,
    qso.actual_state,
    qso.actual_state_desc,
    qso.readonly_reason, -- bitmask; see sql/README.md for bit meanings
    qso.current_storage_size_mb,
    qso.flush_interval_seconds,
    qso.interval_length_minutes,
    qso.max_storage_size_mb,
    qso.stale_query_threshold_days,
    qso.max_plans_per_query,
    qso.query_capture_mode,
    qso.query_capture_mode_desc,
    qso.size_based_cleanup_mode,
    qso.size_based_cleanup_mode_desc
FROM sys.database_query_store_options AS qso;
