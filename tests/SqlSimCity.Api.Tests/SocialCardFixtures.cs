using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Api.Tests;

/// <summary>
/// Builds the contract values the social-card tests need, with everything irrelevant filled in once.
/// </summary>
/// <remarks>
/// The V1 contracts are wide positional records, deliberately, because a caller is meant to say what
/// every measurement's evidence is rather than let one default to silence. Nothing the card reads
/// depends on the other fields, so restating twenty of them per test would hide the two that matter.
/// </remarks>
internal static class SocialCardFixtures
{
    private static readonly EvidenceV1 NoEvidence =
        new(EvidenceSource.Fixture, DataStatus.Available, null, null, "test fixture");

    private static ByteMeasurementV1 Bytes(string? bytes) =>
        new(bytes, bytes is null ? MeasurementStatus.Unknown : MeasurementStatus.Known, null, NoEvidence);

    private static readonly LiveActivityV1 NoActivity = new(null, null, null, null, NoEvidence);

    private static readonly QueryStoreHistoryV1 NoHistory = new(
        null, null, null, null, null,
        QueryStoreCapability.Unknown, QueryStoreHealth.Unknown, "test fixture", NoEvidence);

    public static DatabaseAtlasItemV1 Database(string name, string? allocatedBytes) =>
        new($"primary/database/{name}", name, Bytes(allocatedBytes), Bytes(null), NoActivity, NoHistory);

    public static AtlasSnapshotV1 Atlas(params DatabaseAtlasItemV1[] databases) =>
        new("1.0", "snapshot", new AtlasTargetV1("target", "Target", "sqlserver"), DateTimeOffset.UnixEpoch, databases, []);

    public static DatabaseCityObjectV1 CityObject(string name, string? reservedBytes) =>
        new(
            $"dbo.{name}",
            "dbo",
            "dbo",
            name,
            DatabaseObjectKind.Table,
            null,
            null,
            reservedBytes,
            null,
            reservedBytes is null ? MeasurementStatus.Unknown : MeasurementStatus.Known,
            null,
            new DatabaseCityLayoutV1(0, 0, 0, 0),
            [],
            new DatabaseCityDirectActivityV1(null, null, NoEvidence),
            new DatabaseCityAttributedExposureV1(
                null, null, null, null, QueryAttributionConfidence.Unknown, "test fixture", NoEvidence));

    public static DatabaseCityPageV1 City(string name, string? totalObjects, params DatabaseCityObjectV1[] objects) =>
        new(
            "1.0",
            $"primary/database/{name}",
            name,
            DatabaseCityMetric.Cpu,
            50,
            null,
            totalObjects,
            [],
            objects,
            [],
            new DatabaseCityWorkloadAggregateV1(null, null, null, null, null, null, NoEvidence),
            [],
            NoEvidence);
}
