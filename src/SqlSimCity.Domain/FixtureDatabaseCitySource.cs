using System.Globalization;
using System.Numerics;
using System.Text;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Domain;

public sealed class FixtureDatabaseCitySource : IDatabaseCitySource
{
    private const string SalesDatabaseId = "fixture-target-primary/database/sales";
    private const int QueryFamilyTopCount = 12;
    private static readonly DateTimeOffset CapturedAt = new(2026, 8, 17, 17, 0, 0, TimeSpan.Zero);
    private static readonly EvidenceV1 FixtureEvidence = new(
        EvidenceSource.Fixture, DataStatus.Available, CapturedAt, CapturedAt.AddHours(1),
        "Sanitized deterministic database-city fixture evidence.");
    private static readonly EvidenceV1 DirectEvidence = new(
        EvidenceSource.LiveDmvCumulative, DataStatus.Available, CapturedAt, CapturedAt.AddMinutes(5),
        "Direct cumulative index usage DMV counters; values share reset epoch fixture-epoch-1.");
    private static readonly EvidenceV1 AttributedEvidence = new(
        EvidenceSource.QueryStoreAggregate, DataStatus.Available, CapturedAt, null,
        "Query Store aggregate exposure attributed only where normalized compiled-plan evidence names the object.");
    private static readonly IReadOnlyList<DatabaseCitySchemaEvidence> SalesSchemas =
    [
        new("schema:dbo", "dbo"),
        new("schema:reporting", "reporting"),
        new("schema:zarchive", "archive"),
    ];
    private static readonly IReadOnlyList<DatabaseCityObjectV1> SalesObjects =
        DatabaseCityProjector.ProjectObjects(SalesSchemas, BuildObjects());
    private static readonly IReadOnlyList<DatabaseCityQueryEvidence> SalesQueries = BuildQueries();
    private static readonly IReadOnlyList<DatabaseCitySummaryV1> Summaries = BuildSummaries();

