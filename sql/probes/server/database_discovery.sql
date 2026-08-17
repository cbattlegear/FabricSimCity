-- Probe: server.database_discovery
-- Purpose: Enumerate databases visible on the connection so the collector can decide which
--   databases to open per-database probes against.
-- Connection scope: master (conventional); sys.databases is a server-scoped catalog view visible
--   from any database context on-box, but the visible row set differs by platform (see below).
-- Minimum platform: SQL Server 2016 (13.x).
-- Permission: VIEW ANY DATABASE, granted to public by default since SQL Server 2016 SP1; a login
--   without visibility into a given database will not see its row at all (no error, silent filter).
-- Azure SQL Database scope limitation: sys.databases on Azure SQL Database only returns the
--   `master` pseudo-database and the single user database the connection is opened against -- it
--   cannot enumerate every database on the logical server. Database discovery across an Azure SQL
--   Database logical server requires calling this probe once per known database name, or using the
--   Azure Resource Manager / `sys.databases` in `master` from a connection opened to `master`.
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
