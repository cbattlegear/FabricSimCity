using System.Data;
using System.Globalization;
using System.Numerics;
using Microsoft.Data.SqlClient;
using SqlSimCity.Collection.Catalog;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.SqlServer;

namespace SqlSimCity.Collection.Atlas;

public sealed class SqlClientAtlasProbeExecutor : IAtlasProbeExecutor
{
    private readonly ISqlConnectionFactory _connectionFactory;
    private readonly ConnectionProfile _profile;
    private readonly ProbeCatalog _catalog;
    private readonly TimeProvider _timeProvider;

    public SqlClientAtlasProbeExecutor(
        ISqlConnectionFactory connectionFactory,
        ConnectionProfile profile,
        ProbeCatalog catalog,
        TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(connectionFactory);
        ArgumentNullException.ThrowIfNull(profile);
        ArgumentNullException.ThrowIfNull(catalog);
        _connectionFactory = connectionFactory;
        _profile = profile;
        _catalog = catalog;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public async Task<AtlasTargetIdentity> GetTargetIdentityAsync(CancellationToken cancellationToken)
    {
        var row = await ExecuteAsync("server.identity", "master", _profile.InitialDatabase, null, async (reader, ct) =>
        {
            if (!await reader.ReadAsync(ct).ConfigureAwait(false))
                throw new ProbeObjectUnavailableException("The server identity probe returned no row.", null, null);
            return new AtlasTargetIdentity(
                Platform(Convert.ToInt32(reader["engine_edition"], CultureInfo.InvariantCulture)),
                Convert.ToString(reader["product_version"], CultureInfo.InvariantCulture) ?? "",
                Convert.ToString(reader["edition"], CultureInfo.InvariantCulture) ?? "",
                reader["sqlserver_start_time"] is DBNull ? null : AsOffset(reader["sqlserver_start_time"]),
                _timeProvider.GetUtcNow());
        }, cancellationToken).ConfigureAwait(false);
        return row with { SourceTimestamp = _timeProvider.GetUtcNow() };
    }

    public Task<IReadOnlyList<AtlasDatabaseIdentity>> DiscoverDatabasesAsync(CancellationToken cancellationToken) =>
        ExecuteAsync("server.database_discovery", "master", null, null, async (reader, ct) =>
        {
            var rows = new List<AtlasDatabaseIdentity>();
            while (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                rows.Add(new AtlasDatabaseIdentity(
                    (string)reader["database_name"],
                    (string)reader["state_desc"],
                    Convert.ToInt32(reader["compatibility_level"], CultureInfo.InvariantCulture),
                    Convert.ToBoolean(reader["is_query_store_on"], CultureInfo.InvariantCulture)));
            }
            return (IReadOnlyList<AtlasDatabaseIdentity>)rows;
        }, cancellationToken);

    public async Task<AtlasDatabaseProbeResult> CollectDatabaseAsync(
        string databaseName,
        AtlasProbeSelection selection,
        DateTimeOffset queryStoreWindowStart,
        DateTimeOffset queryStoreWindowEnd,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databaseName);
        var identity = await ReadIdentityAsync(databaseName, cancellationToken).ConfigureAwait(false);
        var (space, spaceRows) = await ReadSpaceAsync(databaseName, cancellationToken).ConfigureAwait(false);
        var options = await ReadQueryStoreOptionsAsync(databaseName, selection.QueryStoreOptionsProbeId, cancellationToken)
            .ConfigureAwait(false);
        var queryStoreReadable = options.ActualState.Equals("ON", StringComparison.OrdinalIgnoreCase) ||
                                 options.ActualState.Equals("READ_WRITE", StringComparison.OrdinalIgnoreCase) ||
                                 options.ActualState.Equals("READ_ONLY", StringComparison.OrdinalIgnoreCase);
        var runtimeSelection = queryStoreReadable
            ? await ResolveRuntimeProbeAsync(databaseName, selection.QueryStoreRuntimeProbeId, cancellationToken)
                .ConfigureAwait(false)
            : (ProbeId: selection.QueryStoreRuntimeProbeId, Rows: 0);
        var (queryStore, queryRows) = queryStoreReadable
            ? await ReadQueryStoreRuntimeAsync(databaseName, runtimeSelection.ProbeId,
                queryStoreWindowStart, queryStoreWindowEnd, options, cancellationToken).ConfigureAwait(false)
            : (WithOptions(new AtlasQueryStoreResult(
                options.ActualState, options.ReadOnlyReason, null, null, null, null, null, null), options), 0);
        var (io, ioRows) = await ReadIoAsync(databaseName, selection.FileIoProbeId, cancellationToken).ConfigureAwait(false);
        return new AtlasDatabaseProbeResult(
            identity, space, queryStore, io, _timeProvider.GetUtcNow(),
            2 + spaceRows + runtimeSelection.Rows + queryRows + ioRows);
    }

