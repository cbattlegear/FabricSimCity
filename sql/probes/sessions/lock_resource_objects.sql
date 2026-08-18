-- Probe: sessions.lock_resource_objects
-- Purpose: Resolve a bounded, caller-supplied set of hobt_id values (taken verbatim from
--   sys.dm_exec_requests.wait_resource / sys.dm_os_waiting_tasks.resource_description) to the
--   schema/object/index they belong to, so a live lock wait can be attributed to a real table
--   instead of an opaque number. KEY, HOBT, and ALLOCUNIT lock resources name a hobt_id and nothing
--   else; only sys.partitions can turn that into an object_id.
-- Connection scope: database. A hobt_id is only meaningful inside the database that reported it, so
--   the caller must connect to that database. Resolving a hobt from the wrong database would
--   silently return a different object.
-- Minimum platform: SQL Server 2016 (13.x). STRING_SPLIT additionally requires the *database*
--   compatibility level to be 130 or higher; on a lower compatibility level this probe fails and the
--   caller must report the lock as unresolved rather than guessing an object.
-- Permission: ordinary access to the current database. sys.partitions, sys.objects, sys.indexes, and
--   sys.schemas are catalog views subject to metadata visibility rules, so a caller only sees objects
--   it already has some permission on. Rows for invisible objects are simply absent, which the caller
--   must treat as "not resolved", never as "not a user object".
-- Parameters:
--   @HobtIds (nvarchar(max), required) -- comma-separated hobt_id values collected from the current
--     wait sample. The caller must bound this list; it is built from engine-reported wait resources,
--     never from user input, and is passed as a parameter so no SQL is ever concatenated.
--   @TopN (int, required) -- hard cap on returned rows via TOP(@TopN), so a pathological input list
--     cannot produce an unbounded result set.
-- Result contract: zero or more rows, at most one per (hobt_id, object_id, index_id). A hobt_id that
--   is absent from the result was not resolved -- because it belongs to another database, to an
--   internal/ms-shipped object, or to an object the caller cannot see. Absence is never evidence that
--   the lock is not on a user object.
-- Relative cost: low; catalog-view lookups keyed on hobt_id over a small bounded list.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT TOP (@TopN)
    p.hobt_id,
    p.object_id,
    p.index_id,
    s.name AS schema_name,
    o.name AS object_name,
    i.name AS index_name,
    o.type_desc AS object_type_desc,
    DB_ID() AS database_id,
    DB_NAME() AS database_name
FROM STRING_SPLIT(@HobtIds, ',') AS ids
INNER JOIN sys.partitions AS p
    ON p.hobt_id = TRY_CONVERT(bigint, LTRIM(RTRIM(ids.value)))
INNER JOIN sys.objects AS o
    ON o.object_id = p.object_id
INNER JOIN sys.schemas AS s
    ON s.schema_id = o.schema_id
LEFT JOIN sys.indexes AS i
    ON i.object_id = p.object_id
   AND i.index_id = p.index_id
WHERE o.is_ms_shipped = 0
ORDER BY p.hobt_id, p.object_id, p.index_id;
