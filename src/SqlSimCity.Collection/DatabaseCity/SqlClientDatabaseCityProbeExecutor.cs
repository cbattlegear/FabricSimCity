using System.Data;
using System.Globalization;
using System.Numerics;
using Azure.Identity;
using Microsoft.Data.SqlClient;
using SqlSimCity.Collection.Catalog;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.SqlServer;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.Collection.DatabaseCity;

public sealed class SqlClientDatabaseCityProbeExecutor(
    ISqlConnectionFactory connectionFactory,
    ConnectionProfile profile,
    ProbeCatalog catalog,
    TimeProvider timeProvider) : IDatabaseCityProbeExecutor
{
    public async Task<DatabaseCityProbePage> CollectPageAsync(
        string databaseName,
        int afterObjectId,
        int topN,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databaseName);
        ArgumentOutOfRangeException.ThrowIfNegative(afterObjectId);
        if (topN is < 1 or > 51)
            throw new ArgumentOutOfRangeException(nameof(topN));

        var inventory = await ExecuteAsync(
            "city.object_inventory_page",
            databaseName,
            new Dictionary<string, object?>
            {
                ["@AfterObjectId"] = afterObjectId,
                ["@TopN"] = topN,
            },
            async (reader, token) =>
            {
                var rows = new List<DatabaseCityInventoryRow>();
                while (await reader.ReadAsync(token).ConfigureAwait(false))
                {
                    rows.Add(new DatabaseCityInventoryRow(
                        Convert.ToInt32(reader["object_id"], CultureInfo.InvariantCulture),
                        Convert.ToInt32(reader["schema_id"], CultureInfo.InvariantCulture),
                        Convert.ToInt32(reader["schema_layout_ordinal"], CultureInfo.InvariantCulture),
                        Convert.ToString(reader["schema_name"], CultureInfo.InvariantCulture) ?? "",
                        Convert.ToString(reader["object_name"], CultureInfo.InvariantCulture) ?? "",
                        Convert.ToString(reader["object_type"], CultureInfo.InvariantCulture) == "INDEXED_VIEW"
                            ? DatabaseObjectKind.IndexedView
                            : DatabaseObjectKind.Table,
                        NullableUnsigned(reader["reserved_pages"]),
                        NullableUnsigned(reader["used_pages"]),
                        reader["index_id"] is DBNull
                            ? null
                            : Convert.ToInt32(reader["index_id"], CultureInfo.InvariantCulture),
                        reader["index_name"] is DBNull
                            ? null
                            : Convert.ToString(reader["index_name"], CultureInfo.InvariantCulture),
                        reader["index_type_desc"] is DBNull
                            ? null
                            : IndexKind(Convert.ToString(reader["index_type_desc"], CultureInfo.InvariantCulture))));
                }
                return (IReadOnlyList<DatabaseCityInventoryRow>)rows;
            },
            cancellationToken).ConfigureAwait(false);

        try
        {
            var usage = await ExecuteAsync(
                "city.index_usage_page",
                databaseName,
                new Dictionary<string, object?>
                {
                    ["@AfterObjectId"] = afterObjectId,
                    ["@TopN"] = topN,
                },
                async (reader, token) =>
                {
                    var rows = new List<DatabaseCityIndexUsageRow>();
                    while (await reader.ReadAsync(token).ConfigureAwait(false))
                    {
                        var total = UnsignedInteger(reader["user_seeks"]) +
                                    UnsignedInteger(reader["user_scans"]) +
                                    UnsignedInteger(reader["user_lookups"]) +
                                    UnsignedInteger(reader["user_updates"]);
                        rows.Add(new DatabaseCityIndexUsageRow(
                            Convert.ToInt32(reader["object_id"], CultureInfo.InvariantCulture),
                            Convert.ToInt32(reader["index_id"], CultureInfo.InvariantCulture),
                            total.ToString(CultureInfo.InvariantCulture)));
                    }
                    return (IReadOnlyList<DatabaseCityIndexUsageRow>)rows;
                },
                cancellationToken).ConfigureAwait(false);
            return new DatabaseCityProbePage(
                inventory, usage, DataStatus.Available,
                "Direct cumulative index usage counters were collected; reset epoch is unavailable because database detach/shutdown resets are not timestamped.",
                timeProvider.GetUtcNow());
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (ProbePermissionDeniedException ex)
        {
            return new DatabaseCityProbePage(
                inventory, [], DataStatus.PermissionDenied, ex.Reason, timeProvider.GetUtcNow());
        }
        catch (ProbeObjectUnavailableException ex)
        {
            return new DatabaseCityProbePage(
                inventory, [], DataStatus.Unsupported, ex.Reason, timeProvider.GetUtcNow());
        }
    }

    private async Task<T> ExecuteAsync<T>(
        string probeId,
        string databaseName,
        Dictionary<string, object?>? values,
        Func<SqlDataReader, CancellationToken, Task<T>> projector,
        CancellationToken cancellationToken)
    {
        var probe = catalog.Get(probeId);
        if (!probe.ConnectionScope.Equals("database", StringComparison.Ordinal))
            throw new InvalidOperationException($"Probe '{probeId}' must be database scoped.");
        var databaseProfile = profile.WithInitialDatabase(databaseName);
        SqlConnectionOpenResult opened;
        try
        {
            opened = await connectionFactory.OpenAsync(databaseProfile, cancellationToken).ConfigureAwait(false);
        }
        catch (SqlException ex)
        {
            throw SqlExceptionClassifier.Classify(ex, probeId);
        }
        catch (SecretResolutionException ex)
        {
            throw new ProbeAuthenticationException(
                "A configured authentication secret was unavailable.", null, null, ex);
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

        await using (opened.ConfigureAwait(false))
        await using (var command = opened.Connection.CreateCommand())
        {
            command.CommandType = CommandType.Text;
            command.CommandText = probe.CommandText;
            command.CommandTimeout = databaseProfile.Timeouts.CommandTimeoutSeconds;
            var parameters = SqlClientProbeExecutor.BuildParameters(probe, values);
            if (parameters.Length > 0)
                command.Parameters.AddRange(parameters);
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

    private static string Unsigned(object value) =>
        UnsignedInteger(value).ToString(CultureInfo.InvariantCulture);

    private static string? NullableUnsigned(object value) =>
        value is DBNull ? null : Unsigned(value);

    private static BigInteger UnsignedInteger(object value)
    {
        var text = Convert.ToString(value, CultureInfo.InvariantCulture);
        if (!BigInteger.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) || parsed < 0)
            throw new ProbeDataFormatException("A database-city probe returned an invalid unsigned integer.");
        return parsed;
    }

    private static DatabaseIndexKind IndexKind(string? kind) => kind switch
    {
        "HEAP" => DatabaseIndexKind.Heap,
        "CLUSTERED" => DatabaseIndexKind.Clustered,
        "NONCLUSTERED" => DatabaseIndexKind.Nonclustered,
        "CLUSTERED COLUMNSTORE" or "NONCLUSTERED COLUMNSTORE" => DatabaseIndexKind.Columnstore,
        _ => DatabaseIndexKind.Other,
    };
}