    private Task<AtlasDatabaseIdentity> ReadIdentityAsync(string databaseName, CancellationToken cancellationToken) =>
        ExecuteAsync("server.database_identity_current", "database", databaseName, null, async (reader, ct) =>
        {
            if (!await reader.ReadAsync(ct).ConfigureAwait(false))
                throw new ProbeDatabaseUnavailableException("The current database identity was unavailable.", null, null);
            return new AtlasDatabaseIdentity(
                (string)reader["database_name"],
                (string)reader["state_desc"],
                Convert.ToInt32(reader["compatibility_level"], CultureInfo.InvariantCulture),
                Convert.ToBoolean(reader["is_query_store_on"], CultureInfo.InvariantCulture));
        }, cancellationToken);

    private async Task<(AtlasSpaceResult Value, int Rows)> ReadSpaceAsync(
        string databaseName,
        CancellationToken cancellationToken)
    {
        var files = await ExecuteAsync("space.database_file_space", "database", databaseName, null, async (reader, ct) =>
        {
            var rows = new List<DatabaseFileSpaceValue>();
            while (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                rows.Add(new DatabaseFileSpaceValue(
                    (string)reader["type_desc"],
                    Unsigned(reader["allocated_bytes"]),
                    reader["data_used_bytes"] is DBNull ? null : Unsigned(reader["data_used_bytes"])));
            }
            return rows;
        }, cancellationToken).ConfigureAwait(false);

        var log = await ExecuteAsync("space.log_space_usage", "database", databaseName, null, async (reader, ct) =>
        {
            if (!await reader.ReadAsync(ct).ConfigureAwait(false))
                throw new ProbeObjectUnavailableException("The log space probe returned no row.", null, null);
            return (Allocated: Unsigned(reader["total_log_size_bytes"]), Used: Unsigned(reader["used_log_space_bytes"]));
        }, cancellationToken).ConfigureAwait(false);

        return (AggregateSpace(files, log.Allocated, log.Used), files.Count + 1);
    }

    private Task<QueryStoreOptions> ReadQueryStoreOptionsAsync(
        string databaseName,
        string probeId,
        CancellationToken cancellationToken) =>
        ExecuteAsync(probeId, "database", databaseName, null, async (reader, ct) =>
        {
            if (!await reader.ReadAsync(ct).ConfigureAwait(false))
                throw new ProbeObjectUnavailableException("The Query Store options probe returned no row.", null, null);
            return new QueryStoreOptions(
                Convert.ToString(reader["actual_state_desc"], CultureInfo.InvariantCulture) ?? "UNKNOWN",
                Convert.ToInt32(reader["readonly_reason"], CultureInfo.InvariantCulture),
                Convert.ToString(reader["desired_state_desc"], CultureInfo.InvariantCulture),
                Convert.ToString(reader["query_capture_mode_desc"], CultureInfo.InvariantCulture),
                (Unsigned(reader["current_storage_size_mb"]) * 1_048_576).ToString(CultureInfo.InvariantCulture),
                (Unsigned(reader["max_storage_size_mb"]) * 1_048_576).ToString(CultureInfo.InvariantCulture));
        }, cancellationToken);

