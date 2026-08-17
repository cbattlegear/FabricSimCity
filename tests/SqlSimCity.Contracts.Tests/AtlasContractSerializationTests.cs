using System.Text.Json;
using System.Text.Json.Serialization;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Contracts.Tests;

public sealed class AtlasContractSerializationTests
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

    [Fact]
    public void ZeroAndUnknownMeasurementsRemainDistinct()
    {
        var evidence = new EvidenceV1(EvidenceSource.Fixture, DataStatus.Available,
            DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch.AddMinutes(1), "fixture");
        var measurements = new[]
        {
            new ByteMeasurementV1("0", MeasurementStatus.Known, null, evidence),
            new ByteMeasurementV1(null, MeasurementStatus.Unknown, "not visible",
                evidence with { Status = DataStatus.Unknown, Reason = "not visible" }),
        };

        var json = JsonSerializer.Serialize(measurements, Options);
        using var document = JsonDocument.Parse(json);
        var first = document.RootElement[0];
        var second = document.RootElement[1];

        Assert.Equal("0", first.GetProperty("bytes").GetString());
        Assert.Equal("Known", first.GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, second.GetProperty("bytes").ValueKind);
        Assert.Equal("Unknown", second.GetProperty("status").GetString());
        Assert.Equal("not visible", second.GetProperty("reason").GetString());
    }

    [Fact]
    public void BytesAboveJavaScriptSafeIntegerRemainExact()
    {
        const string exactBytes = "9007199254740993";
        var evidence = new EvidenceV1(EvidenceSource.Fixture, DataStatus.Available,
            DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch.AddMinutes(1), "fixture");
        var measurement = new ByteMeasurementV1(exactBytes, MeasurementStatus.Known, null, evidence);

        var json = JsonSerializer.Serialize(measurement, Options);
        using var document = JsonDocument.Parse(json);

        Assert.Equal(JsonValueKind.String, document.RootElement.GetProperty("bytes").ValueKind);
        Assert.Equal(exactBytes, document.RootElement.GetProperty("bytes").GetString());
    }

    [Fact]
    public void EvidenceSerializesSourceStatusAndTimestampsSeparately()
    {
        var evidence = new EvidenceV1(EvidenceSource.QueryStoreAggregate, DataStatus.PermissionDenied,
            null, null, "VIEW DATABASE STATE is unavailable");

        var json = JsonSerializer.Serialize(evidence, Options);

        Assert.Contains("\"source\":\"QueryStoreAggregate\"", json, StringComparison.Ordinal);
        Assert.Contains("\"status\":\"PermissionDenied\"", json, StringComparison.Ordinal);
        Assert.Contains("\"reason\":\"VIEW DATABASE STATE is unavailable\"", json, StringComparison.Ordinal);
        Assert.Contains("\"observedAt\":null", json, StringComparison.Ordinal);
    }
}
