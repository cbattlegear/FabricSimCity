using System.Data;
using System.Globalization;
using Microsoft.Data.SqlClient;
using SqlSimCity.SqlServer;

namespace SqlSimCity.Collection.Probes;

/// <summary>
/// A real <c>Microsoft.Data.SqlClient</c>-backed <see cref="IProbeExecutor"/>. Every command is
/// static catalog SQL taken verbatim from the embedded <c>ProbeCatalog</c> (never string-built or
/// interpolated), every parameter is bound by name via <see cref="SqlParameter"/>, the command
/// timeout always comes from the connection profile's own
/// <see cref="ConnectionTimeouts.CommandTimeoutSeconds"/>, and every call honors the supplied
/// <see cref="CancellationToken"/>. No probe here mutates server state. This executor opens one
/// connection per call through <see cref="ISqlConnectionFactory"/> rather than holding a
/// long-lived connection, matching the "small metadata/permission probes, not bulk telemetry"
/// scope of the capability negotiation layer.
/// </summary>
public sealed class SqlClientProbeExecutor : IProbeExecutor
{
    private readonly ISqlConnectionFactory _connectionFactory;
    private readonly ConnectionProfile _profile;
    private readonly Catalog.ProbeCatalog _catalog;

    public SqlClientProbeExecutor(ISqlConnectionFactory connectionFactory, ConnectionProfile profile, Catalog.ProbeCatalog catalog)
    {
        ArgumentNullException.ThrowIfNull(connectionFactory);
        ArgumentNullException.ThrowIfNull(profile);
        ArgumentNullException.ThrowIfNull(catalog);
        _connectionFactory = connectionFactory;
        _profile = profile;
        _catalog = catalog;
    }

    public Task<ServerIdentityResult> GetServerIdentityAsync(CancellationToken cancellationToken) =>
        ExecuteAsync(
            "server.identity",
            "master",
            databaseName: null,
            parameters: null,
            async (reader, ct) =>
            {
                if (!await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    throw new ProbeObjectUnavailableException("Probe 'server.identity' returned no row.", null, null);
                }

                return new ServerIdentityResult(
                    reader["server_name"] as string,
                    reader["product_version"] as string,
                    reader["product_level"] as string,
                    reader["edition"] as string,
                    Convert.ToInt32(reader["engine_edition"], CultureInfo.InvariantCulture),
                    Convert.ToInt32(reader["is_hadr_enabled"], CultureInfo.InvariantCulture) != 0,
                    Convert.ToInt32(reader["cpu_count"], CultureInfo.InvariantCulture),
                    Convert.ToInt32(reader["scheduler_count"], CultureInfo.InvariantCulture),
                    reader["physical_memory_mb"] is DBNull ? null : Convert.ToInt64(reader["physical_memory_mb"], CultureInfo.InvariantCulture),
                    reader["sqlserver_start_time"] is DBNull
                        ? null
                        : new DateTimeOffset(Convert.ToDateTime(reader["sqlserver_start_time"], CultureInfo.InvariantCulture)));
            },
            cancellationToken);

    public Task<IReadOnlyList<DatabaseDiscoveryRow>> GetDatabaseDiscoveryAsync(CancellationToken cancellationToken) =>
        ExecuteAsync(
            "server.database_discovery",
            "master",
            databaseName: null,
            parameters: null,
            async (reader, ct) =>
            {
                var rows = new List<DatabaseDiscoveryRow>();
                while (await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    rows.Add(new DatabaseDiscoveryRow(
                        Convert.ToInt32(reader["database_id"], CultureInfo.InvariantCulture),
                        (string)reader["database_name"],
                        (string)reader["state_desc"],
                        Convert.ToInt32(reader["compatibility_level"], CultureInfo.InvariantCulture),
                        Convert.ToInt32(reader["is_query_store_on"], CultureInfo.InvariantCulture) != 0));
                }

                return (IReadOnlyList<DatabaseDiscoveryRow>)rows;
            },
            cancellationToken);