    private async Task<(string ProbeId, int Rows)> ResolveRuntimeProbeAsync(
        string databaseName,
        string selectedProbeId,
        CancellationToken cancellationToken)
    {
        if (!selectedProbeId.Equals("querystore.runtime_stats_summary_2022", StringComparison.Ordinal))
            return (selectedProbeId, 0);

        var metadata = await ExecuteAsync(
            "capability.query_store_plan_metadata", "database", databaseName, null,
            async (reader, ct) =>
            {
                var rows = new List<(string ViewName, string ColumnName)>();
                while (await reader.ReadAsync(ct).ConfigureAwait(false))
                    rows.Add(((string)reader["view_name"], (string)reader["column_name"]));
                return rows;
            }, cancellationToken).ConfigureAwait(false);
        var hasReplicaGroupId = QueryStorePlanMetadataResult.FromColumnNames(metadata).HasReplicaGroupId;
        return (hasReplicaGroupId
            ? selectedProbeId
            : "querystore.runtime_stats_summary_2016", metadata.Count);
    }

    private async Task<(AtlasQueryStoreResult Value, int Rows)> ReadQueryStoreRuntimeAsync(
        string databaseName,
        string probeId,
        DateTimeOffset start,
        DateTimeOffset end,
        QueryStoreOptions options,
        CancellationToken cancellationToken)
    {
        var aggregate = await ExecuteAsync(probeId, "database", databaseName,
            new Dictionary<string, object?> { ["@StartTime"] = start, ["@EndTime"] = end },
            async (reader, ct) =>
            {
                var count = BigInteger.Zero;
                var duration = BigInteger.Zero;
                var cpu = BigInteger.Zero;
                var reads = BigInteger.Zero;
                var rows = 0;
                while (await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    rows++;
                    count += Unsigned(reader["total_count_executions"]);
                    duration += Unsigned(reader["total_duration_us"]);
                    cpu += Unsigned(reader["total_cpu_time_us"]);
                    reads += Unsigned(reader["total_logical_io_reads_pages"]);
                }
                return (count, duration, cpu, reads, rows);
            }, cancellationToken).ConfigureAwait(false);

        return (WithOptions(new AtlasQueryStoreResult(
            options.ActualState,
            options.ReadOnlyReason,
            aggregate.count.ToString(CultureInfo.InvariantCulture),
            aggregate.duration.ToString(CultureInfo.InvariantCulture),
            aggregate.cpu.ToString(CultureInfo.InvariantCulture),
            aggregate.reads.ToString(CultureInfo.InvariantCulture),
            start,
            end), options), aggregate.rows);
    }

    private async Task<(IReadOnlyList<AtlasFileIoCounter> Value, int Rows)> ReadIoAsync(
        string databaseName,
        string probeId,
        CancellationToken cancellationToken)
    {
        var scope = probeId.Equals("io.file_io_stats_current_db", StringComparison.Ordinal)
            ? "database"
            : "server";
        var rows = await ExecuteAsync(probeId, scope, databaseName, null, async (reader, ct) =>
        {
            var values = new List<AtlasFileIoCounter>();
            while (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                if (scope == "server" &&
                    !string.Equals(Convert.ToString(reader["database_name"], CultureInfo.InvariantCulture),
                        databaseName, StringComparison.OrdinalIgnoreCase))
                    continue;
                values.Add(new AtlasFileIoCounter(
                    Convert.ToInt32(reader["file_id"], CultureInfo.InvariantCulture),
                    Unsigned(reader["num_of_bytes_read"]).ToString(CultureInfo.InvariantCulture),
                    Unsigned(reader["num_of_bytes_written"]).ToString(CultureInfo.InvariantCulture),
                    Convert.ToInt64(reader["sample_ms"], CultureInfo.InvariantCulture)));
            }
            return values;
        }, cancellationToken).ConfigureAwait(false);
        return (rows, rows.Count);
    }

