using System.Globalization;
using System.Numerics;
using System.Text;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Collection.DatabaseCity;

public sealed class ConnectedDatabaseCitySource(
    IAtlasSnapshotSource atlasSource,
    IDatabaseCityProbeExecutor probeExecutor) : IDatabaseCitySource
{
    public ValueTask<DatabaseCitySummarySnapshotV1> GetSummariesAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var atlas = atlasSource.GetCurrent();
        var summaries = atlas.Databases
            .OrderBy(database => database.DatabaseId, StringComparer.Ordinal)
            .Select(database =>
            {
                const string reason =
                    "Object counts are collected only when this database is entered; database size comes from the atlas.";
                return new DatabaseCitySummaryV1(
                    database.DatabaseId,
                    database.Name,
                    null,
                    null,
                    null,
                    MeasurementStatus.Unknown,
                    new EvidenceV1(EvidenceSource.NotProbed, DataStatus.Unknown, atlas.GeneratedAt, null, reason));
            })
            .ToArray();
        return ValueTask.FromResult(new DatabaseCitySummarySnapshotV1("1.0", atlas.GeneratedAt, summaries));
    }

    public async Task<DatabaseCityPageV1?> GetDatabaseAsync(
        string databaseId,
        DatabaseCityMetric metric,
        int pageSize,
        string? pageToken,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (pageSize is < 1 or > 50)
            throw new ArgumentOutOfRangeException(nameof(pageSize));
        var database = atlasSource.GetCurrent().Databases.SingleOrDefault(
            item => item.DatabaseId.Equals(databaseId, StringComparison.Ordinal));
        if (database is null)
            return null;
        var cursor = DecodeToken(pageToken, databaseId, metric, pageSize);

        DatabaseCityProbePage probe;
        try
        {
            probe = await probeExecutor.CollectPageAsync(
                database.Name, cursor.AfterObjectId, pageSize + 1, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (ProbeExecutionException ex)
        {
            return UnavailablePage(database, metric, pageSize, Status(ex), ex.Reason);
        }

        var groups = probe.Inventory
            .GroupBy(row => row.ObjectId)
            .OrderBy(group => group.Key)
            .ToArray();
        var selectedGroups = groups.Take(pageSize).ToArray();
        var usageByIndex = probe.Usage.ToDictionary(
            row => (row.ObjectId, row.IndexId),
            row => row.TotalOperations);
        var directEvidence = new EvidenceV1(
            EvidenceSource.LiveDmvCumulative,
            probe.UsageStatus,
            probe.ObservedAt,
            null,
            probe.UsageReason);
        var unavailableAttribution = new EvidenceV1(
            EvidenceSource.NotProbed,
            DataStatus.Unknown,
            null,
            null,
            "Normalized plan attribution is unavailable for this bounded connected page.");
        var schemas = selectedGroups
            .Select(group => group.First())
            .GroupBy(row => row.SchemaId)
            .Select(group =>
            {
                var row = group.First();
                return new DatabaseCitySchemaEvidence(
                    $"{databaseId}/schema/{row.SchemaId.ToString(CultureInfo.InvariantCulture)}",
                    row.SchemaName,
                    row.SchemaLayoutOrdinal);
            })
            .ToArray();
        var schemaIdsByContractId = selectedGroups
            .Select(group => group.First())
            .DistinctBy(row => row.SchemaId)
            .ToDictionary(
                row => $"{databaseId}/schema/{row.SchemaId.ToString(CultureInfo.InvariantCulture)}",
                row => row.SchemaId,
                StringComparer.Ordinal);
        var evidenceObjects = selectedGroups.Select((group, pageOrdinal) =>
        {
            var first = group.First();
            var objectId = ObjectId(databaseId, first.ObjectId);
            var indexes = group
                .OrderBy(row => row.IndexId)
                .Select(row =>
                {
                    var operations = probe.UsageStatus == DataStatus.Available
                        ? usageByIndex.GetValueOrDefault((row.ObjectId, row.IndexId), "0")
                        : null;
                    return new DatabaseCityIndexV1(
                        $"{objectId}/index/{row.IndexId.ToString(CultureInfo.InvariantCulture)}",
                        row.IndexName ?? "HEAP",
                        row.IndexKind,
                        new DatabaseCityDirectActivityV1(
                            operations,
                            null,
                            directEvidence));
                })
                .ToArray();
            var totalOperations = probe.UsageStatus == DataStatus.Available
                ? indexes.Aggregate(BigInteger.Zero, (sum, index) =>
                    sum + BigInteger.Parse(
                        index.DirectActivity.TotalOperations!, NumberStyles.None, CultureInfo.InvariantCulture))
                    .ToString(CultureInfo.InvariantCulture)
                : null;
            return new DatabaseCityObjectEvidence(
                objectId,
                $"{databaseId}/schema/{first.SchemaId.ToString(CultureInfo.InvariantCulture)}",
                first.ObjectName,
                first.Kind,
                first.ReservedPages8KiB,
                first.UsedPages8KiB,
                indexes,
                [])
            {
                LayoutOrdinal = cursor.LayoutOffset + pageOrdinal,
                DirectActivity = new DatabaseCityDirectActivityV1(
                    totalOperations,
                    null,
                    directEvidence),
                AttributedExposure = new DatabaseCityAttributedExposureV1(
                    null, null, null, null,
                    QueryAttributionConfidence.Unknown,
                    "No normalized plan evidence was joined; query totals are not assigned to this object.",
                    unavailableAttribution),
            };
        }).ToArray();
        var projected = DatabaseCityProjector.ProjectObjects(schemas, evidenceObjects);
        var nextToken = groups.Length > pageSize && selectedGroups.Length > 0
            ? EncodeToken(
                databaseId, metric, pageSize, selectedGroups[^1].Key,
                cursor.LayoutOffset + selectedGroups.Length)
            : null;
        var schemaContracts = schemas
            .OrderBy(schema => schema.SchemaId, StringComparer.Ordinal)
            .Select(schema => new DatabaseCitySchemaV1(
                schema.SchemaId,
                schema.Name,
                schema.LayoutOrdinal ?? 0,
                selectedGroups.Count(group =>
                        group.First().SchemaId == schemaIdsByContractId[schema.SchemaId])
                    .ToString(CultureInfo.InvariantCulture),
                new EvidenceV1(
                    EvidenceSource.CatalogSnapshot, DataStatus.Available, probe.ObservedAt, null,
                    "Schema neighborhood from the bounded current-database catalog page.")))
            .ToArray();
        var workloadEvidence = new EvidenceV1(
            EvidenceSource.NotProbed, DataStatus.Unknown, null, null,
            "Other workload is unavailable because no same-window normalized plan attribution aggregate was collected.");
        var pageEvidence = new EvidenceV1(
            EvidenceSource.CatalogSnapshot, DataStatus.Available, probe.ObservedAt, null,
            "Static keyset-bounded catalog SELECT; parent objects were bounded before attached-index expansion.");

        return new DatabaseCityPageV1(
            "1.0",
            databaseId,
            database.Name,
            metric,
            pageSize,
            nextToken,
            null,
            schemaContracts,
            projected,
            [],
            new DatabaseCityWorkloadAggregateV1(null, null, null, null, null, null, workloadEvidence),
            [],
            pageEvidence);
    }

    private static DatabaseCityPageV1 UnavailablePage(
        DatabaseAtlasItemV1 database,
        DatabaseCityMetric metric,
        int pageSize,
        DataStatus status,
        string reason)
    {
        var evidence = new EvidenceV1(EvidenceSource.CatalogSnapshot, status, null, null, reason);
        return new DatabaseCityPageV1(
            "1.0", database.DatabaseId, database.Name, metric, pageSize, null, null,
            [], [], [], new DatabaseCityWorkloadAggregateV1(null, null, null, null, null, null, evidence),
            [], evidence);
    }

    private static DataStatus Status(ProbeExecutionException exception) => exception switch
    {
        ProbePermissionDeniedException => DataStatus.PermissionDenied,
        ProbeObjectUnavailableException or ProbeNotProbedException => DataStatus.Unsupported,
        ProbeTransientConnectionException or ProbeDatabaseUnavailableException or ProbeAuthenticationException =>
            DataStatus.Disconnected,
        _ => DataStatus.Unknown,
    };

    private static string ObjectId(string databaseId, int objectId) =>
        $"{databaseId}/object/{objectId.ToString(CultureInfo.InvariantCulture)}";

    private static string EncodeToken(
        string databaseId,
        DatabaseCityMetric metric,
        int pageSize,
        int afterObjectId,
        int layoutOffset)
    {
        var bytes = Encoding.UTF8.GetBytes(
            $"1|{databaseId}|{metric}|{pageSize.ToString(CultureInfo.InvariantCulture)}|{afterObjectId.ToString(CultureInfo.InvariantCulture)}|{layoutOffset.ToString(CultureInfo.InvariantCulture)}");
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static DatabaseCityCursor DecodeToken(
        string? token,
        string databaseId,
        DatabaseCityMetric metric,
        int pageSize)
    {
        if (token is null)
            return new DatabaseCityCursor(0, 0);
        if (token.Length is < 1 or > 1024 || token.Any(character =>
                !(char.IsAsciiLetterOrDigit(character) || character is '-' or '_')))
            throw new DatabaseCityPageTokenException();
        try
        {
            var base64 = token.Replace('-', '+').Replace('_', '/');
            base64 = base64.PadRight((base64.Length + 3) / 4 * 4, '=');
            var parts = Encoding.UTF8.GetString(Convert.FromBase64String(base64)).Split('|');
            if (parts.Length != 6 ||
                parts[0] != "1" ||
                parts[1] != databaseId ||
                parts[2] != metric.ToString() ||
                !int.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out var tokenPageSize) ||
                tokenPageSize != pageSize ||
                !int.TryParse(parts[4], NumberStyles.None, CultureInfo.InvariantCulture, out var afterObjectId) ||
                afterObjectId < 0 ||
                !int.TryParse(parts[5], NumberStyles.None, CultureInfo.InvariantCulture, out var layoutOffset) ||
                layoutOffset < 0)
                throw new DatabaseCityPageTokenException();
            return new DatabaseCityCursor(afterObjectId, layoutOffset);
        }
        catch (FormatException)
        {
            throw new DatabaseCityPageTokenException();
        }
        catch (DecoderFallbackException)
        {
            throw new DatabaseCityPageTokenException();
        }
    }

    private sealed record DatabaseCityCursor(int AfterObjectId, int LayoutOffset);
}
