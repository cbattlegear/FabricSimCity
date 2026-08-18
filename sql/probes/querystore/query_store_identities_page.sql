SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT TOP (@PageSize)
    q.query_id,
    q.query_text_id,
    q.context_settings_id,
    q.query_hash,
    q.last_execution_time,
    qt.is_part_of_encrypted_module,
    qt.has_restricted_text,
    cs.set_options,
    cs.language_id,
    cs.date_format,
    cs.date_first
FROM sys.query_store_query AS q
JOIN sys.query_store_query_text AS qt ON qt.query_text_id = q.query_text_id
LEFT JOIN sys.query_context_settings AS cs ON cs.context_settings_id = q.context_settings_id
WHERE q.last_execution_time >= @StartTime
  AND q.last_execution_time < @EndTime
  AND (q.last_execution_time > @AfterExecutionTime
       OR (q.last_execution_time = @AfterExecutionTime AND q.query_id > @AfterQueryId))
ORDER BY q.last_execution_time, q.query_id;
