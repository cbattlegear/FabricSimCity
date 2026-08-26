-- Probe: sessions.deadlock_graphs
-- Purpose: Deadlocks the engine has already recorded, read back as deadlock graphs, so a consumer
--   can report where a deadlock happened rather than only that lock waiting exists right now.
--   Deadlocks are historical by nature: by the time anything can be queried the victim has been
--   rolled back and nothing about the event is visible in sys.dm_exec_requests or
--   sys.dm_os_waiting_tasks. This probe is the only way to see one at all.
-- Connection scope: server. The system_health session is server-scoped.
-- Minimum platform: SQL Server 2016 (13.x). HASHBYTES over nvarchar(max) and the system_health
--   event_file target are both available from 2016 onward.
-- Permission: SQL Server 2019 (15.x) and earlier require VIEW SERVER STATE; SQL Server 2022 (16.x)
--   and later require VIEW SERVER PERFORMANCE STATE. sys.fn_xe_file_target_read_file additionally
--   reads the .xel files through the SQL Server service account, so a session with the permission
--   but an engine that cannot reach its own log directory reports an error rather than zero rows --
--   which the application must surface as "not observed", never as "no deadlocks".
--
-- Why the event_file target and not the ring buffer.
--   The obvious source is system_health's ring_buffer target through sys.dm_xe_session_targets, and
--   it is wrong here. The ring buffer's target_data is serialized into a single XML value with a
--   size limit, and on an ordinary instance the limit bites hard: measured on SQL Server 2022
--   (tools/measure), the target reported eventCount="5000" while only 2,752 events survived into the
--   readable XML, and the events lost were the most recent ones -- the newest readable event was 50
--   minutes old, and a deadlock that had occurred two minutes earlier was simply not in the
--   document. A deadlock probe built on that source answers "no deadlock" for a deadlock that just
--   happened, which is the exact failure this catalog exists to avoid: absence of evidence rendered
--   as evidence of absence. The event_file target has no such window, and the same deadlock read
--   back from system_health*.xel in 0.7 s.
--
-- Parameters:
--   @SinceUtc (datetime2, optional, default NULL) -- when supplied, only deadlocks recorded strictly
--     after this UTC instant are returned. NULL returns everything still retained. This filters, it
--     does not bound the read: the file target is scanned either way (see Relative cost).
--   @MaxGraphs (int, optional, default NULL) -- when supplied, at most this many deadlocks are
--     returned, most recent first. NULL returns every retained deadlock. visible_deadlock_count
--     always reports the pre-cap count, so a capped result is never mistaken for a calmer instance.
--   @IncludeSqlText (bit, optional, default 0) -- when 0 (the default) the returned graph is
--     reconstructed with every text-bearing node removed: each <process> keeps all of its attributes
--     and loses its <executionStack> and <inputbuf> children. Attributes carry everything the map
--     needs -- spid, currentdb, waitresource, lockMode, transactionname, clientapp, hostname,
--     loginname -- and the <resource-list> is copied whole because it contains no text at all, only
--     attributes such as objectname and indexname plus owner/waiter id references. When 1 the graph
--     is returned exactly as the engine recorded it, statement text included. The default is 0
--     rather than 1 (the opposite of sessions.active_requests) because a deadlock graph's inputbuf
--     is a whole submitted batch for every participant, and unlike a live request there is no
--     operator watching who asked for it.
-- Result contract: zero or more rows, one per recorded deadlock.
--   deadlock_id is stable for a given deadlock across calls and across @IncludeSqlText settings: it
--   is the event timestamp plus a SHA2_256 of the redacted graph, and the redacted form is hashed
--   precisely so that asking for statement text does not change a deadlock's identity.
--   deadlock_xml is a complete, parseable graph or it is absent. It is never truncated, because half
--   a graph is not a graph -- a length cap here would produce XML that no reader could open, which
--   is a worse omission than a missing row. The bound is on the number of graphs instead, and
--   deadlock_xml_length reports the character count so a consumer can see what it is holding.
--   process_count / resource_count / victim_count are counted from the graph itself rather than
--   inferred by the caller, so a consumer can tell a two-process deadlock from a cycle of five
--   without parsing anything.
--   ZERO ROWS MEANS "no deadlock is retained in system_health for the window read". It does not mean
--   "this instance has no deadlocks". system_health rolls its files over (four 5 MB files by
--   default), so a deadlock older than the retained window is gone, and an instance where the
--   session was stopped or altered records nothing at all. The application must report this as an
--   observation window, not as a clean bill of health.
-- Relative cost: medium. Bounded by the system_health session's own file retention, not by database
--   size: measured on SQL Server 2022 (tools/measure) a full scan of the default four-file set read
--   38,319 events in 0.70-1.11 s. object_name is a column of the table-valued function, so the
--   deadlock filter is applied before any XML is parsed and only matching events are shredded. That
--   is cheap per deadlock and not cheap per call, which is why this is a standard-cadence probe and
--   must not be put on the live sampler's 2-5 second cycle.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