    public ValueTask<DatabaseCitySummarySnapshotV1> GetSummariesAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return ValueTask.FromResult(new DatabaseCitySummarySnapshotV1("1.0", CapturedAt, Summaries));
    }

    public Task<DatabaseCityPageV1?> GetDatabaseAsync(
        string databaseId,
        DatabaseCityMetric metric,
        int pageSize,
        string? pageToken,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentException.ThrowIfNullOrWhiteSpace(databaseId);
        if (pageSize is < 1 or > 50)
            throw new ArgumentOutOfRangeException(nameof(pageSize));

        var summary = Summaries.SingleOrDefault(item =>
            item.DatabaseId.Equals(databaseId, StringComparison.Ordinal));
        if (summary is null)
            return Task.FromResult<DatabaseCityPageV1?>(null);

        var offset = DecodeToken(pageToken, databaseId, metric, pageSize);
        if (!databaseId.Equals(SalesDatabaseId, StringComparison.Ordinal))
        {
            if (offset != 0)
                throw new DatabaseCityPageTokenException();
            return Task.FromResult<DatabaseCityPageV1?>(UnavailablePage(summary, metric, pageSize));
        }

        if (offset > SalesObjects.Count)
            throw new DatabaseCityPageTokenException();
        var objects = SalesObjects.Skip(offset).Take(pageSize).ToArray();
        var nextOffset = offset + objects.Length;
        var nextPageToken = nextOffset < SalesObjects.Count
            ? EncodeToken(databaseId, metric, pageSize, nextOffset)
            : null;
        var workload = DatabaseCityProjector.ProjectWorkload(
            SalesQueries, metric, QueryFamilyTopCount, cancellationToken);
        var topFamilies = workload.Top.Select(ToContract).ToArray();
        var schemaContracts = SalesSchemas
            .OrderBy(schema => schema.SchemaId, StringComparer.Ordinal)
            .Select((schema, index) => new DatabaseCitySchemaV1(
                schema.SchemaId,
                schema.Name,
                index,
                SalesObjects.Count(item => item.SchemaId == schema.SchemaId).ToString(CultureInfo.InvariantCulture),
                FixtureEvidence))
            .ToArray();

        return Task.FromResult<DatabaseCityPageV1?>(new DatabaseCityPageV1(
            "1.0",
            databaseId,
            summary.Name,
            metric,
            pageSize,
            nextPageToken,
            SalesObjects.Count.ToString(CultureInfo.InvariantCulture),
            schemaContracts,
            objects,
            topFamilies,
            workload.Other,
            BuildRoutes(),
            FixtureEvidence));
    }

    private static DatabaseCityPageV1 UnavailablePage(
        DatabaseCitySummaryV1 summary,
        DatabaseCityMetric metric,
        int pageSize)
    {
        var evidence = summary.Evidence;
        var knownEmpty = evidence.Status == DataStatus.Available &&
                         summary.SchemaCount == "0" &&
                         summary.ObjectCount == "0";
        var other = new DatabaseCityWorkloadAggregateV1(
            knownEmpty ? "0" : null,
            knownEmpty ? "0" : null,
            knownEmpty ? "0" : null,
            knownEmpty ? "0" : null,
            knownEmpty ? "0" : null,
            knownEmpty ? "0" : null,
            evidence);
        return new DatabaseCityPageV1(
            "1.0", summary.DatabaseId, summary.Name, metric, pageSize, null,
            knownEmpty ? "0" : null,
            [], [], [], other, [], evidence);
    }

    private static IReadOnlyList<DatabaseCityObjectEvidence> BuildObjects()
    {
        var customerId = "object:dbo:100";
        var orderId = "object:dbo:110";
        var rollupId = "object:reporting:300";
        return
        [
            new DatabaseCityObjectEvidence(
                customerId, "schema:dbo", "Customer", DatabaseObjectKind.Table,
                "65536", "49152",
                [
                    Index(customerId, 1, "PK_Customer", DatabaseIndexKind.Clustered, "9512"),
                    Index(customerId, 2, "IX_Customer_Email", DatabaseIndexKind.Nonclustered, "2041"),
                ],
                ["qf:sales-orders", "family:sales:004"])
            {
                DirectActivity = Direct("11553"),
                AttributedExposure = Exposure("2276", "14089536", "25779084", "625203",
                    QueryAttributionConfidence.Confirmed,
                    "Only normalized single-database plans that name dbo.Customer contribute; multi-object plans are excluded."),
            },
            new DatabaseCityObjectEvidence(
                orderId, "schema:dbo", "OrderHeader", DatabaseObjectKind.Table,
                "131072", "98304",
                [
                    Index(orderId, 1, "PK_OrderHeader", DatabaseIndexKind.Clustered, "24001"),
                    Index(orderId, 3, "IX_OrderHeader_Status", DatabaseIndexKind.Nonclustered, "8800"),
                ],
                ["family:sales:002", "family:sales:005"])
            {
                DirectActivity = Direct("32801"),
                AttributedExposure = Exposure("2525", "25000075", "45000175", "1300325",
                    QueryAttributionConfidence.Confirmed,
                    "Only normalized single-object plan references to dbo.OrderHeader contribute."),
            },
            new DatabaseCityObjectEvidence(
                rollupId, "schema:reporting", "SalesRollup", DatabaseObjectKind.IndexedView,
                "8192", "8100",
                [
                    Index(rollupId, 1, "CIX_SalesRollup", DatabaseIndexKind.Clustered, "144"),
                ],
                ["family:sales:003"])
            {
                DirectActivity = Direct("144"),
                AttributedExposure = Exposure("1313", "13000039", "23400091", "676169",
                    QueryAttributionConfidence.Probable,
                    "A normalized plan names the indexed view; optimizer expansion remains a caveat."),
            },
            new DatabaseCityObjectEvidence(
                "object:zarchive:900", "schema:zarchive", "ColdLedger", DatabaseObjectKind.Table,
                null, null, [], [])
            {
                SizeReason = "The fixture principal was denied object space metadata.",
                DirectActivity = new DatabaseCityDirectActivityV1(
                    null, "fixture-epoch-1",
                    new EvidenceV1(EvidenceSource.LiveDmvCumulative, DataStatus.PermissionDenied,
                        CapturedAt, CapturedAt.AddMinutes(5), "Index usage DMV access was denied.")),
            },
        ];
    }

    private static List<DatabaseCityQueryEvidence> BuildQueries()
    {
        var rows = new List<DatabaseCityQueryEvidence>();
        for (var index = 1; index <= 15; index++)
        {
            var objectIds = index switch
            {
                1 or 4 => new[] { "object:dbo:100" },
                2 or 5 => new[] { "object:dbo:110" },
                3 => new[] { "object:reporting:300" },
                6 => new[] { "object:dbo:100", "object:dbo:110" },
                7 => new[] { "object:dbo:110", "fixture-target-primary/database/warehouse" },
                _ => Array.Empty<string>(),
            };
            var confidence = objectIds.Length switch
            {
                1 => QueryAttributionConfidence.Confirmed,
                > 1 => QueryAttributionConfidence.Probable,
                _ => QueryAttributionConfidence.Unknown,
            };
            var rationale = objectIds.Length switch
            {
                1 => "A normalized compiled plan names exactly one local object.",
                > 1 => "A normalized plan names multiple objects; totals remain query-level and are not copied onto each object.",
                _ => "No normalized object reference was available; workload remains unattributed.",
            };
            var weight = 16 - index;
            if (index == 1)
            {
                rows.Add(new DatabaseCityQueryEvidence(
                    "qf:sales-orders",
                    "0x94A001",
                    "1064",
                    "2089500",
                    "4179000",
                    "1047",
                    "287",
                    objectIds,
                    confidence,
                    rationale));
                continue;
            }
            if (index >= 13)
            {
                rows.Add(new DatabaseCityQueryEvidence(
                    $"family:sales:{index:D3}",
                    $"0xFAKE{index:D4}",
                    ((16 - index) * 10).ToString(CultureInfo.InvariantCulture),
                    ((16 - index) * 100).ToString(CultureInfo.InvariantCulture),
                    ((16 - index) * 200).ToString(CultureInfo.InvariantCulture),
                    ((16 - index) * 10).ToString(CultureInfo.InvariantCulture),
                    (16 - index).ToString(CultureInfo.InvariantCulture),
                    objectIds,
                    confidence,
                    rationale));
                continue;
            }
            rows.Add(new DatabaseCityQueryEvidence(
                $"family:sales:{index:D3}",
                $"0xFAKE{index:D4}",
                (weight * 101).ToString(CultureInfo.InvariantCulture),
                (weight * 1_000_003L).ToString(CultureInfo.InvariantCulture),
                (weight * 1_800_007L).ToString(CultureInfo.InvariantCulture),
                (weight * 52_013L).ToString(CultureInfo.InvariantCulture),
                (weight * 1_009L).ToString(CultureInfo.InvariantCulture),
                objectIds,
                confidence,
                rationale));
        }
        return rows;
    }

    private static DatabaseCityQueryFamilyV1 ToContract(DatabaseCityQueryEvidence family) => new(
        family.FamilyId,
        family.QueryHash,
        family.ExecutionCount,
        family.TotalCpuMicroseconds,
        family.TotalDurationMicroseconds,
        family.TotalLogicalReads8KiBPages,
        family.TotalWaitMilliseconds,
        family.ObjectIds,
        family.Confidence,
        family.Rationale,
        AttributedEvidence);

    private static DatabaseCityIndexV1 Index(
        string objectId,
        int indexId,
        string name,
        DatabaseIndexKind kind,
        string operations) =>
        new($"{objectId}/index/{indexId}", name, kind, Direct(operations));

    private static DatabaseCityDirectActivityV1 Direct(string operations) =>
        new(operations, "fixture-epoch-1", DirectEvidence);

    private static DatabaseCityAttributedExposureV1 Exposure(
        string executions,
        string cpu,
        string duration,
        string reads,
        QueryAttributionConfidence confidence,
        string rationale) =>
        new(executions, cpu, duration, reads, confidence, rationale, AttributedEvidence);

    private static IReadOnlyList<DatabaseCityRouteV1> BuildRoutes() =>
    [
        new("route:customer-orders", "object:dbo:110", "object:dbo:100",
            DatabaseCityRouteKind.ObjectReference, EdgeConfidence.Confirmed,
            "Normalized plan evidence references both local objects; this route identifies co-reference, not row flow.",
            new EvidenceV1(EvidenceSource.InferredTopology, DataStatus.Available,
                CapturedAt, null, "Confirmed normalized local object references.")),
        new("route:orders-warehouse", "object:dbo:110", "fixture-target-primary/database/warehouse",
            DatabaseCityRouteKind.CrossDatabaseReference, EdgeConfidence.Probable,
            "A three-part normalized plan reference names warehouse; direction and row flow are not established.",
            new EvidenceV1(EvidenceSource.InferredTopology, DataStatus.Stale,
                CapturedAt.AddHours(-2), CapturedAt.AddHours(-1), "Stale cross-database normalized plan evidence.")),
        new("route:rollup-ledger", "object:reporting:300", "fixture-target-primary/database/ledger",
            DatabaseCityRouteKind.CrossDatabaseReference, EdgeConfidence.Unknown,
            "A restricted plan mentions both identities but cannot establish a dependency or row flow.",
            new EvidenceV1(EvidenceSource.InferredTopology, DataStatus.Unknown,
                CapturedAt, null, "Restricted cross-database evidence.")),
    ];

    private static IReadOnlyList<DatabaseCitySummaryV1> BuildSummaries()
    {
        var available = FixtureEvidence;
        return
        [
            Summary("master", "master", "0", "0", "0", available),
            Summary("sales", "sales", "3", SalesObjects.Count.ToString(CultureInfo.InvariantCulture),
                null, new EvidenceV1(EvidenceSource.Fixture, DataStatus.Unknown, CapturedAt, CapturedAt.AddHours(1),
                    "At least one object has unknown size, so no exact database-city reserved-byte total is reported.")),
            Summary("ledger", "ledger", null, null, null,
                Unavailable(DataStatus.Stale, "Object metadata is stale and was withheld from this projection.")),
            Summary("warehouse", "warehouse", null, null, null,
                Unavailable(DataStatus.PermissionDenied, "Object catalog access was denied.")),
            Summary("telemetry", "telemetry", "0", "0", "0", available),
            Summary("archive", "archive", null, null, null,
                Unavailable(DataStatus.Unknown, "Object size evidence is unavailable.")),
            Summary("scratch", "scratch", null, null, null,
                Unavailable(DataStatus.Unsupported, "Database-city object probes are unsupported for this fixture database.")),
            Summary("crm", "crm", null, null, null,
                Unavailable(DataStatus.Disconnected, "The database was disconnected during object collection.")),
        ];
    }

    private static DatabaseCitySummaryV1 Summary(
        string id,
        string name,
        string? schemas,
        string? objects,
        string? reservedBytes,
        EvidenceV1 evidence) =>
        new($"fixture-target-primary/database/{id}", name, schemas, objects, reservedBytes,
            reservedBytes is null ? MeasurementStatus.Unknown : MeasurementStatus.Known, evidence);

    private static EvidenceV1 Unavailable(DataStatus status, string reason) =>
        new(EvidenceSource.Fixture, status, CapturedAt, CapturedAt.AddMinutes(-1), reason);

    private static string EncodeToken(
        string databaseId,
        DatabaseCityMetric metric,
        int pageSize,
        int offset)
    {
        var bytes = Encoding.UTF8.GetBytes(
            $"1|{databaseId}|{metric}|{pageSize.ToString(CultureInfo.InvariantCulture)}|{offset.ToString(CultureInfo.InvariantCulture)}");
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static int DecodeToken(
        string? token,
        string databaseId,
        DatabaseCityMetric metric,
        int pageSize)
    {
        if (token is null)
            return 0;
        if (token.Length is < 1 or > 1024 || token.Any(character =>
                !(char.IsAsciiLetterOrDigit(character) || character is '-' or '_')))
            throw new DatabaseCityPageTokenException();
        try
        {
            var base64 = token.Replace('-', '+').Replace('_', '/');
            base64 = base64.PadRight((base64.Length + 3) / 4 * 4, '=');
            var parts = Encoding.UTF8.GetString(Convert.FromBase64String(base64)).Split('|');
            if (parts.Length != 5 ||
                parts[0] != "1" ||
                parts[1] != databaseId ||
                parts[2] != metric.ToString() ||
                !int.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out var tokenPageSize) ||
                tokenPageSize != pageSize ||
                !int.TryParse(parts[4], NumberStyles.None, CultureInfo.InvariantCulture, out var offset) ||
                offset < 0)
                throw new DatabaseCityPageTokenException();
            return offset;
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
}
