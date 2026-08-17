-- Probe: scheduler.pressure
-- Purpose: Per-scheduler CPU/runnable-queue pressure signals, for detecting CPU scheduling
--   bottlenecks (as distinct from lock/latch/IO waits).
-- Connection scope: server (instance-wide).
-- Minimum platform: SQL Server 2016 (13.x) for total_cpu_usage_ms/total_scheduler_delay_ms; base
--   columns are stable back to SQL Server 2008 (10.0.x). ideal_workers_limit requires SQL Server
--   2019 (15.x)+ and reads NULL on 2016 (13.x)/2017 (14.x).
-- Permission: On SQL Server / SQL Managed Instance, requires VIEW SERVER STATE (SQL Server 2019
--   (15.x) and earlier) or VIEW SERVER PERFORMANCE STATE (SQL Server 2022 (16.x)+). On Azure SQL
--   Database Basic/S0/S1 and elastic pools, requires the server admin, Microsoft Entra admin
--   account, or membership in the ##MS_ServerStateReader## server role; on other Azure SQL
--   Database service objectives, requires VIEW DATABASE STATE or ##MS_ServerStateReader##
--   membership. On Azure SQL Database the visible scheduler count reflects the database's assigned
--   vCore/DTU allocation, not a physical host's processor count.
-- Result contract: one row per VISIBLE ONLINE scheduler (hidden/internal schedulers, such as the
--   dedicated administrator connection scheduler, are excluded). runnable_tasks_count > 0 alongside
--   a high current_tasks_count is the classic CPU-pressure signature (SOS_SCHEDULER_YIELD waits).
--   total_cpu_usage_ms and total_scheduler_delay_ms are cumulative since the last engine start and
--   must be delta'd across polls the same way as io/file_io_stats.sql.
-- Relative cost: trivial; in-memory scheduler list, fixed and small (one row per logical CPU).
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    sch.scheduler_id,
    sch.cpu_id,
    sch.parent_node_id,
    sch.status,
    sch.is_online,
    sch.is_idle,
    sch.current_tasks_count,
    sch.runnable_tasks_count,
    sch.current_workers_count,
    sch.active_workers_count,
    sch.work_queue_count,
    sch.pending_disk_io_count,
    sch.load_factor,
    sch.yield_count,
    sch.context_switches_count,
    sch.preemptive_switches_count,
    sch.total_cpu_usage_ms,        -- SQL Server 2016 (13.x)+, cumulative since engine start
    sch.total_scheduler_delay_ms,  -- SQL Server 2016 (13.x)+, cumulative since engine start
    sch.ideal_workers_limit        -- SQL Server 2019 (15.x)+; NULL on older engines
FROM sys.dm_os_schedulers AS sch
WHERE sch.status = 'VISIBLE ONLINE';