    private async Task<T> ExecuteAsync<T>(
        string probeId,
        string expectedScope,
        string? databaseName,
        Dictionary<string, object?>? values,
        Func<SqlDataReader, CancellationToken, Task<T>> projector,
        CancellationToken cancellationToken)
    {
        var probe = _catalog.Get(probeId);
        if (!probe.ConnectionScope.Equals(expectedScope, StringComparison.Ordinal))
            throw new InvalidOperationException($"Probe '{probeId}' does not have the required connection scope.");
        var profile = expectedScope == "master"
            ? _profile.WithInitialDatabase(databaseName ?? "master")
            : expectedScope == "database" && databaseName is not null
                ? _profile.WithInitialDatabase(databaseName)
                : _profile;
        SqlConnectionOpenResult opened;
        try
        {
            opened = await _connectionFactory.OpenAsync(profile, cancellationToken).ConfigureAwait(false);
        }
        catch (SqlException ex)
        {
            throw SqlExceptionClassifier.Classify(ex, probeId);
        }

        await using (opened.ConfigureAwait(false))
        await using (var command = opened.Connection.CreateCommand())
        {
            command.CommandType = CommandType.Text;
            command.CommandText = probe.CommandText;
            command.CommandTimeout = profile.Timeouts.CommandTimeoutSeconds;
            foreach (var parameter in probe.Parameters)
            {
                if (values is null || !values.TryGetValue(parameter.Name, out var value))
                    throw new InvalidOperationException($"Probe '{probeId}' requires parameter '{parameter.Name}'.");
                command.Parameters.Add(new SqlParameter(parameter.Name, value ?? DBNull.Value));
            }
            if ((values?.Count ?? 0) != probe.Parameters.Count)
                throw new InvalidOperationException($"Probe '{probeId}' received undeclared parameters.");
            try
            {
                await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                return await projector(reader, cancellationToken).ConfigureAwait(false);
            }
            catch (SqlException ex)
            {
                throw SqlExceptionClassifier.Classify(ex, probeId);
            }
        }
    }

    private static BigInteger Unsigned(object value)
    {
        var text = Convert.ToString(value, CultureInfo.InvariantCulture);
        if (!BigInteger.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) || parsed < 0)
            throw new InvalidOperationException("A SQL probe returned an invalid unsigned integer.");
        return parsed;
    }

    private static DateTimeOffset AsOffset(object value) => value switch
    {
        DateTimeOffset offset => offset,
        DateTime dateTime => new DateTimeOffset(DateTime.SpecifyKind(dateTime, DateTimeKind.Utc)),
        _ => DateTimeOffset.Parse(Convert.ToString(value, CultureInfo.InvariantCulture)!,
            CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal),
    };

    private static EnginePlatform Platform(int engineEdition) => engineEdition switch
    {
        5 => EnginePlatform.AzureSqlDatabase,
        8 => EnginePlatform.AzureSqlManagedInstance,
        1 or 2 or 3 or 4 => EnginePlatform.SqlServerOnPremises,
        _ => EnginePlatform.Unsupported,
    };

    private static AtlasQueryStoreResult WithOptions(AtlasQueryStoreResult result, QueryStoreOptions options) =>
        result with
        {
            DesiredState = options.DesiredState,
            CaptureMode = options.CaptureMode,
            CurrentStorageBytes = options.CurrentStorageBytes,
            MaxStorageBytes = options.MaxStorageBytes,
        };

    internal static AtlasSpaceResult AggregateSpace(
        IEnumerable<DatabaseFileSpaceValue> files,
        BigInteger logAllocated,
        BigInteger logUsed)
    {
        var dataFiles = files.Where(file => file.Type.Equals("ROWS", StringComparison.OrdinalIgnoreCase)).ToArray();
        if (dataFiles.Any(file => file.Used is null))
            throw new ProbePermissionDeniedException(
                "Exact used data bytes were not visible to the collector principal.", null, null);
        return new AtlasSpaceResult(
            dataFiles.Aggregate(BigInteger.Zero, (sum, file) => sum + file.Allocated).ToString(CultureInfo.InvariantCulture),
            dataFiles.Aggregate(BigInteger.Zero, (sum, file) => sum + file.Used!.Value).ToString(CultureInfo.InvariantCulture),
            logAllocated.ToString(CultureInfo.InvariantCulture),
            logUsed.ToString(CultureInfo.InvariantCulture));
    }

    private sealed record QueryStoreOptions(
        string ActualState,
        int ReadOnlyReason,
        string? DesiredState,
        string? CaptureMode,
        string CurrentStorageBytes,
        string MaxStorageBytes);
}

internal sealed record DatabaseFileSpaceValue(string Type, BigInteger Allocated, BigInteger? Used);
