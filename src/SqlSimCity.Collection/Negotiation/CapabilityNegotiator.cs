using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Negotiation;

/// <summary>
/// The source-neutral capability negotiation algorithm. Given any <see cref="IProbeExecutor"/> --
/// a real <c>SqlClientProbeExecutor</c> or a deterministic <c>FixtureProbeExecutor</c> -- this
/// produces the same canonical <see cref="TargetCapabilityProfileV1"/> shape using the same
/// platform/compatibility-level/metadata gating rules. It never trusts a reported major version
/// alone: Parameter Sensitive Plan optimization (PSP) and Optional Parameter Plan Optimization
/// (OPPO) are only enabled once the database's own compatibility level AND the connected engine
/// build's actual catalog metadata both confirm the feature exists. Errors from
/// <see cref="IProbeExecutor"/> are classified via <see cref="ProbeExecutionException"/>
/// subclasses into the matching <see cref="CapabilityState"/>; any other exception type is left to
/// propagate, per this project's documented error boundary.
/// </summary>
public sealed class CapabilityNegotiator : ICapabilityNegotiator
{
    private const string ViewServerState = "VIEW SERVER STATE";
    private const string ViewServerPerformanceState = "VIEW SERVER PERFORMANCE STATE";
    private const string ViewDatabaseState = "VIEW DATABASE STATE";
    private const string ViewDatabasePerformanceState = "VIEW DATABASE PERFORMANCE STATE";

    /// <summary>Minimum database compatibility level Parameter Sensitive Plan optimization requires.</summary>
    public const int ParameterSensitivePlanMinimumCompatibilityLevel = 160;

    /// <summary>Minimum database compatibility level Optional Parameter Plan Optimization requires.</summary>
    public const int OptionalParameterPlanOptimizationMinimumCompatibilityLevel = 170;

    private readonly IProbeExecutor _probeExecutor;
    private readonly TimeProvider _timeProvider;

