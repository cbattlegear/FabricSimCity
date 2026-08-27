-- Probe: sessions.completed_query_stats
-- Purpose: Executions the instance has *finished* since the caller last looked, read from the plan
--   cache's cumulative per-plan counters. This is the companion to sessions.active_requests, and it
--   exists because that probe structurally cannot see a short query: sys.dm_exec_requests holds a
--   row only while a request is executing, so an OLTP statement that takes a millisecond is invisible
--   unless a sample lands inside that millisecond. Measured against the AdventureWorks churn workload
--   (tools/measure), 12 samples taken 250 ms apart across one 3-second window caught 8 request rows
--   in total, while sys.dm_exec_query_stats recorded 364 executions over the same 3 seconds -- so
--   sampling live requests observed roughly 2% of the work the instance actually did, and the 98%
--   was not "quiet", it was simply never sampled. At the collector's real 2-5 s cadence the gap is
--   wider still.
-- Connection scope: server (instance-wide; the caller filters by database from database_id).
-- Minimum platform: SQL Server 2016 (13.x).
-- Permission: SQL Server 2019 (15.x) and earlier require VIEW SERVER STATE (or, on Azure SQL
--   Database, VIEW DATABASE STATE, which restricts visibility to the current database). SQL Server
--   2022 (16.x) and later require VIEW SERVER PERFORMANCE STATE.
-- Parameters:
--   @SinceEngineLocal (datetime2, optional, default NULL) -- when supplied, only plans whose
--     last_execution_time is strictly later are returned. NULL returns every cached plan, which is
--     what a first call wants. See "The watermark is a prefilter, not the measurement" below: this
--     bounds how much of the plan cache is returned and is never what decides how many executions
--     happened.
--   @IncludeSqlText (bit, optional, default 1) -- when 0, no SQL text function is invoked and both
--     text columns are NULL. Edge collection uses 0 so raw SQL is never fetched or transmitted.
--   @MaxRows (int, optional, default NULL) -- when supplied, at most this many rows are returned,
--     chosen by selection_rank. NULL returns every matching row. visible_plan_count always reports
--     how many rows matched before the cap.
--   @MaxTextLength (int, optional, default NULL) -- when supplied, batch_text and statement_text are
--     shortened to this many characters. batch_text_length and statement_text_length always report
--     the untruncated lengths.
--
-- The watermark is a prefilter, not the measurement.
--   It would be wrong to read "last_execution_time is newer than the last sample" as "this plan ran
--   once since the last sample". A plan that ran 18 times in the interval reports one
--   last_execution_time exactly like a plan that ran once. The count of executions in an interval is
--   therefore *only* obtainable by differencing execution_count across two reads, which is the
--   collector's job -- this probe returns the cumulative counter and the identity needed to difference
--   it, and uses the timestamp purely to avoid returning the entire plan cache every cycle. Measured
--   on the same instance, the cache held 505 plans of which 103 had advanced over a 3-second window,
--   so the prefilter is worth having; it is not load-bearing for correctness, and passing NULL every
--   time would produce identical execution counts at higher cost.
--   A consequence worth stating: a row can be returned whose execution_count has not moved (its last
--   execution fell between the watermark and the previous read). The collector must difference the
--   counter rather than trusting the row's presence, and it emits nothing for a delta of zero.
--
-- Identity, and why creation_time is part of it.
--   plan_key is the stable identity of one *statement within one cached plan*:
--   sql_handle + plan_handle + both statement offsets, hashed so a 64-byte pair of handles does not
--   travel on every row of every sample. sys.dm_exec_query_stats is keyed on exactly that tuple, and
--   the statement offsets are part of it because a single cached batch or procedure holds one row per
--   statement -- keying on the plan alone would fold every statement of a stored procedure into one
--   counter and report a procedure's executions as if they were a single query's.
--   creation_time travels beside it because the counters are cumulative *since the plan was compiled*
--   and nothing else reports that they restarted. A plan evicted under memory pressure and
--   recompiled, a DBCC FREEPROCCACHE, a statistics-driven recompile, or an engine restart all reuse
--   the same plan_key with execution_count back at a small number. Differencing across that without
--   noticing gives a large negative delta, and clamping a negative delta to zero silently drops every
--   execution until the counter climbs back to its old value -- which on a hot plan is minutes of the
--   feed reporting an idle instance. The collector compares creation_time and treats a change as a
--   reset rather than as a delta.
--
-- What this probe cannot see, stated because an empty result is not an idle instance:
--   * Plans that are never cached: a statement compiled with OPTION (RECOMPILE) leaves no
--     dm_exec_query_stats row at all, and unparameterized ad-hoc text under 'optimize for ad hoc
--     workloads' is stubbed on first execution and only cached on the second.
--   * Natively compiled stored procedures, whose statistics live in
--     sys.dm_exec_procedure_stats and are collected only when the module was created with
--     EXECUTE AS / statistics collection enabled.
--   * Anything evicted between two reads. Its executions are gone with it; the plan reappears later
--     with a new creation_time and is treated as a new plan rather than as a resumed one.
--   These are limitations of the plan cache, not of the query, and the application publishes this as
--   "executions the cache retained", never as a complete accounting of the workload.
--
-- Result contract: zero or more rows, one per (plan_key). execution_count, total_worker_time,
--   total_elapsed_time, total_logical_reads and total_rows are cumulative since creation_time and are
--   meaningless as absolutes here -- they exist to be differenced. The last_* columns describe the
--   single most recent execution and are the honest per-execution figures, which is what a per-query
--   display should use: an average over a plan's whole lifetime is not a description of the execution
--   that just happened.
--   query_hash and query_plan_hash are returned raw, as the binary(8) the engine reports, and are
--   never formatted here -- identical treatment to sessions.active_requests, and for the same reason:
--   one converter renders them so the two sides of a join cannot disagree about case or an 0x prefix.
--   They are the same values Query Store stores, which is what lets an execution found here be
--   attributed to the query family already drawn on the map.
--   database_id is resolved from sys.dm_exec_plan_attributes, NOT from sys.dm_exec_sql_text.dbid.
--   That is not interchangeable and the difference is total: sys.dm_exec_sql_text returns a NULL dbid
--   for ad-hoc and prepared statements, which is the overwhelming majority of an application
--   workload. Measured on the churn instance, the five most recently executed plans all reported
--   dbid NULL from sys.dm_exec_sql_text and 'AdventureWorks' from the plan attribute -- so a probe
--   built on the text function's dbid would attribute almost nothing, and a per-database feed reading
--   it would sit permanently empty while the server was saturated. sql_text.dbid is still used as a
--   fallback for the rows where the attribute is absent or zero.
-- Relative cost: medium; enumerates cached plan statistics (505 rows on the measured instance) and
--   resolves text and one plan attribute per returned row, so cost scales with @MaxRows rather than
--   with the size of the cache.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

