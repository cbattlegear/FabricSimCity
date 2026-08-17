-- SQL Server 2016+ on-demand query text variant without restricted-text metadata.
-- The caller must immediately encrypt any returned query_sql_text.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    qt.query_text_id,
    qt.statement_sql_handle,
    qt.is_part_of_encrypted_module,
    CAST(0 AS bit) AS has_restricted_text,
    qt.query_sql_text
FROM sys.query_store_query_text AS qt
WHERE qt.query_text_id = @QueryTextId;