    public CapabilityNegotiator(IProbeExecutor probeExecutor, TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(probeExecutor);
        _probeExecutor = probeExecutor;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public async Task<TargetCapabilityProfileV1> NegotiateAsync(CapabilityNegotiationRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var now = _timeProvider.GetUtcNow();

        var (platform, platformEvidence, identity) = await NegotiatePlatformAsync(now, cancellationToken).ConfigureAwait(false);
        var (databases, databaseDiscovery) = await NegotiateDatabasesAsync(
            platform, request.TargetId, now, cancellationToken).ConfigureAwait(false);
        var visibility = NegotiateVisibility(platform, now);

        var targetDatabase = databases.FirstOrDefault(d => string.Equals(d.DatabaseName, request.DatabaseName, StringComparison.OrdinalIgnoreCase));
        var compatibilityLevel = targetDatabase?.CompatibilityLevel;

        var (serverPermission, serverPermissionEvidence) = await CheckEitherServerPermissionAsync(now, cancellationToken).ConfigureAwait(false);
        var (databasePermission, databasePermissionEvidence) = await CheckEitherDatabasePermissionAsync(request.DatabaseName, now, cancellationToken).ConfigureAwait(false);

        // Azure SQL Database enforces database-scoped visibility; every other supported platform
        // uses the server-scoped VIEW SERVER (PERFORMANCE) STATE signal instead.
        var effectivePermission = platform == EnginePlatform.AzureSqlDatabase ? databasePermission : serverPermission;
        var effectivePermissionEvidence = platform == EnginePlatform.AzureSqlDatabase ? databasePermissionEvidence : serverPermissionEvidence;

        var waits = NegotiateBasicFeature(platform, effectivePermission, effectivePermissionEvidence, "waits", now);
        var liveSessions = NegotiateBasicFeature(platform, effectivePermission, effectivePermissionEvidence, "live session/request enumeration", now);
        var plansAndText = NegotiateBasicFeature(
            platform,
            effectivePermission,
            effectivePermissionEvidence,
            "query plan and text retrieval (subject to additional per-object permissions not independently probed here)",
            now);

        var planMetadata = platform == EnginePlatform.Unsupported || targetDatabase is null
            ? PlanMetadataNegotiation.NotProbed(now)
            : await NegotiatePlanMetadataAsync(request.DatabaseName, now, cancellationToken).ConfigureAwait(false);

        var psp = NegotiateParameterSensitivePlan(platform, compatibilityLevel, planMetadata, now);
        var oppo = NegotiateOptionalParameterPlanOptimization(platform, compatibilityLevel, planMetadata, now);
        var secondaryQueryStore = NegotiateReadableSecondaryQueryStore(platform, planMetadata, now);

        var queryStoreByDatabase = await NegotiateQueryStoreAsync(request.DatabaseName, now, cancellationToken).ConfigureAwait(false);

        var azureMetrics = platform == EnginePlatform.AzureSqlDatabase
            ? await NegotiateAzureResourceMetricsAsync(request.DatabaseName, now, cancellationToken).ConfigureAwait(false)
            : new AzureResourceMetricsV1(null, null, NotProbedEvidence("Azure resource governance metrics only apply to Azure SQL Database.", now));

        return new TargetCapabilityProfileV1(
            SchemaVersion: "1",
            TargetId: request.TargetId,
            Platform: new EnginePlatformV1(
                platform,
                identity?.ProductVersion,
                identity?.Edition,
                identity?.EngineEdition,
                platformEvidence),
            Databases: databases,
            DatabaseDiscovery: databaseDiscovery,
            ServerVisibility: visibility,
            Waits: waits,
            LiveSessions: liveSessions,
            PlansAndText: plansAndText,
            ParameterSensitivePlan: psp,
            OptionalParameterPlanOptimization: oppo,
            ReadableSecondaryQueryStore: secondaryQueryStore,
            QueryStoreByDatabase: queryStoreByDatabase,
            AzureResourceMetrics: azureMetrics,
            SourceTimestamp: now);
    }

    private async Task<(EnginePlatform Platform, CapabilityEvidenceV1 Evidence, ServerIdentityResult? Identity)> NegotiatePlatformAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        ServerIdentityResult identity;
        try
        {
            identity = await _probeExecutor.GetServerIdentityAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (ProbeExecutionException ex)
        {
            return (EnginePlatform.Unsupported, FromException(ex, now), null);
        }

        var platform = identity.EngineEdition switch
        {
            1 or 2 or 3 or 4 => EnginePlatform.SqlServerOnPremises,
            5 => EnginePlatform.AzureSqlDatabase,
            8 => EnginePlatform.AzureSqlManagedInstance,
            _ => EnginePlatform.Unsupported,
        };

        var evidence = platform == EnginePlatform.Unsupported
            ? new CapabilityEvidenceV1(
                CapabilityState.Unsupported,
                $"EngineEdition {identity.EngineEdition} is not a platform SqlSimCity capability negotiation supports.",
                now,
                null,
                null)
            : new CapabilityEvidenceV1(CapabilityState.Supported, "Identified from SERVERPROPERTY('EngineEdition').", now, null, null);

        return (platform, evidence, identity);
    }

    private async Task<(IReadOnlyList<DatabaseCompatibilityV1> Databases, FeatureCapabilityV1 Discovery)>
        NegotiateDatabasesAsync(
            EnginePlatform platform,
            string targetId,
            DateTimeOffset now,
            CancellationToken cancellationToken)
    {
        IReadOnlyList<DatabaseDiscoveryRow> rows;
        try
        {
            rows = await _probeExecutor.GetDatabaseDiscoveryAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (ProbeExecutionException ex)
        {
            var failure = FromException(ex, now);
            return ([], new FeatureCapabilityV1(failure.State, failure.Reason, failure));
        }

        var reason = rows.Count == 0
            ? "Database discovery completed successfully and returned zero visible databases."
            : "Read from sys.databases.";
        var evidence = new CapabilityEvidenceV1(CapabilityState.Supported, reason, now, null, null);
        var databases = rows
            .Select(r =>
            {
                var rawId = r.DatabaseId.ToString(System.Globalization.CultureInfo.InvariantCulture);
                var databaseId = platform == EnginePlatform.AzureSqlDatabase
                    ? $"{targetId}/database/{rawId}"
                    : rawId;
                return new DatabaseCompatibilityV1(databaseId, r.DatabaseName, r.CompatibilityLevel, evidence);
            })
            .ToList();
        return (databases, new FeatureCapabilityV1(CapabilityState.Supported, reason, evidence));
    }

    private static VisibilityV1 NegotiateVisibility(EnginePlatform platform, DateTimeOffset now) => platform switch
    {
        EnginePlatform.AzureSqlDatabase => new VisibilityV1(
            VisibilityScope.DatabaseScoped,
            "Azure SQL Database database IDs are local to the connected database only and are never treated as globally unique across the logical server; server-wide catalog visibility does not apply here.",
            new CapabilityEvidenceV1(CapabilityState.Supported, "Azure SQL Database is always database-scoped.", now, null, null)),
        EnginePlatform.Unsupported => new VisibilityV1(
            VisibilityScope.Unknown,
            "Platform is not supported; visibility scope cannot be determined.",
            new CapabilityEvidenceV1(CapabilityState.Unsupported, "Unsupported platform.", now, null, null)),
        _ => new VisibilityV1(
            VisibilityScope.Server,
            "Server-wide visibility depends on the connection having been opened against master (or an equivalent) with sufficient permission; a user-database-only connection sees only itself.",
            new CapabilityEvidenceV1(CapabilityState.Supported, "sys.databases is a server-scoped catalog view on this platform.", now, null, null)),
    };

    private async Task<(bool? Granted, CapabilityEvidenceV1 Evidence)> CheckEitherServerPermissionAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        try
        {
            var legacy = await _probeExecutor.CheckServerPermissionAsync(ViewServerState, cancellationToken).ConfigureAwait(false);
            var modern = await _probeExecutor.CheckServerPermissionAsync(ViewServerPerformanceState, cancellationToken).ConfigureAwait(false);
            return CombinePermissionChecks(legacy, modern, "server", now);
        }
        catch (ProbeExecutionException ex)
        {
            return (null, FromException(ex, now));
        }
    }

    private async Task<(bool? Granted, CapabilityEvidenceV1 Evidence)> CheckEitherDatabasePermissionAsync(string databaseName, DateTimeOffset now, CancellationToken cancellationToken)
    {
        try
        {
            var legacy = await _probeExecutor.CheckDatabasePermissionAsync(databaseName, ViewDatabaseState, cancellationToken).ConfigureAwait(false);
            var modern = await _probeExecutor.CheckDatabasePermissionAsync(databaseName, ViewDatabasePerformanceState, cancellationToken).ConfigureAwait(false);
            return CombinePermissionChecks(legacy, modern, "database", now);
        }
        catch (ProbeExecutionException ex)
        {
            return (null, FromException(ex, now));
        }
    }

    private static (bool? Granted, CapabilityEvidenceV1 Evidence) CombinePermissionChecks(bool? legacy, bool? modern, string scope, DateTimeOffset now)
    {
        if (legacy == true || modern == true)
        {
            return (true, new CapabilityEvidenceV1(CapabilityState.Supported, $"HAS_PERMS_BY_NAME confirmed a {scope}-scoped state-visibility permission is granted.", now, null, null));
        }

        if (legacy == false || modern == false)
        {
            return (false, new CapabilityEvidenceV1(CapabilityState.PermissionDenied, $"Neither {scope}-scoped state-visibility permission is granted to the connected login.", now, null, null));
        }

        return (null, new CapabilityEvidenceV1(CapabilityState.NotProbed, $"{scope}-scoped permission could not be evaluated on this platform.", now, null, null));
    }

    private static FeatureCapabilityV1 NegotiateBasicFeature(EnginePlatform platform, bool? permissionGranted, CapabilityEvidenceV1 permissionEvidence, string featureLabel, DateTimeOffset now)
    {
        if (platform == EnginePlatform.Unsupported)
        {
            var evidence = new CapabilityEvidenceV1(CapabilityState.Unsupported, "Platform is not supported by SqlSimCity capability negotiation.", now, null, null);
            return new FeatureCapabilityV1(CapabilityState.Unsupported, evidence.Reason, evidence);
        }

        return permissionGranted switch
        {
            true => new FeatureCapabilityV1(CapabilityState.Supported, $"Permission confirmed for {featureLabel}.", permissionEvidence),
            false => new FeatureCapabilityV1(CapabilityState.PermissionDenied, $"Permission denied for {featureLabel}.", permissionEvidence),
            null => new FeatureCapabilityV1(
                permissionEvidence.State,
                $"Permission for {featureLabel} could not be evaluated: {permissionEvidence.Reason}",
                permissionEvidence),
        };
    }

    private async Task<PlanMetadataNegotiation> NegotiatePlanMetadataAsync(
        string databaseName,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        try
        {
            var metadata = await _probeExecutor.GetQueryStorePlanMetadataAsync(databaseName, cancellationToken).ConfigureAwait(false);
            var evidence = new CapabilityEvidenceV1(
                CapabilityState.Supported,
                "Query Store plan metadata probe completed successfully.",
                now,
                null,
                null);
            return new PlanMetadataNegotiation(metadata, evidence, true);
        }
        catch (ProbeExecutionException ex)
        {
            return new PlanMetadataNegotiation(null, FromException(ex, now), false);
        }
    }

    private static FeatureCapabilityV1 NegotiateParameterSensitivePlan(EnginePlatform platform, int? compatibilityLevel, PlanMetadataNegotiation metadata, DateTimeOffset now)
    {
        if (platform == EnginePlatform.Unsupported)
        {
            var e = new CapabilityEvidenceV1(CapabilityState.Unsupported, "Platform is not supported.", now, null, null);
            return new FeatureCapabilityV1(CapabilityState.Unsupported, e.Reason, e);
        }

        if (compatibilityLevel is null)
        {
            var e = new CapabilityEvidenceV1(CapabilityState.NotProbed, "Database compatibility level was not determined.", now, null, null);
            return new FeatureCapabilityV1(CapabilityState.NotProbed, e.Reason, e);
        }

        if (compatibilityLevel < ParameterSensitivePlanMinimumCompatibilityLevel)
        {
            var e = new CapabilityEvidenceV1(
                CapabilityState.Unsupported,
                $"Database compatibility level {compatibilityLevel} is below the {ParameterSensitivePlanMinimumCompatibilityLevel} PSP requires.",
                now,
                null,
                null);
            return new FeatureCapabilityV1(CapabilityState.Unsupported, e.Reason, e);
        }

        if (!metadata.Succeeded)
        {
            return FeatureFromMetadataFailure(metadata);
        }

        if (metadata.Metadata is not { HasPlanTypeDesc: true })
        {
            var e = new CapabilityEvidenceV1(
                CapabilityState.Unsupported,
                "Compatibility level qualifies, but sys.query_store_plan.plan_type_desc was not confirmed on this engine build.",
                now,
                null,
                null);
            return new FeatureCapabilityV1(CapabilityState.Unsupported, e.Reason, e);
        }

        var supported = new CapabilityEvidenceV1(
            CapabilityState.Supported,
            $"Compatibility level {compatibilityLevel} and plan_type_desc/Query Variant metadata both confirmed.",
            now,
            null,
            null);
        return new FeatureCapabilityV1(CapabilityState.Supported, supported.Reason, supported);
    }

    private static FeatureCapabilityV1 NegotiateOptionalParameterPlanOptimization(EnginePlatform platform, int? compatibilityLevel, PlanMetadataNegotiation metadata, DateTimeOffset now)
    {
        if (platform == EnginePlatform.Unsupported)
        {
            var e = new CapabilityEvidenceV1(CapabilityState.Unsupported, "Platform is not supported.", now, null, null);
            return new FeatureCapabilityV1(CapabilityState.Unsupported, e.Reason, e);
        }

        if (platform == EnginePlatform.AzureSqlManagedInstance)
        {
            var e = new CapabilityEvidenceV1(
                CapabilityState.Unsupported,
                "Optional Parameter Plan Optimization's documented 'Applies to' list does not include Azure SQL Managed Instance.",
                now,
                null,
                null);
            return new FeatureCapabilityV1(CapabilityState.Unsupported, e.Reason, e);
        }

        if (compatibilityLevel is null)
        {
            var e = new CapabilityEvidenceV1(CapabilityState.NotProbed, "Database compatibility level was not determined.", now, null, null);
            return new FeatureCapabilityV1(CapabilityState.NotProbed, e.Reason, e);
        }

        if (compatibilityLevel < OptionalParameterPlanOptimizationMinimumCompatibilityLevel)
        {
            var e = new CapabilityEvidenceV1(
                CapabilityState.Unsupported,
                $"Database compatibility level {compatibilityLevel} is below the {OptionalParameterPlanOptimizationMinimumCompatibilityLevel} OPPO requires.",
                now,
                null,
                null);
            return new FeatureCapabilityV1(CapabilityState.Unsupported, e.Reason, e);
        }

        if (!metadata.Succeeded)
        {
            return FeatureFromMetadataFailure(metadata);
        }

        if (metadata.Metadata is not { HasPlanTypeDesc: true })
        {
            var e = new CapabilityEvidenceV1(
                CapabilityState.Unsupported,
                "Compatibility level qualifies, but the plan-variant catalog metadata OPPO depends on was not confirmed on this engine build.",
                now,
                null,
                null);
            return new FeatureCapabilityV1(CapabilityState.Unsupported, e.Reason, e);
        }

        var supported = new CapabilityEvidenceV1(
            CapabilityState.Supported,
            $"Compatibility level {compatibilityLevel}, supported platform, and plan-variant metadata all confirmed.",
            now,
            null,
            null);
        return new FeatureCapabilityV1(CapabilityState.Supported, supported.Reason, supported);
    }

    private static FeatureCapabilityV1 NegotiateReadableSecondaryQueryStore(EnginePlatform platform, PlanMetadataNegotiation metadata, DateTimeOffset now)
    {
        if (platform == EnginePlatform.Unsupported)
        {
            var e = new CapabilityEvidenceV1(CapabilityState.Unsupported, "Platform is not supported.", now, null, null);
            return new FeatureCapabilityV1(CapabilityState.Unsupported, e.Reason, e);
        }

        if (!metadata.Succeeded)
        {
            return FeatureFromMetadataFailure(metadata);
        }

        if (metadata.Metadata is not { HasReplicaGroupId: true })
        {
            var e = new CapabilityEvidenceV1(
                CapabilityState.Unsupported,
                "sys.query_store_runtime_stats.replica_group_id was not confirmed on this engine build.",
                now,
                null,
                null);
            return new FeatureCapabilityV1(CapabilityState.Unsupported, e.Reason, e);
        }

        // This negotiator never independently confirms actual availability-group replica role or
        // topology, so a metadata-eligible engine build is reported as Preview, never Supported.
        var preview = new CapabilityEvidenceV1(
            CapabilityState.Preview,
            "replica_group_id metadata confirmed, but this layer does not independently verify availability-group replica role/topology; treat as preview pending that verification.",
            now,
            null,
            null);
        return new FeatureCapabilityV1(CapabilityState.Preview, preview.Reason, preview);
    }

    private async Task<IReadOnlyDictionary<string, QueryStoreStateV1>> NegotiateQueryStoreAsync(string databaseName, DateTimeOffset now, CancellationToken cancellationToken)
    {
        QueryStoreOptionsRow? row;
        CapabilityEvidenceV1 evidence;
        CapabilityState availability;
        try
        {
            row = await _probeExecutor.GetQueryStoreOptionsAsync(databaseName, cancellationToken).ConfigureAwait(false);
            if (row is null)
            {
                availability = CapabilityState.Unavailable;
                evidence = new CapabilityEvidenceV1(
                    CapabilityState.Unavailable,
                    "Query Store options probe unexpectedly returned no row; operational state was not determined.",
                    now,
                    null,
                    null);
            }
            else
            {
                availability = CapabilityState.Supported;
                evidence = new CapabilityEvidenceV1(CapabilityState.Supported, "Read from sys.database_query_store_options.", now, null, null);
            }
        }
        catch (ProbePermissionDeniedException ex)
        {
            row = null;
            availability = CapabilityState.PermissionDenied;
            evidence = FromException(ex, now);
        }
        catch (ProbeObjectUnavailableException ex)
        {
            row = null;
            availability = CapabilityState.Unsupported;
            evidence = FromException(ex, now);
        }
        catch (ProbeExecutionException ex)
        {
            row = null;
            availability = CapabilityState.Unavailable;
            evidence = FromException(ex, now);
        }

        if (row is null)
        {
            return new Dictionary<string, QueryStoreStateV1>(StringComparer.OrdinalIgnoreCase)
            {
                [databaseName] = new QueryStoreStateV1(null, null, QueryStoreOperationalState.Unknown, null, null, null, null, availability, evidence),
            };
        }

        var operationalState = row.ActualStateDesc switch
        {
            "READ_WRITE" => QueryStoreOperationalState.On,
            "READ_ONLY" => QueryStoreOperationalState.ReadOnly,
            "OFF" => QueryStoreOperationalState.Off,
            "ERROR" => QueryStoreOperationalState.Error,
            "READ_CAPTURE_SECONDARY" => QueryStoreOperationalState.On,
            _ => QueryStoreOperationalState.Unknown,
        };

        var readOnlyReason = operationalState == QueryStoreOperationalState.ReadOnly
            ? QueryStoreReadOnlyReason.Describe(row.ReadonlyReason)
            : null;

        string currentStorageBytes;
        string maxStorageBytes;
        try
        {
            currentStorageBytes = checked(row.CurrentStorageSizeMb * 1024L * 1024L)
                .ToString(System.Globalization.CultureInfo.InvariantCulture);
            maxStorageBytes = checked(row.MaxStorageSizeMb * 1024L * 1024L)
                .ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
        catch (OverflowException)
        {
            var overflowEvidence = new CapabilityEvidenceV1(
                CapabilityState.Unavailable,
                "Query Store storage size conversion overflowed the supported 64-bit byte range.",
                now,
                null,
                null);
            return new Dictionary<string, QueryStoreStateV1>(StringComparer.OrdinalIgnoreCase)
            {
                [databaseName] = new QueryStoreStateV1(
                    null, null, QueryStoreOperationalState.Unknown, null, null, null, null,
                    CapabilityState.Unavailable, overflowEvidence),
            };
        }

        var state = new QueryStoreStateV1(
            row.DesiredStateDesc,
            row.ActualStateDesc,
            operationalState,
            readOnlyReason,
            row.QueryCaptureModeDesc,
            currentStorageBytes,
            maxStorageBytes,
            CapabilityState.Supported,
            evidence);

        return new Dictionary<string, QueryStoreStateV1>(StringComparer.OrdinalIgnoreCase) { [databaseName] = state };
    }

    private async Task<AzureResourceMetricsV1> NegotiateAzureResourceMetricsAsync(string databaseName, DateTimeOffset now, CancellationToken cancellationToken)
    {
        try
        {
            var row = await _probeExecutor.GetAzureResourceGovernanceAsync(databaseName, cancellationToken).ConfigureAwait(false);
            if (row is null)
            {
                return new AzureResourceMetricsV1(null, null, NotProbedEvidence("No row returned by capability.azure_resource_governance.", now));
            }

            var evidence = new CapabilityEvidenceV1(CapabilityState.Supported, "Read from sys.dm_user_db_resource_governance and sys.dm_os_job_object.", now, null, null);
            return new AzureResourceMetricsV1(row.CpuLimit, row.ProcessMemoryLimitMb, evidence);
        }
        catch (ProbeExecutionException ex)
        {
            return new AzureResourceMetricsV1(null, null, FromException(ex, now));
        }
    }

    private static CapabilityEvidenceV1 NotProbedEvidence(string reason, DateTimeOffset now) =>
        new(CapabilityState.NotProbed, reason, now, null, null);

    private static CapabilityEvidenceV1 FromException(ProbeExecutionException exception, DateTimeOffset now)
    {
        var state = exception switch
        {
            ProbePermissionDeniedException => CapabilityState.PermissionDenied,
            ProbeObjectUnavailableException => CapabilityState.Unsupported,
            ProbeNotProbedException => CapabilityState.NotProbed,
            ProbeTransientConnectionException or ProbeTimeoutException => CapabilityState.Unavailable,
            _ => CapabilityState.Unavailable,
        };

        return new CapabilityEvidenceV1(state, exception.Reason, now, exception.SqlErrorNumber, exception.SqlErrorClass);
    }

    private static FeatureCapabilityV1 FeatureFromMetadataFailure(PlanMetadataNegotiation metadata) =>
        new(metadata.Evidence.State, metadata.Evidence.Reason, metadata.Evidence);

    private sealed record PlanMetadataNegotiation(
        QueryStorePlanMetadataResult? Metadata,
        CapabilityEvidenceV1 Evidence,
        bool Succeeded)
    {
        public static PlanMetadataNegotiation NotProbed(DateTimeOffset now)
        {
            var evidence = new CapabilityEvidenceV1(
                CapabilityState.NotProbed,
                "Query Store plan metadata was not probed because the target database or platform was unavailable.",
                now,
                null,
                null);
            return new PlanMetadataNegotiation(null, evidence, false);
        }
    }
}
