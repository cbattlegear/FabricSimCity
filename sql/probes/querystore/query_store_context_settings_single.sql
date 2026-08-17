-- Context SET settings are non-secret identity metadata and remain drillable per physical query.
SET NOCOUNT ON;
SET DEADLOCK_PRIORITY LOW;
SET LOCK_TIMEOUT 5000;

SELECT
    cs.context_settings_id,
    cs.set_options,
    cs.language_id,
    cs.date_format,
    cs.date_first,
    cs.status
FROM sys.query_context_settings AS cs
WHERE cs.context_settings_id = @ContextSettingsId;
