using System.Data;
using System.Data.SqlTypes;
using System.Globalization;
using System.Numerics;
using System.Text;
using System.Text.Json;
using Azure.Identity;
using Microsoft.Data.SqlClient;
using SqlSimCity.Collection.Catalog;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.SqlServer;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.Collection.QueryStore;

public sealed class SqlQueryStoreIncrementalSource(
    ISqlConnectionFactory connectionFactory,
    ConnectionProfile profile,
    ProbeCatalog catalog,
    TimeProvider timeProvider,
    EnginePlatform? configuredPlatform = null) : IQueryStoreIncrementalSource, IDisposable
{
    private readonly SemaphoreSlim _capabilityGate = new(1, 1);
    private ServerCapabilities? _capabilities;

    public void Dispose() => _capabilityGate.Dispose();

    public async Task<IReadOnlyList<string>> DiscoverDatabasesAsync(CancellationToken cancellationToken)
    {
        try
        {
            return await ExecuteAsync(
                "server.database_discovery", "master", null, null,
                async (reader, token) =>
                {
                    var names = new List<string>();
                    while (await reader.ReadAsync(token).ConfigureAwait(false))
                        if (Convert.ToBoolean(reader["is_query_store_on"], CultureInfo.InvariantCulture))
                            names.Add((string)reader["database_name"]);
                    return (IReadOnlyList<string>)names;
                }, cancellationToken).ConfigureAwait(false);
        }
        catch (ProbeExecutionException ex) when (
            IsExpectedMasterFallback(ex) &&
            !string.Equals(profile.InitialDatabase, "master", StringComparison.OrdinalIgnoreCase))
        {
            return await ExecuteAsync(
                "server.database_identity_current", "database", profile.InitialDatabase, null,
                async (reader, token) =>
                {
                    if (!await reader.ReadAsync(token).ConfigureAwait(false))
                        throw new ProbeNotProbedException(
                            "The configured database could not be identified.");
                    if (!Convert.ToBoolean(reader["is_query_store_on"], CultureInfo.InvariantCulture))
                        throw new ProbeNotProbedException(
                            "Query Store is not enabled in the configured contained database.");
                    return (IReadOnlyList<string>)[(string)reader["database_name"]];
                }, cancellationToken).ConfigureAwait(false);
        }
    }

    public async Task<QueryStoreDatabaseState> GetStateAsync(
        string databaseId,
        CancellationToken cancellationToken)
    {
        var capabilities = await GetCapabilitiesAsync(databaseId, cancellationToken).ConfigureAwait(false);
        try
        {
            var optionsProbe = capabilities.MajorVersion >= 15 || capabilities.EngineEdition == 5
                ? "querystore.options_2019" : "querystore.options_2016";
            var options = await ExecuteAsync(
                optionsProbe, "database", databaseId, null,
                async (reader, token) =>
                {
                    if (!await reader.ReadAsync(token).ConfigureAwait(false))
                        return (Actual: (string?)null, Reason: "Query Store options returned no row; state is unknown.");
                    return (
                        Actual: Convert.ToString(reader["actual_state_desc"], CultureInfo.InvariantCulture),
                        Reason: "Query Store operational state was read from sys.database_query_store_options.");
                }, cancellationToken).ConfigureAwait(false);
            var intervalRange = await ExecuteAsync(
                "querystore.oldest_interval", "database", databaseId, null,
                async (reader, token) =>
                {
                    if (!await reader.ReadAsync(token).ConfigureAwait(false) ||
                        reader["oldest_interval_start"] is DBNull)
                        return (Oldest: (DateTimeOffset?)null, LatestId: (long?)null);
                    return (
                        Oldest: (DateTimeOffset?)ReadDateTimeOffset(reader["oldest_interval_start"]),
                        LatestId: reader["latest_interval_id"] is DBNull
                            ? null : Convert.ToInt64(reader["latest_interval_id"], CultureInfo.InvariantCulture));
                }, cancellationToken).ConfigureAwait(false);
            var state = options.Actual?.ToUpperInvariant() switch
            {
                "READ_WRITE" => QueryStoreCollectionState.ReadWrite,
                "READ_ONLY" => QueryStoreCollectionState.ReadOnly,
                "READ_CAPTURE_SECONDARY" => QueryStoreCollectionState.ReadCaptureSecondary,
                "OFF" => QueryStoreCollectionState.Off,
                "ERROR" => QueryStoreCollectionState.Error,
                _ => QueryStoreCollectionState.Unknown,
            };
            return new QueryStoreDatabaseState(
                databaseId, state, $"query-store:{databaseId}", intervalRange.Oldest, timeProvider.GetUtcNow(),
                options.Reason, capabilities.MajorVersion, capabilities.CompatibilityLevel,
                capabilities.MajorVersion >= 14 || capabilities.EngineEdition == 5,
                capabilities.HasVariantView,
                capabilities.HasReplicaView, capabilities.SupportsOppo, intervalRange.LatestId);
        }
        catch (ProbePermissionDeniedException)
        {
            return Unavailable(databaseId, QueryStoreCollectionState.PermissionDenied, capabilities,
                "The configured principal cannot read Query Store in this database.");
        }
        catch (ProbeObjectUnavailableException)
        {
            return Unavailable(databaseId, QueryStoreCollectionState.Unsupported, capabilities,
                "Required Query Store catalog objects are unavailable on this database.");
        }
    }

    public async Task<QueryStoreFactPage> ReadPageAsync(
        string databaseId,
        QueryStoreFactKind kind,
        DateTimeOffset startInclusive,
        DateTimeOffset endExclusive,
        string? pageToken,
        int pageSize,
        CancellationToken cancellationToken)
    {
        var capabilities = await GetCapabilitiesAsync(databaseId, cancellationToken).ConfigureAwait(false);
        return kind switch
        {
            QueryStoreFactKind.Identity => await ReadIdentitiesAsync(
                databaseId, startInclusive, endExclusive, pageToken, pageSize, cancellationToken).ConfigureAwait(false),
            QueryStoreFactKind.Plan => await ReadPlansAsync(
                databaseId, capabilities, startInclusive, endExclusive, pageToken, pageSize, cancellationToken).ConfigureAwait(false),
            QueryStoreFactKind.Runtime => await ReadRuntimeAsync(
                databaseId, capabilities, startInclusive, endExclusive, pageToken, pageSize, cancellationToken).ConfigureAwait(false),
            QueryStoreFactKind.Wait => await ReadWaitsAsync(
                databaseId, capabilities, startInclusive, endExclusive, pageToken, pageSize, cancellationToken).ConfigureAwait(false),
            QueryStoreFactKind.Variant => await ReadVariantsAsync(
                databaseId, capabilities, pageToken, pageSize, cancellationToken).ConfigureAwait(false),
            QueryStoreFactKind.Replica => await ReadReplicasAsync(
                databaseId, capabilities, pageToken, pageSize, cancellationToken).ConfigureAwait(false),
            _ => throw new ArgumentOutOfRangeException(nameof(kind)),
        };
    }

    public async Task<QueryTextPayload> ReadQueryTextAsync(
        string databaseId,
        string queryTextId,
        CancellationToken cancellationToken)
    {
        var capabilities = await GetCapabilitiesAsync(databaseId, cancellationToken).ConfigureAwait(false);
        return await ExecuteAsync(
            capabilities.HasRestrictedText ? "querystore.query_text_single" : "querystore.query_text_single_2016",
            "database", databaseId,
            new Dictionary<string, object?> { ["@QueryTextId"] = ParseInt64(queryTextId) },
            async (reader, token) =>
            {
                if (!await reader.ReadAsync(token).ConfigureAwait(false))
                    return new QueryTextPayload(null, false, false);
                return new QueryTextPayload(
                    reader["query_sql_text"] is DBNull ? null : (string)reader["query_sql_text"],
                    Convert.ToBoolean(reader["is_part_of_encrypted_module"], CultureInfo.InvariantCulture),
                    capabilities.HasRestrictedText &&
                    Convert.ToBoolean(reader["has_restricted_text"], CultureInfo.InvariantCulture));
            }, cancellationToken).ConfigureAwait(false);
    }

    public Task<string?> ReadPlanXmlAsync(
        string databaseId,
        string planId,
        CancellationToken cancellationToken) =>
        ExecuteAsync(
            "querystore.plan_xml_single", "database", databaseId,
            new Dictionary<string, object?> { ["@PlanId"] = ParseInt64(planId) },
            async (reader, token) =>
            {
                if (!await reader.ReadAsync(token).ConfigureAwait(false) ||
                    reader["query_plan"] is DBNull) return null;
                return reader["query_plan"] is SqlXml xml
                    ? xml.Value
                    : Convert.ToString(reader["query_plan"], CultureInfo.InvariantCulture);
            }, cancellationToken);

    private async Task<QueryStoreFactPage> ReadIdentitiesAsync(
        string databaseId, DateTimeOffset start, DateTimeOffset end,
        string? token, int pageSize, CancellationToken cancellationToken)
    {
        var cursor = Decode<TimeIdCursor>(token) ?? new TimeIdCursor(start.AddTicks(-1), 0);
        var capabilities = await GetCapabilitiesAsync(databaseId, cancellationToken).ConfigureAwait(false);
        var facts = await ReadManyAsync(
            capabilities.HasRestrictedText ? "querystore.identities_page" : "querystore.identities_page_2016",
            databaseId,
            CommonPage(pageSize, start, end, new()
            {
                ["@AfterExecutionTime"] = cursor.Time, ["@AfterQueryId"] = cursor.Id,
            }),
            reader => new QueryIdentityFact(
                Id(reader["query_id"]), Id(reader["query_text_id"]), Id(reader["context_settings_id"]),
                Hash(reader["query_hash"]), ReadDateTimeOffset(reader["last_execution_time"]),
                Bool(reader["is_part_of_encrypted_module"]),
                capabilities.HasRestrictedText && Bool(reader["has_restricted_text"]),
                NullableHex(reader["set_options"]), NullableString(reader["language_id"]),
                NullableString(reader["date_format"]), NullableString(reader["date_first"])),
            cancellationToken).ConfigureAwait(false);
        var last = facts.LastOrDefault();
        return Page(QueryStoreFactKind.Identity, facts, pageSize, last is null ? null :
            new TimeIdCursor(last.LastExecutionAt, ParseInt64(last.QueryId)));
    }

    private async Task<QueryStoreFactPage> ReadPlansAsync(
        string databaseId, ServerCapabilities capabilities,
        DateTimeOffset start, DateTimeOffset end, string? token, int pageSize,
        CancellationToken cancellationToken)
    {
        var probe = capabilities.MajorVersion >= 16
            ? "querystore.plans_page_2022"
            : capabilities.MajorVersion >= 14 ? "querystore.plans_page_2017" : "querystore.plans_page_2016";
        var cursor = Decode<TimeIdCursor>(token) ?? new TimeIdCursor(start.AddTicks(-1), 0);
        var facts = await ReadManyAsync(
            probe, databaseId,
            CommonPage(pageSize, start, end, new()
            {
                ["@AfterExecutionTime"] = cursor.Time, ["@AfterPlanId"] = cursor.Id,
            }),
            reader => new QueryPlanFact(
                Id(reader["plan_id"]), Id(reader["query_id"]), Hash(reader["query_plan_hash"]),
                PlanType(Convert.ToInt32(reader["plan_type"], CultureInfo.InvariantCulture)),
                NullableString(reader["plan_group_id"]), Bool(reader["is_forced_plan"]),
                NullableString(reader["plan_forcing_type_desc"]),
                Big(reader["force_failure_count"]), NullableString(reader["last_force_failure_reason_desc"]),
                NullableString(reader["engine_version"]) ?? "", NullableString(reader["compatibility_level"]) ?? "",
                ReadDateTimeOffset(reader["last_execution_time"])),
            cancellationToken).ConfigureAwait(false);
        var last = facts.LastOrDefault();
        return Page(QueryStoreFactKind.Plan, facts, pageSize, last is null ? null :
            new TimeIdCursor(last.LastExecutionAt, ParseInt64(last.PlanId)));
    }

    private async Task<QueryStoreFactPage> ReadRuntimeAsync(
        string databaseId, ServerCapabilities capabilities,
        DateTimeOffset start, DateTimeOffset end, string? token, int pageSize,
        CancellationToken cancellationToken)
    {
        var replica = capabilities.HasReplicaRuntimeColumn;
        var probe = replica ? "querystore.runtime_page_2022" : "querystore.runtime_page_2016";
        var cursor = Decode<RuntimeCursor>(token) ?? new RuntimeCursor(0, 0, 0, 0);
        var parameters = CommonPage(pageSize, start, end, new()
        {
            ["@AfterIntervalId"] = cursor.IntervalId, ["@AfterPlanId"] = cursor.PlanId,
            ["@AfterExecutionType"] = cursor.ExecutionType,
        });
        if (replica) parameters["@AfterReplicaGroupId"] = cursor.ReplicaGroupId;
        var facts = await ReadManyAsync(
            probe, databaseId, parameters,
            reader => new QueryRuntimeFact(new RuntimeStatInput(
                Id(reader["plan_id"]), Id(reader["runtime_stats_interval_id"]),
                ReadDateTimeOffset(reader["start_time"]), ReadDateTimeOffset(reader["end_time"]),
                ExecutionType(Convert.ToInt32(reader["execution_type"], CultureInfo.InvariantCulture)),
                Id(reader["replica_group_id"]), Big(reader["execution_count"]),
                Decimal(reader["average_duration_us"]), Decimal(reader["average_cpu_us"]),
                Decimal(reader["average_logical_reads_pages"]))),
            cancellationToken).ConfigureAwait(false);
        var last = facts.LastOrDefault()?.Value;
        var active = facts.Any(fact => fact.Value.IntervalEnd >= end);
        return Page(QueryStoreFactKind.Runtime, facts, pageSize, last is null ? null :
            new RuntimeCursor(ParseInt64(last.IntervalId), ParseInt64(last.PlanId),
                (byte)ExecutionTypeCode(last.ExecutionType), ParseInt64(last.ReplicaGroupId)), active);
    }

    private async Task<QueryStoreFactPage> ReadWaitsAsync(
        string databaseId, ServerCapabilities capabilities,
        DateTimeOffset start, DateTimeOffset end, string? token, int pageSize,
        CancellationToken cancellationToken)
    {
        var replica = capabilities.HasReplicaRuntimeColumn;
        var probe = replica ? "querystore.waits_page_2022" : "querystore.waits_page_2017";
        var cursor = Decode<WaitCursor>(token) ?? new WaitCursor(0, 0, 0, 0, 0);
        var parameters = CommonPage(pageSize, start, end, new()
        {
            ["@AfterIntervalId"] = cursor.IntervalId, ["@AfterPlanId"] = cursor.PlanId,
            ["@AfterExecutionType"] = cursor.ExecutionType, ["@AfterWaitCategory"] = cursor.WaitCategory,
        });
        if (replica) parameters["@AfterReplicaGroupId"] = cursor.ReplicaGroupId;
        var facts = await ReadManyAsync(
            probe, databaseId, parameters,
            reader => new QueryWaitFact(
                Id(reader["plan_id"]), Id(reader["runtime_stats_interval_id"]),
                ExecutionType(Convert.ToInt32(reader["execution_type"], CultureInfo.InvariantCulture)),
                Id(reader["replica_group_id"]),
                Convert.ToByte(reader["wait_category"], CultureInfo.InvariantCulture),
                NullableString(reader["wait_category_desc"]) ?? Id(reader["wait_category"]),
                Big(reader["total_wait_ms"])),
            cancellationToken).ConfigureAwait(false);
        var last = facts.LastOrDefault();
        return Page(QueryStoreFactKind.Wait, facts, pageSize, last is null ? null :
            new WaitCursor(ParseInt64(last.IntervalId), ParseInt64(last.PlanId),
                (byte)ExecutionTypeCode(last.ExecutionType), ParseInt64(last.ReplicaGroupId), last.WaitCategoryId));
    }

    private async Task<QueryStoreFactPage> ReadVariantsAsync(
        string databaseId, ServerCapabilities capabilities,
        string? token, int pageSize, CancellationToken cancellationToken)
    {
        if (!capabilities.HasVariantView)
            return Page(QueryStoreFactKind.Variant, Array.Empty<QueryVariantFact>(), pageSize, null);
        var cursor = Decode<IdCursor>(token) ?? new IdCursor(0);
        var facts = await ReadManyAsync(
            "querystore.variants_2022", databaseId,
            new Dictionary<string, object?> { ["@PageSize"] = pageSize, ["@AfterVariantQueryId"] = cursor.Id },
            reader => new QueryVariantFact(
                Id(reader["query_variant_query_id"]), Id(reader["parent_query_id"]),
                Id(reader["dispatcher_plan_id"]),
                capabilities.SupportsOppo
                    ? QueryOptimizationKind.None
                    : QueryOptimizationKind.ParameterSensitivePlan),
            cancellationToken).ConfigureAwait(false);
        var last = facts.LastOrDefault();
        return Page(QueryStoreFactKind.Variant, facts, pageSize,
            last is null ? null : new IdCursor(ParseInt64(last.VariantQueryId)));
    }

    private async Task<QueryStoreFactPage> ReadReplicasAsync(
        string databaseId, ServerCapabilities capabilities,
        string? token, int pageSize, CancellationToken cancellationToken)
    {
        if (!capabilities.HasReplicaView)
            return Page(QueryStoreFactKind.Replica, Array.Empty<QueryReplicaFact>(), pageSize, null);
        var cursor = Decode<IdCursor>(token) ?? new IdCursor(0);
        var facts = await ReadManyAsync(
            "querystore.replicas_2025", databaseId,
            new Dictionary<string, object?> { ["@PageSize"] = pageSize, ["@AfterReplicaGroupId"] = cursor.Id },
            reader => new QueryReplicaFact(Id(reader["replica_group_id"]), (string)reader["replica_name"]),
            cancellationToken).ConfigureAwait(false);
        var last = facts.LastOrDefault();
        return Page(QueryStoreFactKind.Replica, facts, pageSize,
            last is null ? null : new IdCursor(ParseInt64(last.ReplicaGroupId)));
    }

    private async Task<ServerCapabilities> GetCapabilitiesAsync(
        string databaseId,
        CancellationToken cancellationToken)
    {
        if (_capabilities is { } cached && cached.CompatibilityByDatabase.TryGetValue(databaseId, out var compatibility))
            return cached with { CompatibilityLevel = compatibility };
        await _capabilityGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_capabilities is { } lockedCached &&
                lockedCached.CompatibilityByDatabase.TryGetValue(databaseId, out compatibility))
                return lockedCached with { CompatibilityLevel = compatibility };
            if (_capabilities is { } partialCache)
            {
                var currentCompatibility = await ReadCurrentCompatibilityAsync(
                    databaseId, cancellationToken).ConfigureAwait(false);
                var expanded = new Dictionary<string, int>(
                    partialCache.CompatibilityByDatabase, StringComparer.Ordinal)
                {
                    [databaseId] = currentCompatibility,
                };
                _capabilities = partialCache with
                {
                    CompatibilityLevel = currentCompatibility,
                    CompatibilityByDatabase = expanded,
                };
                return _capabilities;
            }

            async Task<(int Major, int Edition, int Compatibility)> ReadIdentityAsync(
                string database)
                => await ExecuteAsync(
                "server.identity_current", "database", database, null,
                async (reader, token) =>
                {
                    if (!await reader.ReadAsync(token).ConfigureAwait(false))
                        throw new ProbeObjectUnavailableException("Server identity returned no row.", null, null);
                    var version = Convert.ToString(
                        reader["product_major_version"], CultureInfo.InvariantCulture);
                    if (string.IsNullOrWhiteSpace(version))
                        version = (Convert.ToString(
                            reader["product_version"], CultureInfo.InvariantCulture) ?? "0").Split('.')[0];
                    return (Major: int.Parse(version, CultureInfo.InvariantCulture),
                        Edition: Convert.ToInt32(reader["engine_edition"], CultureInfo.InvariantCulture),
                        Compatibility: Convert.ToInt32(
                            reader["compatibility_level"], CultureInfo.InvariantCulture));
                }, cancellationToken).ConfigureAwait(false);

            var identity = await ReadIdentityAsync(databaseId).ConfigureAwait(false);

            Dictionary<string, int> databases;
            try
            {
                databases = await ExecuteAsync(
                    "server.database_discovery", "master", null, null,
                async (reader, token) =>
                {
                    var result = new Dictionary<string, int>(StringComparer.Ordinal);
                    while (await reader.ReadAsync(token).ConfigureAwait(false))
                        result[(string)reader["database_name"]] =
                            Convert.ToInt32(reader["compatibility_level"], CultureInfo.InvariantCulture);
                    return result;
                }, cancellationToken).ConfigureAwait(false);
            }
            catch (ProbeExecutionException ex) when (IsExpectedMasterFallback(ex))
            {
                databases = new Dictionary<string, int>(StringComparer.Ordinal);
            }
            if (!databases.ContainsKey(databaseId))
                databases[databaseId] = identity.Compatibility;
            var metadata = await ExecuteAsync(
                "capability.query_store_plan_metadata", "database", databaseId, null,
                async (reader, token) =>
                {
                    var rows = new HashSet<string>(StringComparer.Ordinal);
                    while (await reader.ReadAsync(token).ConfigureAwait(false))
                        rows.Add($"{reader["view_name"]}.{reader["column_name"]}");
                    return rows;
                }, cancellationToken).ConfigureAwait(false);
            var compat = databases.GetValueOrDefault(databaseId);
            var supportsOppo = compat >= 170 && identity.Edition != 8 &&
                               (identity.Major >= 17 || identity.Edition == 5) &&
                               metadata.Contains("sys.query_store_query_variant.<view>");
            _capabilities = new ServerCapabilities(
                identity.Major, identity.Edition, compat, databases,
                metadata.Contains("sys.query_store_runtime_stats.replica_group_id"),
                metadata.Contains("sys.query_store_query_variant.<view>"),
                metadata.Contains("sys.query_store_replicas.<view>"),
                metadata.Contains("sys.query_store_query_text.has_restricted_text"), supportsOppo);
            return _capabilities;
        }
        finally
        {
            _capabilityGate.Release();
        }
    }

    private Task<int> ReadCurrentCompatibilityAsync(
        string databaseId, CancellationToken cancellationToken) =>
        ExecuteAsync(
            "server.identity_current", "database", databaseId, null,
            async (reader, token) =>
            {
                if (!await reader.ReadAsync(token).ConfigureAwait(false))
                    throw new ProbeObjectUnavailableException(
                        "Current database identity returned no row.", null, null);
                return Convert.ToInt32(reader["compatibility_level"], CultureInfo.InvariantCulture);
            }, cancellationToken);

    private async Task<List<T>> ReadManyAsync<T>(
        string probeId,
        string databaseId,
        IReadOnlyDictionary<string, object?> parameters,
        Func<SqlDataReader, T> projector,
        CancellationToken cancellationToken) =>
        await ExecuteAsync(
            probeId, "database", databaseId, parameters,
            async (reader, token) =>
            {
                var facts = new List<T>();
                while (await reader.ReadAsync(token).ConfigureAwait(false)) facts.Add(projector(reader));
                return facts;
            }, cancellationToken).ConfigureAwait(false);

    private async Task<T> ExecuteAsync<T>(
        string probeId,
        string expectedScope,
        string? databaseId,
        IReadOnlyDictionary<string, object?>? values,
        Func<SqlDataReader, CancellationToken, Task<T>> projector,
        CancellationToken cancellationToken)
    {
        var probe = catalog.Get(probeId);
        if (!string.Equals(probe.ConnectionScope, expectedScope, StringComparison.Ordinal))
            throw new InvalidOperationException($"Probe '{probeId}' has unexpected connection scope.");
        var executionProfile = expectedScope == "master"
            ? configuredPlatform == EnginePlatform.AzureSqlDatabase
                ? profile
                : profile.WithInitialDatabase("master")
            : profile.WithInitialDatabase(databaseId ??
                throw new InvalidOperationException("A database-scoped probe requires a database."));
        try
        {
            await using var opened = await connectionFactory.OpenAsync(executionProfile, cancellationToken)
                .ConfigureAwait(false);
            await using var command = opened.Connection.CreateCommand();
            command.CommandText = probe.CommandText;
            command.CommandType = CommandType.Text;
            command.CommandTimeout = executionProfile.Timeouts.CommandTimeoutSeconds;
            BindParameters(command, probe, values);

            // Every projector here reads columns by name and in whatever order the
            // result record needs them. CommandBehavior.SequentialAccess forbids
            // that: it allows each column to be read once, in ascending ordinal
            // order, and throws otherwise. Nothing in this file uses a streaming
            // accessor (GetStream/GetTextReader/GetChars), so sequential access
            // bought no memory saving and only made by-name projection illegal --
            // database discovery reads is_query_store_on (ordinal 8) before
            // database_name (ordinal 1) and threw on the very first cycle, so
            // connected Query Store history never collected anything at all. The
            // Atlas, live-incident, and connector executors all use the default
            // behavior; this one now matches them.
            await using var reader = await command.ExecuteReaderAsync(cancellationToken)
                .ConfigureAwait(false);
            return await projector(reader, cancellationToken).ConfigureAwait(false);
        }
        catch (SqlException ex)
        {
            throw SqlExceptionClassifier.Classify(ex, probeId);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (SecretResolutionException ex)
        {
            throw new ProbeAuthenticationException(
                "A required authentication secret is unavailable.", null, null, ex);
        }
        catch (AuthenticationConfigurationException ex)
        {
            throw new ProbeAuthenticationException(
                "The configured authentication strategy could not be initialized.", null, null, ex);
        }
        catch (CredentialUnavailableException ex)
        {
            throw new ProbeAuthenticationException(
                "The configured Microsoft Entra credential was unavailable.", null, null, ex);
        }
        catch (AuthenticationFailedException ex)
        {
            throw new ProbeAuthenticationException(
                "The configured Microsoft Entra authentication failed.", null, null, ex);
        }
    }

    private static bool IsExpectedMasterFallback(ProbeExecutionException exception) =>
        exception is ProbePermissionDeniedException or ProbeObjectUnavailableException or
            ProbeDatabaseUnavailableException;

    private static void BindParameters(
        SqlCommand command,
        ProbeDefinition probe,
        IReadOnlyDictionary<string, object?>? values)
    {
        values ??= new Dictionary<string, object?>();
        foreach (var definition in probe.Parameters)
        {
            if (!values.TryGetValue(definition.Name, out var value))
                throw new InvalidOperationException($"Required probe parameter '{definition.Name}' was not supplied.");
            var parameter = command.Parameters.Add(definition.Name, ParseSqlDbType(definition.SqlDbType));
            parameter.Value = value ?? DBNull.Value;
        }
        if (values.Keys.Any(name => probe.Parameters.All(item => item.Name != name)))
            throw new InvalidOperationException("An undeclared probe parameter was supplied.");
    }

    private static SqlDbType ParseSqlDbType(string value) => value switch
    {
        "Int" => SqlDbType.Int,
        "BigInt" => SqlDbType.BigInt,
        "TinyInt" => SqlDbType.TinyInt,
        "DateTimeOffset" => SqlDbType.DateTimeOffset,
        _ => throw new InvalidOperationException($"Unsupported Query Store probe SqlDbType '{value}'."),
    };

    private static Dictionary<string, object?> CommonPage(
        int pageSize, DateTimeOffset start, DateTimeOffset end,
        Dictionary<string, object?> cursor)
    {
        cursor["@PageSize"] = pageSize; cursor["@StartTime"] = start; cursor["@EndTime"] = end;
        return cursor;
    }

    private static QueryStoreFactPage Page<T>(
        QueryStoreFactKind kind, IReadOnlyList<T> facts, int pageSize, object? cursor, bool active = false)
        where T : QueryStoreCollectedFact =>
        new(kind, facts.Cast<QueryStoreCollectedFact>().ToArray(),
            facts.Count == pageSize && cursor is not null ? Encode(cursor) : null, active);

    private static string Encode(object value) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value, value.GetType())));
    private static T? Decode<T>(string? token)
    {
        if (token is null) return default;
        try { return JsonSerializer.Deserialize<T>(Convert.FromBase64String(token)); }
        catch (Exception ex) when (ex is FormatException or JsonException)
        { throw new ArgumentException("Query Store collector page token is malformed.", nameof(token)); }
    }

    private QueryStoreDatabaseState Unavailable(
        string databaseId, QueryStoreCollectionState state, ServerCapabilities capabilities, string reason) =>
        new(databaseId, state, $"query-store:{databaseId}", null, timeProvider.GetUtcNow(), reason,
            capabilities.MajorVersion, capabilities.CompatibilityLevel,
            false, false, false, false);
    private static string Id(object value) => Convert.ToString(value, CultureInfo.InvariantCulture) ?? "0";
    private static long ParseInt64(string value) => long.Parse(value, CultureInfo.InvariantCulture);
    private static string Hash(object value) => value is byte[] bytes ? QueryHashFormat.Render(bytes) : Id(value);
    private static string? NullableString(object value) =>
        value is DBNull ? null : Convert.ToString(value, CultureInfo.InvariantCulture);
    private static string? NullableHex(object value) =>
        value is DBNull ? null : value is byte[] bytes ? QueryHashFormat.Render(bytes) : Id(value);
    private static bool Bool(object value) => Convert.ToBoolean(value, CultureInfo.InvariantCulture);
    private static BigInteger Big(object value) =>
        BigInteger.Parse(Convert.ToString(value, CultureInfo.InvariantCulture) ?? "0", CultureInfo.InvariantCulture);
    private static decimal Decimal(object value) => Convert.ToDecimal(value, CultureInfo.InvariantCulture);
    private static DateTimeOffset ReadDateTimeOffset(object value) =>
        value is DateTimeOffset offset ? offset : new DateTimeOffset(Convert.ToDateTime(value, CultureInfo.InvariantCulture));
    private static QueryStoreExecutionType ExecutionType(int value) => value switch
    { 0 => QueryStoreExecutionType.Regular, 3 => QueryStoreExecutionType.Aborted, 4 => QueryStoreExecutionType.Exception,
      _ => throw new InvalidOperationException("Query Store returned an unknown execution type.") };
    private static int ExecutionTypeCode(QueryStoreExecutionType value) => value switch
    { QueryStoreExecutionType.Regular => 0, QueryStoreExecutionType.Aborted => 3, _ => 4 };
    private static QueryPlanType PlanType(int value) => value switch
    { 0 => QueryPlanType.Compiled, 1 => QueryPlanType.Dispatcher, 2 => QueryPlanType.Variant, _ => QueryPlanType.Unknown };

    private sealed record TimeIdCursor(DateTimeOffset Time, long Id);
    private sealed record RuntimeCursor(long IntervalId, long PlanId, byte ExecutionType, long ReplicaGroupId);
    private sealed record WaitCursor(long IntervalId, long PlanId, byte ExecutionType, long ReplicaGroupId, byte WaitCategory);
    private sealed record IdCursor(long Id);
    private sealed record ServerCapabilities(
        int MajorVersion,
        int EngineEdition,
        int CompatibilityLevel,
        Dictionary<string, int> CompatibilityByDatabase,
        bool HasReplicaRuntimeColumn,
        bool HasVariantView,
        bool HasReplicaView,
        bool HasRestrictedText,
        bool SupportsOppo);
}
