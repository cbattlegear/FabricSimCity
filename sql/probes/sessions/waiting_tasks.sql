-- Probe: sessions.waiting_tasks
-- Purpose: Current wait queue of tasks, preserving exec_context_id (for parallel requests where
--   different tasks of the same request wait on different resources) and the raw
--   blocking_session_id sentinel values without reinterpreting them.
-- Connection scope: server (instance-wide).
-- Minimum platform: SQL Server 2016 (13.x).
-- Permission: SQL Server 2019 (15.x) and earlier require VIEW SERVER STATE. SQL Server 2022 (16.x)
--   and later require VIEW SERVER PERFORMANCE STATE.
-- Parameters:
--   @MinWaitMs (int, optional, default 0) -- lower bound on wait_duration_ms.
-- Result contract: zero or more rows, one per waiting task. blocking_session_id is passed through
--   unmodified: NULL means not blocked or unknown; -2 = orphaned distributed transaction owns the
--   resource; -3 = a deferred recovery transaction owns the resource; -4 = the blocking latch
--   owner could not be determined due to an internal latch state transition; -5 = the blocking
--   latch owner is not tracked for this latch type (commonly benign, e.g. SH latches). Do not
--   coerce negative sentinel values to 0 or NULL; the application layer is responsible for
--   interpreting them.
-- Relative cost: low; in-memory wait-queue state.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    wt.waiting_task_address,
    wt.session_id,
    wt.exec_context_id,
    wt.wait_duration_ms,
    wt.wait_type,
    wt.resource_address,
    wt.blocking_task_address,
    wt.blocking_session_id, -- raw sentinel values preserved; see comment above
    wt.resource_description
FROM sys.dm_os_waiting_tasks AS wt
WHERE wt.session_id IS NOT NULL
  AND wt.wait_duration_ms >= @MinWaitMs;