    public Task<QueryStoreOptionsRow?> GetQueryStoreOptionsAsync(string databaseName, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databaseName);
        return ExecuteAsync(
            "querystore.options_2019",
            "database",
            databaseName,
            parameters: null,
            async (reader, ct) =>
            {
                if (!await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    return (QueryStoreOptionsRow?)null;
                }

                return new QueryStoreOptionsRow(
                    (string)reader["desired_state_desc"],
                    (string)reader["actual_state_desc"],
                    Convert.ToInt32(reader["readonly_reason"], CultureInfo.InvariantCulture),
                    Convert.ToInt64(reader["current_storage_size_mb"], CultureInfo.InvariantCulture),
                    Convert.ToInt64(reader["max_storage_size_mb"], CultureInfo.InvariantCulture),
                    (string)reader["query_capture_mode_desc"]);
            },
            cancellationToken);
    }

    public Task<QueryStorePlanMetadataResult> GetQueryStorePlanMetadataAsync(string databaseName, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databaseName);
        return ExecuteAsync(
            "capability.query_store_plan_metadata",
            "database",
            databaseName,
            parameters: null,
            async (reader, ct) =>
            {
                var rows = new List<(string ViewName, string ColumnName)>();
                while (await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    rows.Add(((string)reader["view_name"], (string)reader["column_name"]));
                }

                return QueryStorePlanMetadataResult.FromColumnNames(rows);
            },
            cancellationToken);
    }

    public Task<bool?> CheckServerPermissionAsync(string permission, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(permission);
        return ExecuteAsync(
            "capability.server_permission_check",
            "server",
            databaseName: null,
            new Dictionary<string, object?> { ["@Permission"] = permission },
            ReadHasPermissionAsync,
            cancellationToken);
    }

    public Task<bool?> CheckDatabasePermissionAsync(string databaseName, string permission, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databaseName);
        ArgumentException.ThrowIfNullOrWhiteSpace(permission);
        return ExecuteAsync(
            "capability.database_permission_check",
            "database",
            databaseName,
            new Dictionary<string, object?> { ["@Permission"] = permission },
            ReadHasPermissionAsync,
            cancellationToken);
    }

    public Task<AzureResourceGovernanceRow?> GetAzureResourceGovernanceAsync(string databaseName, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databaseName);
        return ExecuteAsync(
            "capability.azure_resource_governance",
            "database",
            databaseName,
            parameters: null,
            async (reader, ct) =>
            {
                if (!await reader.ReadAsync(ct).ConfigureAwait(false))
                {
                    return (AzureResourceGovernanceRow?)null;
                }

                return new AzureResourceGovernanceRow(
                    reader["cpu_limit"] is DBNull ? null : Convert.ToDouble(reader["cpu_limit"], CultureInfo.InvariantCulture),
                    reader["process_memory_limit_mb"] is DBNull ? null : Convert.ToInt64(reader["process_memory_limit_mb"], CultureInfo.InvariantCulture));
            },
            cancellationToken);
    }

    private static async Task<bool?> ReadHasPermissionAsync(SqlDataReader reader, CancellationToken ct)
    {
        if (!await reader.ReadAsync(ct).ConfigureAwait(false))
        {
            return null;
        }

        return reader["has_permission"] is DBNull ? null : Convert.ToInt32(reader["has_permission"], CultureInfo.InvariantCulture) != 0;
    }

    /// <summary>
    /// Opens one connection, runs one catalog probe, hands the live reader to
    /// <paramref name="project"/>, and guarantees the connection (and any credential lease it
    /// holds) is disposed before returning -- regardless of whether <paramref name="project"/>
    /// completes, throws, or the token is cancelled.
    /// </summary>
    private async Task<T> ExecuteAsync<T>(
        string probeId,
        string expectedConnectionScope,
        string? databaseName,
        IReadOnlyDictionary<string, object?>? parameters,
        Func<SqlDataReader, CancellationToken, Task<T>> project,
        CancellationToken cancellationToken)
    {
        var probe = _catalog.Get(probeId);
        if (!string.Equals(probe.ConnectionScope, expectedConnectionScope, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"Probe '{probeId}' declares connectionScope '{probe.ConnectionScope}', not expected scope '{expectedConnectionScope}'.");
        }

        var boundParameters = BuildParameters(probe, parameters);
        var executionProfile = expectedConnectionScope switch
        {
            "master" => _profile.WithInitialDatabase("master"),
            "database" when !string.IsNullOrWhiteSpace(databaseName) => _profile.WithInitialDatabase(databaseName),
            "database" => throw new InvalidOperationException($"Database-scoped probe '{probeId}' requires a target database."),
            "server" => _profile,
            _ => throw new InvalidOperationException($"Probe '{probeId}' cannot execute through this capability executor with scope '{expectedConnectionScope}'."),
        };

        SqlConnectionOpenResult openResult;
        try
        {
            openResult = await _connectionFactory.OpenAsync(executionProfile, cancellationToken).ConfigureAwait(false);
        }
        catch (SqlException ex)
        {
            throw SqlExceptionClassifier.Classify(ex, probeId);
        }

        await using (openResult.ConfigureAwait(false))
        {
            await using var command = openResult.Connection.CreateCommand();
            command.CommandType = CommandType.Text;
            command.CommandText = probe.CommandText;
            command.CommandTimeout = executionProfile.Timeouts.CommandTimeoutSeconds;
            if (boundParameters.Length > 0)
            {
                command.Parameters.AddRange(boundParameters);
            }

            try
            {
                await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                return await project(reader, cancellationToken).ConfigureAwait(false);
            }
            catch (SqlException ex)
            {
                throw SqlExceptionClassifier.Classify(ex, probeId);
            }
        }
    }

    internal static SqlParameter[] BuildParameters(
        Catalog.ProbeDefinition probe,
        IReadOnlyDictionary<string, object?>? values)
    {
        values ??= new Dictionary<string, object?>();
        var declared = probe.Parameters.ToDictionary(parameter => parameter.Name, StringComparer.Ordinal);
        var undeclared = values.Keys.Where(name => !declared.ContainsKey(name)).ToList();
        var missing = probe.Parameters
            .Where(parameter => parameter.Required && !values.ContainsKey(parameter.Name))
            .Select(parameter => parameter.Name)
            .ToList();
        if (undeclared.Count > 0 || missing.Count > 0)
        {
            throw new InvalidOperationException(
                $"Probe '{probe.Id}' parameter contract mismatch. " +
                $"Undeclared: [{string.Join(", ", undeclared)}]; missing required: [{string.Join(", ", missing)}].");
        }

        var result = new List<SqlParameter>(values.Count);
        foreach (var definition in probe.Parameters)
        {
            if (!values.TryGetValue(definition.Name, out var value))
            {
                continue;
            }

            if (!Enum.TryParse<SqlDbType>(definition.SqlDbType, ignoreCase: false, out var sqlDbType))
            {
                throw new InvalidOperationException(
                    $"Probe '{probe.Id}' parameter '{definition.Name}' declares unsupported SqlDbType '{definition.SqlDbType}'.");
            }

            result.Add(new SqlParameter(definition.Name, sqlDbType) { Value = value ?? DBNull.Value });
        }

        return [.. result];
    }
}
