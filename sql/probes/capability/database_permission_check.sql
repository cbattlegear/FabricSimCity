-- Probe: capability.database_permission_check
-- Purpose: Reports whether the current login holds a named database-scoped permission on the
--   currently connected database, so the capability negotiation layer can classify Azure SQL
--   Database features (which enforce VIEW DATABASE STATE / VIEW DATABASE PERFORMANCE STATE in
--   place of the server-scoped permission used on-premises) without attempting the larger
--   telemetry probe first.
-- Connection scope: database (assumes the client already opened a connection to the target
--   database; HAS_PERMS_BY_NAME(DB_NAME(), ...) always evaluates against that connection's own
--   current database, never a sibling database).
-- Minimum platform: SQL Server 2016 (13.x).
-- Permission: HAS_PERMS_BY_NAME() itself requires no special permission; it reports on the
--   caller's own effective permission set and never grants, denies, or reveals another
--   principal's permissions.
-- Azure SQL Database: supported; this is the database-scoped counterpart to
--   capability.server_permission_check, required because most session/wait DMVs require VIEW
--   DATABASE STATE rather than VIEW SERVER STATE there (see sql/README.md).
-- Result contract: exactly one row. has_permission is 1 when the connection's effective permission
--   set includes @Permission on the current database, 0 when it does not, and NULL when SQL
--   Server cannot evaluate the given securable/permission combination on this platform.
-- Relative cost: trivial.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT HAS_PERMS_BY_NAME(DB_NAME(), N'DATABASE', @Permission) AS has_permission;
