-- Probe: sessions.memory_grants
-- Purpose: Queries that currently hold, or are waiting for, a workspace memory grant. Returns
--   plan_handle/sql_handle as opaque identifiers plus the resolved batch text; does not fetch
--   Showplan XML (no CROSS/OUTER APPLY sys.dm_exec_query_plan here), consistent with keeping this
--   probe's cost low and predictable.
-- Connection scope: server (instance-wide).
-- Minimum platform: SQL Server 2016 (13.x) for reserved_worker_count/used_worker_count/
--   max_used_worker_count/reserved_node_bitmap; the rest of the view is stable back to SQL Server
--   2012 (11.x).
-- Permission: on SQL Server, requires VIEW SERVER STATE (SQL Server 2019 (15.x) and earlier) or
--   VIEW SERVER PERFORMANCE STATE (SQL Server 2022 (16.x)+). On Azure SQL Database, requires VIEW
--   DATABASE STATE in the database (scheduler_id, wait_order, pool_id, group_id are filtered to
--   NULL there to avoid exposing cross-tenant placement information).
-- Result contract: zero or more rows, one per (session_id, request_id) with a memory grant request.
--   Memory columns are KiB. grant_time IS NULL is the authoritative "still waiting for a grant"
--   signal (Microsoft documents grant_time as "NULL if memory is not granted yet"); a non-NULL
--   grant_time means the grant has been issued. wait_time_ms has the OPPOSITE null-timing from
--   grant_time: Microsoft documents it as "NULL if the memory is already granted", i.e. it is
--   populated only WHILE the request is waiting and reads NULL once granted -- do not read the two
--   columns as sharing one "NULL until granted" story; grant_time flips from NULL to non-NULL at
--   grant time, wait_time_ms flips from non-NULL to NULL at that same moment.
-- Relative cost: low; in-memory query-execution state, no plan-cache scan.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    mg.session_id,
    mg.request_id,
    mg.scheduler_id,
    mg.dop,
    mg.request_time,
    mg.grant_time,
    mg.requested_memory_kb,
    mg.granted_memory_kb,
    mg.required_memory_kb,
    mg.used_memory_kb,
    mg.max_used_memory_kb,
    mg.ideal_memory_kb,
    mg.query_cost,
    mg.timeout_sec,
    mg.resource_semaphore_id,
    mg.queue_id,
    mg.wait_order,
    mg.is_next_candidate,
    mg.wait_time_ms,
    mg.group_id,
    mg.pool_id,
    mg.plan_handle, -- opaque; resolve XML via a separate, explicit single-plan lookup only
    mg.sql_handle,
    st.text AS batch_text
FROM sys.dm_exec_query_memory_grants AS mg
OUTER APPLY sys.dm_exec_sql_text(mg.sql_handle) AS st;
