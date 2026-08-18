-- Probe: server.database_discovery
-- Purpose: Enumerate databases visible on the connection so the collector can decide which
--   databases to open per-database probes against.
-- Connection scope: master (conventional); sys.databases is a server-scoped catalog view visible
--   from any database context on-box, but the visible row set differs by platform (see below).
-- Minimum platform: SQL Server 2016 (13.x).
-- Permission: VIEW ANY DATABASE, granted to public by default since SQL Server 2016 SP1; a login
--   without visibility into a given database will not see its row at all (no error, silent filter).
-- Azure SQL Database scope: supported, but row visibility depends on connection context and
--   permission -- not a blanket unsupported case. Connected to the `master` database with sufficient
--   permission (server admin, Microsoft Entra admin, or an equivalent role), sys.databases can
--   enumerate every database visible on the logical server. Connected to a user database instead,
--   sys.databases returns only the `master` pseudo-row and the current database itself; it cannot
--   enumerate sibling databases from that context. Run this probe against a `master` connection when
--   full-server enumeration is required; when only a user-database connection is available, treat
--   the result as scoped to that database plus `master`, not the whole logical server.
-- Result contract: zero or more rows, one per visible database.
-- Relative cost: trivial.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    d.database_id,
    d.name                      AS database_name,
    d.state_desc,
    d.recovery_model_desc,
    d.containment_desc,
    d.compatibility_level,
    d.is_read_only,
    d.is_auto_close_on,
    d.is_query_store_on,
    d.user_access_desc,
    d.collation_name,
    d.create_date
FROM sys.databases AS d
ORDER BY d.database_id;
