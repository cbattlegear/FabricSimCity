-- Probe: querystore.options_2019
-- Purpose: Query Store operating mode and configured limits, including the CUSTOM capture-policy
--   and wait-statistics-capture columns added after the 2016 base view.
-- Connection scope: database (assumes the client opened a connection to the target database).
-- Minimum platform: SQL Server 2019 (15.x) for capture_policy_* columns (wait_stats_capture_mode
--   itself only needs SQL Server 2017 (14.x)). Valid unchanged through SQL Server 2022 (16.x)+ and
--   on Azure SQL Database.
-- Permission: SQL Server 2019 (15.x) requires VIEW DATABASE STATE. SQL Server 2022 (16.x) and later
--   require VIEW DATABASE PERFORMANCE STATE (or VIEW DATABASE STATE, which still covers it).
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
    qso.query_capture_mode_desc, -- 4 = CUSTOM is only meaningful from SQL Server 2019 (15.x)
    qso.size_based_cleanup_mode,
    qso.size_based_cleanup_mode_desc,
    qso.wait_stats_capture_mode,      -- SQL Server 2017 (14.x)+
    qso.wait_stats_capture_mode_desc, -- SQL Server 2017 (14.x)+
    qso.capture_policy_execution_count,             -- SQL Server 2019 (15.x)+, CUSTOM mode only
    qso.capture_policy_total_compile_cpu_time_ms,    -- SQL Server 2019 (15.x)+, CUSTOM mode only
    qso.capture_policy_total_execution_cpu_time_ms,  -- SQL Server 2019 (15.x)+, CUSTOM mode only
    qso.capture_policy_stale_threshold_hours,        -- SQL Server 2019 (15.x)+, CUSTOM mode only
    qso.actual_state_additional_info -- currently unused by the engine; reserved for future diagnostics
FROM sys.database_query_store_options AS qso;
