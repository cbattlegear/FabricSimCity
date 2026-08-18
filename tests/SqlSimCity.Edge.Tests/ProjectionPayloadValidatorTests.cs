using System.Text;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Edge.Envelope;
using SqlSimCity.Edge.Ingestion;

namespace SqlSimCity.Edge.Tests;

public sealed class ProjectionPayloadValidatorTests
{
    [Fact]
    public void NullRequiredQueryStatusIsRejected()
    {
        var payloads = ValidPayloads();
        payloads[ObservationSection.QueryStore] =
            Encoding.UTF8.GetBytes("""{"status":null,"families":[],"plans":[]}""");

        Assert.Equal(
            "Projection section is not a valid standard payload.",
            EdgeProjectionPayloadValidator.Validate(Generation(payloads)));
    }

    [Fact]
    public void NullArrayElementIsRejected()
    {
        var payloads = ValidPayloads();
        payloads[ObservationSection.QueryStore] = Encoding.UTF8.GetBytes(
            """{"status":{"schemaVersion":"1.0","state":"Ready","sequence":1,"lastStartedAt":null,"lastPublishedAt":null,"nextAttemptAt":null,"databases":[],"reason":"test"},"families":[null],"plans":[]}""");

        Assert.Equal(
            "Projection section is not a valid standard payload.",
            EdgeProjectionPayloadValidator.Validate(Generation(payloads)));
    }

    private static PublishedEdgeGeneration Generation(
        IReadOnlyDictionary<ObservationSection, byte[]> payloads) =>
        new(
            "target",
            "connector",
            1,
            "epoch",
            "boot",
            DateTimeOffset.UnixEpoch,
            1,
            payloads.ToDictionary(
                pair => pair.Key,
                pair => new SectionGeneration(
                    pair.Key,
                    1,
                    "epoch",
                    "boot",
                    DateTimeOffset.UnixEpoch,
                    new ObservationFreshnessV1(
                        DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, null),
                    1,
                    pair.Value)));

    private static Dictionary<ObservationSection, byte[]> ValidPayloads() => new()
    {
        [ObservationSection.Atlas] = Json(new AtlasObservationV1(
            new AtlasSnapshotV1(
                "1.0", "snapshot", new AtlasTargetV1("target", "Target", "SQL Server"),
                DateTimeOffset.UnixEpoch, [], []),
            new AtlasCollectorStatusV1(
                AtlasCollectorMode.Edge, AtlasCollectorState.Ready, 1,
                DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, null, false,
                0, 0, 0, 0, 0, null, "test"))),
        [ObservationSection.Capabilities] = Json(
            new CapabilitiesSnapshotV1("1", DateTimeOffset.UnixEpoch, [])),
        [ObservationSection.QueryStore] = Json(new QueryStoreObservationV1(
            new QueryStoreCollectorStatusV1(
                "1.0", QueryStoreCollectorState.Ready, 1, null, null, null, [], "test"),
            [],
            [])),
        [ObservationSection.DatabaseCity] = Json(new DatabaseCityObservationV1(
            new DatabaseCitySummarySnapshotV1("1.0", DateTimeOffset.UnixEpoch, []), [])),
        [ObservationSection.Live] = Json(new LiveIncidentResponseV1(
            null,
            new LiveCollectorStatusV1(
                SamplerRunState.Stopped, 0, null, null, 0, null, "test", 0, 0))),
    };

    private static byte[] Json<T>(T value) => EdgeJson.SerializeToUtf8Bytes(value);
}
