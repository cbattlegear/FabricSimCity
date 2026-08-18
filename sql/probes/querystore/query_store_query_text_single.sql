-- On-demand sensitive payload. The caller must encrypt the returned text in IProtectedRecordStore.
-- Never run this as a summary or background bulk probe. SQL Server requires VIEW SERVER STATE
-- through 2019 or VIEW SERVER PERFORMANCE STATE on 2022+; Azure SQL uses database-scoped state.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    qt.query_text_id,
    qt.statement_sql_handle,
    qt.is_part_of_encrypted_module,
    qt.has_restricted_text,
    qt.query_sql_text
FROM sys.query_store_query_text AS qt
WHERE qt.query_text_id = @QueryTextId;