WITH recorded AS (
    -- The path is a literal, not a parameter. There is exactly one session this probe understands,
    -- and accepting a caller-supplied path would turn a read-only diagnostic into a way to ask the
    -- service account to read an arbitrary file off the host.
    SELECT
        f.timestamp_utc,
        CAST(f.event_data AS xml) AS event_xml
    FROM sys.fn_xe_file_target_read_file('system_health*.xel', NULL, NULL, NULL) AS f
    WHERE f.object_name = 'xml_deadlock_report'
),
graphs AS (
    SELECT
        r.timestamp_utc,
        -- Rebuilt rather than filtered: XQuery cannot remove a node from a result, so the redacted
        -- form is constructed from the parts that are safe to keep. <process> is copied
        -- attributes-only, which drops <executionStack> and <inputbuf> -- the only text-bearing
        -- nodes in the graph -- while keeping every attribute the caller actually reasons about.
        -- The path deliberately carries no [@name="xml_report"] predicate. The catalog's parameter
        -- checker scans the whole file for @identifier tokens and cannot tell an XQuery attribute
        -- test from a T-SQL variable, so such a predicate would read as an undeclared parameter.
        -- Dropping it costs nothing: xml_deadlock_report defines exactly one data field, and it is
        -- the only one whose value contains a <deadlock> element, so the step is already unambiguous.
        r.event_xml.query('
            for $d in /event/data/value/deadlock return
              <deadlock>
                { $d/victim-list }
                <process-list>{ for $p in $d/process-list/process return <process>{ $p/@* }</process> }</process-list>
                { $d/resource-list }
              </deadlock>') AS redacted_xml,
        r.event_xml.query('/event/data/value/deadlock') AS full_xml
    FROM recorded AS r
    WHERE @SinceUtc IS NULL OR r.timestamp_utc > @SinceUtc
),
identified AS (
    SELECT
        g.timestamp_utc,
        g.redacted_xml,
        CAST(g.redacted_xml AS nvarchar(max)) AS redacted_text,
        CAST(g.full_xml AS nvarchar(max)) AS full_text,
        -- Identity is derived from the redacted graph on purpose: hashing the full graph would give
        -- the same deadlock two different ids depending on whether the caller asked for statement
        -- text, and a consumer holding both would count one deadlock twice.
        CONVERT(char(23), g.timestamp_utc, 126) + '#'
            + CONVERT(char(64), HASHBYTES('SHA2_256', CAST(g.redacted_xml AS nvarchar(max))), 2) AS deadlock_id
    FROM graphs AS g
),
ranked AS (
    SELECT
        i.timestamp_utc,
        i.redacted_xml,
        i.redacted_text,
        i.full_text,
        i.deadlock_id,
        COUNT(*) OVER () AS visible_deadlock_count,
        -- Most recent first, then by id so the order is total and a cap keeps a deterministic set
        -- rather than an arbitrary one when two deadlocks share a millisecond.
        ROW_NUMBER() OVER (ORDER BY i.timestamp_utc DESC, i.deadlock_id) AS selection_rank
    FROM identified AS i
)
SELECT
    k.deadlock_id,
    k.timestamp_utc                                                  AS deadlock_time_utc,
    k.redacted_xml.value('count(/deadlock/process-list/process)', 'int')        AS process_count,
    k.redacted_xml.value('count(/deadlock/resource-list/*)', 'int')             AS resource_count,
    k.redacted_xml.value('count(/deadlock/victim-list/victimProcess)', 'int')   AS victim_count,
    CAST(@IncludeSqlText AS bit)                                     AS includes_sql_text,
    CASE WHEN @IncludeSqlText = 1 THEN k.full_text ELSE k.redacted_text END     AS deadlock_xml,    CAST(LEN(CASE WHEN @IncludeSqlText = 1 THEN k.full_text ELSE k.redacted_text END) AS int) AS deadlock_xml_length,
    k.visible_deadlock_count,
    k.selection_rank
FROM ranked AS k
WHERE @MaxGraphs IS NULL OR k.selection_rank <= @MaxGraphs;
