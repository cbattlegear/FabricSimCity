-- Probe: sessions.blocking_inputs
-- Purpose: Raw facts needed to reconstruct a blocking chain -- active blocked requests, and idle
--   sessions holding an open transaction that could be a "root" blocker with no active request of
--   their own. This probe intentionally does NOT walk blocking_session_id chains, compute a root,
--   or build a graph: it returns facts and leaves graph construction to the application, which can
--   combine this with sessions/waiting_tasks.sql (exec_context_id-level detail) as needed.
-- Connection scope: server (instance-wide).
-- Minimum platform: SQL Server 2016 (13.x).
-- Permission: SQL Server 2019 (15.x) and earlier require VIEW SERVER STATE. SQL Server 2022 (16.x)
--   and later require VIEW SERVER PERFORMANCE STATE.
-- Result contract: zero or more rows tagged by fact_source. 'blocked_request' rows come from
--   sys.dm_exec_requests where blocking_session_id is a real, non-zero session id (raw sentinel
--   values such as -2/-3/-4/-5 are preserved, not filtered out). 'idle_open_transaction' rows come
--   from sleeping user sessions that still hold at least one open transaction and therefore could
--   be blocking others without showing up as a request themselves; this is exactly one row per
--   session_id even under MARS. sys.dm_tran_session_transactions can return MULTIPLE rows for the
--   same session_id (one per active transaction on a multi-active-result-set/MARS connection, or
--   when a session is enlisted in more than one transaction context); a naive join would emit
--   duplicate idle_open_transaction facts for one session. This probe pre-aggregates that DMV to
--   one row per session_id via MAX(open_transaction_count) before joining, because
--   open_transaction_count is documented as the count of open transactions FOR THE SESSION and is
--   reported identically on every row for that session -- MAX (not SUM) collapses the duplicates
--   to that one true per-session count without inflating it.
-- Relative cost: low; in-memory session/request/transaction state.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    'blocked_request'          AS fact_source,
    r.session_id,
    r.request_id,
    r.blocking_session_id,     -- raw sentinel values preserved; see sql/README.md
    r.wait_type,
    r.wait_time                AS wait_time_ms,
    r.wait_resource,
    r.status,
    r.open_transaction_count,
    r.start_time,
    r.command,
    r.database_id
FROM sys.dm_exec_requests AS r
WHERE r.blocking_session_id <> 0

UNION ALL

SELECT
    'idle_open_transaction'    AS fact_source,
    s.session_id,
    NULL                        AS request_id,
    NULL                        AS blocking_session_id,
    NULL                        AS wait_type,
    NULL                        AS wait_time_ms,
    NULL                        AS wait_resource,
    s.status,
    tst.open_transaction_count,
    s.last_request_end_time    AS start_time,
    NULL                        AS command,
    NULL                        AS database_id
FROM sys.dm_exec_sessions AS s
JOIN (
    -- Pre-aggregate to one row per session_id: sys.dm_tran_session_transactions can return
    -- multiple rows for the same session under MARS, and open_transaction_count is a per-session
    -- value repeated on each of those rows, so MAX collapses duplicates without inflating the count.
    SELECT
        tst.session_id,
        MAX(tst.open_transaction_count) AS open_transaction_count
    FROM sys.dm_tran_session_transactions AS tst
    GROUP BY tst.session_id
) AS tst
    ON tst.session_id = s.session_id
WHERE s.is_user_process = 1
  AND s.status = 'sleeping'
  AND tst.open_transaction_count > 0;