WITH advanced AS (
    SELECT
        deqs.sql_handle,
        deqs.plan_handle,
        deqs.statement_start_offset,
        deqs.statement_end_offset,
        deqs.creation_time,
        deqs.last_execution_time,
        deqs.execution_count,
        deqs.total_worker_time,
        deqs.last_worker_time,
        deqs.total_elapsed_time,
        deqs.last_elapsed_time,
        deqs.total_logical_reads,
        deqs.last_logical_reads,
        deqs.total_rows,
        deqs.last_rows,
        deqs.query_hash,
        deqs.query_plan_hash
    FROM sys.dm_exec_query_stats AS deqs
    WHERE @SinceEngineLocal IS NULL
       OR deqs.last_execution_time > @SinceEngineLocal
),
identified AS (
    SELECT
        a.*,
        -- Hashed rather than shipped whole: sql_handle and plan_handle are varbinary(64) each, so
        -- carrying both verbatim costs ~256 characters of hex on every row of every sample for a
        -- value the reader never looks at. The hash is deterministic and stable across calls, which
        -- is all the collector needs to line this cycle's row up with the last one. Same reasoning
        -- as deadlock_id in sessions.deadlock_graphs.
        CONVERT(char(64), HASHBYTES('SHA2_256',
            CONVERT(varbinary(max), a.sql_handle)
                + CONVERT(varbinary(max), a.plan_handle)
                + CONVERT(binary(4), a.statement_start_offset)
                + CONVERT(binary(4), a.statement_end_offset)), 2) AS plan_key,
        COUNT(*) OVER ()  AS visible_plan_count,
        ROW_NUMBER() OVER (
            ORDER BY
                a.last_execution_time DESC,
                a.plan_handle,
                a.statement_start_offset) AS selection_rank
    FROM advanced AS a
)
SELECT
    i.plan_key,
    -- Returned so the caller can pass it back as the next @SinceEngineLocal. The watermark must
    -- never be the *collecting process's* clock: last_execution_time is the engine's local time, the
    -- collector may run in another time zone or on a machine whose clock has drifted, and a watermark
    -- even slightly ahead of the engine's clock silently filters out executions that really happened.
    -- SYSDATETIME() is a runtime constant -- evaluated once at the start of the query, not per row --
    -- so every row of one sample carries the same instant and it precedes the cache read. Verified on
    -- the measured instance: all rows of a sample reported 2026-08-27 21:32:56.463 identically.
    -- Taking it before the read leaves no gap either: an execution landing *during* the read has
    -- last_execution_time > this value and is picked up next cycle, where differencing
    -- execution_count is what stops it being counted twice.
    SYSDATETIME()               AS sampled_at_engine_local,
    i.creation_time,
    i.last_execution_time,
    i.execution_count,
    i.total_worker_time         AS total_worker_time_us,
    i.last_worker_time          AS last_worker_time_us,
    i.total_elapsed_time        AS total_elapsed_time_us,
    i.last_elapsed_time         AS last_elapsed_time_us,
    i.total_logical_reads,
    i.last_logical_reads,
    i.total_rows,
    i.last_rows,
    i.query_hash,               -- binary(8); joins to sys.query_store_query.query_hash
    i.query_plan_hash,          -- binary(8); joins to sys.query_store_plan.query_plan_hash
    -- NULLIF(..., 0) because the attribute reports 0 for a plan with no owning database context;
    -- zero is not database zero, it is "unattributed", and coalescing it would file those executions
    -- under whichever database happened to be id 0.
    COALESCE(NULLIF(pa.database_id, 0), st.dbid) AS database_id,
    DB_NAME(COALESCE(NULLIF(pa.database_id, 0), st.dbid)) AS database_name,
    i.visible_plan_count,
    i.selection_rank,
    CAST(DATALENGTH(st.text) / 2 AS int) AS batch_text_length,
    CASE
        WHEN @MaxTextLength IS NULL THEN st.text
        ELSE LEFT(st.text, @MaxTextLength)
    END                         AS batch_text,
    -- The true character count of the statement, with no "+ 1"; see the identical note in
    -- sessions.active_requests for why the classic offset idiom's extra character must not be
    -- reported as length. statement_end_offset is -1 for the last statement of a batch.
    CAST(
        (CASE i.statement_end_offset
             WHEN -1 THEN DATALENGTH(st.text)
             ELSE i.statement_end_offset
         END - i.statement_start_offset) / 2 AS int) AS statement_text_length,
    SUBSTRING(
        st.text,
        (i.statement_start_offset / 2) + 1,
        CASE
            WHEN @MaxTextLength IS NULL THEN
                (
                    (CASE i.statement_end_offset
                         WHEN -1 THEN DATALENGTH(st.text)
                         ELSE i.statement_end_offset
                     END - i.statement_start_offset) / 2
                ) + 1
            ELSE
                CASE
                    WHEN (
                        (
                            (CASE i.statement_end_offset
                                 WHEN -1 THEN DATALENGTH(st.text)
                                 ELSE i.statement_end_offset
                             END - i.statement_start_offset) / 2
                        ) + 1
                    ) > @MaxTextLength THEN @MaxTextLength
                    ELSE
                        (
                            (CASE i.statement_end_offset
                                 WHEN -1 THEN DATALENGTH(st.text)
                                 ELSE i.statement_end_offset
                             END - i.statement_start_offset) / 2
                        ) + 1
                END
        END
    )                            AS statement_text
FROM identified AS i
OUTER APPLY sys.dm_exec_sql_text(CASE WHEN @IncludeSqlText = 1 THEN i.sql_handle END) AS st
OUTER APPLY (
    SELECT TOP (1) CONVERT(int, pa_inner.value) AS database_id
    FROM sys.dm_exec_plan_attributes(i.plan_handle) AS pa_inner
    WHERE pa_inner.attribute = 'dbid'
) AS pa
WHERE @MaxRows IS NULL OR i.selection_rank <= @MaxRows
ORDER BY i.selection_rank;
