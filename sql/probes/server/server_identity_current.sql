-- Probe: server.identity_current
-- Purpose: Minimal engine and current-database identity for database-scoped capability selection.
-- Connection scope: current database.
-- Permission: ordinary access to the current database; SERVERPROPERTY() requires no special permission.
-- Result contract: exactly one row for the current database.
-- Relative cost: trivial (one current-database catalog row).
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    CAST(SERVERPROPERTY('ProductVersion')      AS nvarchar(128)) AS product_version,
    CAST(SERVERPROPERTY('ProductMajorVersion') AS nvarchar(128)) AS product_major_version,
    CAST(SERVERPROPERTY('EngineEdition')       AS int)           AS engine_edition,
    d.compatibility_level
FROM sys.databases AS d
WHERE d.database_id = DB_ID();
