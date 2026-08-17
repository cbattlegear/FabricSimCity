-- Probe: server.database_identity_current
-- Purpose: Identify only the database of the current connection, including Azure SQL Database.
-- Connection scope: database.
-- Minimum platform: SQL Server 2016 (13.x).
-- Permission: ordinary access to the current database.
-- Result contract: exactly one row; database_id is connection-local metadata and is never used as
-- a globally stable Azure database identity.
-- Relative cost: trivial.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    d.database_id,
    d.name AS database_name,
    d.state_desc,
    d.compatibility_level,
    d.is_query_store_on
FROM sys.databases AS d
WHERE d.database_id = DB_ID();
