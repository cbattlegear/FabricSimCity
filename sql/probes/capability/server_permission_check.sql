-- Probe: capability.server_permission_check
-- Purpose: Reports whether the current login holds a named server-scoped permission, so the
--   capability negotiation layer can classify server-wide features (waits, live sessions,
--   plans/text) as Supported vs. PermissionDenied directly, instead of inferring permission only
--   from the failure of a much larger telemetry probe.
-- Connection scope: server (HAS_PERMS_BY_NAME reports the connection's own effective permission;
--   the check itself is not tied to a particular database).
-- Minimum platform: SQL Server 2016 (13.x).
-- Permission: HAS_PERMS_BY_NAME() itself requires no special permission; it reports on the
--   caller's own effective permission set and never grants, denies, or reveals another
--   principal's permissions.
-- Azure SQL Database: supported. Azure SQL Database enforces database-scoped VIEW DATABASE STATE
--   in place of server-scoped VIEW SERVER STATE for most session/wait DMVs (see sql/README.md), so
--   a server-permission check here is informational on Azure SQL Database; the negotiator must
--   additionally run capability.database_permission_check there.
-- Result contract: exactly one row. has_permission is 1 when the connection's effective permission
--   set includes @Permission at server scope, 0 when it does not, and NULL when SQL Server cannot
--   evaluate the given securable/permission combination on this platform.
-- Relative cost: trivial.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT HAS_PERMS_BY_NAME(NULL, NULL, @Permission) AS has_permission;
