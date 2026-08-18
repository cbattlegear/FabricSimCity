using System.Net;
using System.Net.Http.Json;
using System.Globalization;
using System.Numerics;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using SqlSimCity.Api;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Api.Tests;

public sealed class DatabaseCityTests : IClassFixture<WebApplicationFactory<ApiAssemblyMarker>>
{
    private readonly HttpClient _client;

    public DatabaseCityTests(WebApplicationFactory<ApiAssemblyMarker> factory)
    {
        _client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
    }

    [Fact]
    public async Task SummaryAndDetailEndpointsAreVersionedBoundedAndExact()
    {
        using var summaries = await _client.GetAsync("/api/v1/database-city");
        using var detail = await _client.GetAsync(
            "/api/v1/database-city/fixture-target-primary%2Fdatabase%2Fsales?metric=cpu&pageSize=2");
        using var document = JsonDocument.Parse(await detail.Content.ReadAsStringAsync());

        Assert.Equal(HttpStatusCode.OK, summaries.StatusCode);
        Assert.Equal(HttpStatusCode.OK, detail.StatusCode);
        Assert.Equal("1.0", document.RootElement.GetProperty("schemaVersion").GetString());
        Assert.Equal(2, document.RootElement.GetProperty("objects").GetArrayLength());
        Assert.True(document.RootElement.GetProperty("topQueryFamilies").GetArrayLength() <= 12);
        Assert.Equal(JsonValueKind.String,
            document.RootElement.GetProperty("objects")[0].GetProperty("reservedBytes").ValueKind);
        Assert.Equal(JsonValueKind.String,
            document.RootElement.GetProperty("otherWorkload").GetProperty("totalCpuMicroseconds").ValueKind);
        Assert.Equal("no-store", detail.Headers.CacheControl?.ToString());
    }

    [Theory]
    [InlineData("/api/v1/database-city/not%20valid?metric=cpu&pageSize=10")]
    [InlineData("/api/v1/database-city/fixture-target-primary%2Fdatabase%2Fsales?metric=decoration&pageSize=10")]
    [InlineData("/api/v1/database-city/fixture-target-primary%2Fdatabase%2Fsales?metric=cpu&pageSize=0")]
    [InlineData("/api/v1/database-city/fixture-target-primary%2Fdatabase%2Fsales?metric=cpu&pageSize=51")]
    [InlineData("/api/v1/database-city/fixture-target-primary%2Fdatabase%2Fsales?metric=cpu&pageToken=not-base64")]
    public async Task DetailEndpointRejectsInvalidInputs(string path)
    {
        using var response = await _client.GetAsync(path);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task EscapedCanonicalDatabaseIdIsValidEvenWhenItDoesNotExist()
    {
        using var response = await _client.GetAsync(
            "/api/v1/database-city/fixture-target-primary%2Fdatabase%2FSales%2520West?metric=cpu&pageSize=10");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(
            "target/database/Sales%2FWest",
            DatabaseCityEndpoints.NormalizeDatabaseIdForRoute(
                "target%2Fdatabase%2FSales%2FWest"));
        Assert.True(DatabaseCityEndpoints.IsValidDatabaseId(
            $"target/database/{string.Concat(Enumerable.Repeat("%E8%A1%97", 128))}..~"));
    }

    [Fact]
    public async Task UnavailableFixtureDatabaseDoesNotReportMeasuredZero()
    {
        using var response = await _client.GetAsync(
            "/api/v1/database-city/fixture-target-primary%2Fdatabase%2Fledger?metric=cpu&pageSize=10");
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(JsonValueKind.Null, document.RootElement.GetProperty("totalObjects").ValueKind);
        Assert.Equal(JsonValueKind.Null,
            document.RootElement.GetProperty("otherWorkload").GetProperty("familyCount").ValueKind);
        Assert.Equal(JsonValueKind.Null,
            document.RootElement.GetProperty("otherWorkload").GetProperty("totalCpuMicroseconds").ValueKind);
    }

    [Fact]
    public async Task KnownEmptyFixtureDatabasePreservesMeasuredZero()
    {
        using var response = await _client.GetAsync(
            "/api/v1/database-city/fixture-target-primary%2Fdatabase%2Fmaster?metric=cpu&pageSize=10");
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("0", document.RootElement.GetProperty("totalObjects").GetString());
        Assert.Equal("0", document.RootElement.GetProperty("otherWorkload").GetProperty("familyCount").GetString());
        Assert.Equal("0",
            document.RootElement.GetProperty("otherWorkload").GetProperty("totalCpuMicroseconds").GetString());
    }

    [Fact]
    public void ProjectorIsSourceOrderInvariantAndPreservesUnknownAndZero()
    {
        var schema = new DatabaseCitySchemaEvidence("schema:dbo", "dbo");
        var objects = new[]
        {
            new DatabaseCityObjectEvidence("object:b", "schema:dbo", "B", DatabaseObjectKind.Table, "0", "0", [], []),
            new DatabaseCityObjectEvidence("object:a", "schema:dbo", "A", DatabaseObjectKind.IndexedView, null, null, [], []),
        };

        var forward = DatabaseCityProjector.ProjectObjects([schema], objects);
        var reverse = DatabaseCityProjector.ProjectObjects([schema], objects.Reverse());

        Assert.Equal(forward, reverse);
        Assert.Equal(MeasurementStatus.Unknown, forward[0].SizeStatus);
        Assert.Null(forward[0].ReservedBytes);
        Assert.Equal(MeasurementStatus.Known, forward[1].SizeStatus);
        Assert.Equal("0", forward[1].ReservedBytes);
    }

    [Fact]
    public void ProjectorConvertsEightKibPagesWithoutPrecisionLoss()
    {
        const string pages = "9007199254740993";
        var projected = DatabaseCityProjector.ProjectObjects(
            [new DatabaseCitySchemaEvidence("schema:dbo", "dbo")],
            [new DatabaseCityObjectEvidence(
                "object:large", "schema:dbo", "Large", DatabaseObjectKind.Table, pages, pages, [], [])]);

        Assert.Equal((BigInteger.Parse(pages, CultureInfo.InvariantCulture) * 8192)
            .ToString(CultureInfo.InvariantCulture), projected[0].ReservedBytes);
        Assert.Equal((BigInteger.Parse(pages, CultureInfo.InvariantCulture) * 8192)
            .ToString(CultureInfo.InvariantCulture), projected[0].UsedBytes);
    }

    [Fact]
    public void ProjectorDoesNotOverlapLargeNeighborhoods()
    {
        var objects = Enumerable.Range(1, 800)
            .Select(index => new DatabaseCityObjectEvidence(
                $"object:{index:D4}", "schema:dbo", $"Object{index:D4}",
                DatabaseObjectKind.Table, "1", "1", [], [])
            {
                LayoutOrdinal = index,
            });

        var projected = DatabaseCityProjector.ProjectObjects(
            [new DatabaseCitySchemaEvidence("schema:dbo", "dbo", 1)], objects);

        Assert.Equal(projected.Count, projected.Select(item => (item.Layout.X, item.Layout.Z)).Distinct().Count());
    }

    [Fact]
    public void WorkloadProjectionBoundsOneHundredThousandFamiliesAndAggregatesOther()
    {
        var families = Enumerable.Range(1, 100_000)
            .Select(index => new DatabaseCityQueryEvidence(
                $"family:{index:D6}", $"hash:{index:D6}",
                index.ToString(CultureInfo.InvariantCulture), index.ToString(CultureInfo.InvariantCulture),
                index.ToString(CultureInfo.InvariantCulture), index.ToString(CultureInfo.InvariantCulture),
                index.ToString(CultureInfo.InvariantCulture), [], QueryAttributionConfidence.Confirmed,
                "A normalized plan names one object."));

        var projected = DatabaseCityProjector.ProjectWorkload(families, DatabaseCityMetric.Cpu, 12);
        var expectedOtherCpu = Enumerable.Range(1, 100_000 - 12)
            .Select(index => new BigInteger(index))
            .Aggregate(BigInteger.Zero, (sum, value) => sum + value);

        Assert.Equal(12, projected.Top.Count);
        Assert.Equal("99988", projected.Other.FamilyCount);
        Assert.Equal(expectedOtherCpu.ToString(CultureInfo.InvariantCulture), projected.Other.TotalCpuMicroseconds);
    }

    [Fact]
    public async Task FixtureSourceSeparatesDirectAndAttributedEvidenceAndHonorsCancellation()
    {
        var source = new FixtureDatabaseCitySource();
        var page = await source.GetDatabaseAsync(
            "fixture-target-primary/database/sales", DatabaseCityMetric.Cpu, 20, null, CancellationToken.None);
        var customer = page!.Objects.Single(item => item.Name == "Customer");
        var expectedCustomerCpu = page.TopQueryFamilies
            .Where(family => family.ObjectIds.Count == 1 && family.ObjectIds[0] == customer.ObjectId)
            .Aggregate(BigInteger.Zero, (sum, family) =>
                sum + BigInteger.Parse(family.TotalCpuMicroseconds, CultureInfo.InvariantCulture));
        var linkedCityFamily = page.TopQueryFamilies.Single(family => family.FamilyId == "qf:sales-orders");
        var linkedQueryStoreFamily = await new FixtureQueryStoreHistorySource()
            .GetFamilyAsync("qf:sales-orders", CancellationToken.None);

        Assert.Equal(EvidenceSource.LiveDmvCumulative, customer.DirectActivity.Evidence.Source);
        Assert.Equal(EvidenceSource.QueryStoreAggregate, customer.AttributedExposure.Evidence.Source);
        Assert.Equal(expectedCustomerCpu.ToString(CultureInfo.InvariantCulture),
            customer.AttributedExposure.TotalCpuMicroseconds);
        Assert.NotNull(linkedQueryStoreFamily);
        Assert.Equal(linkedQueryStoreFamily.Family.QueryHash, linkedCityFamily.QueryHash);
        Assert.Equal(linkedQueryStoreFamily.Family.ExecutionCount, linkedCityFamily.ExecutionCount);
        Assert.Equal(linkedQueryStoreFamily.Family.TotalCpuMicroseconds, linkedCityFamily.TotalCpuMicroseconds);
        Assert.Equal(linkedQueryStoreFamily.Family.TotalLogicalReads8KiBPages,
            linkedCityFamily.TotalLogicalReads8KiBPages);
        Assert.Contains(customer.Indexes, index => index.DirectActivity.TotalOperations != "0");
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => source.GetDatabaseAsync(
            page.DatabaseId, DatabaseCityMetric.Cpu, 20, null, new CancellationToken(canceled: true)));
    }

    [Fact]
    public async Task FixtureSourceExposesWaitCategoriesThatReconcileWithTotalWait()
    {
        var source = new FixtureDatabaseCitySource();
        var page = await source.GetDatabaseAsync(
            "fixture-target-primary/database/sales", DatabaseCityMetric.Cpu, 20, null, CancellationToken.None);

        var measured = page!.TopQueryFamilies
            .Where(family => family.WaitMillisecondsByCategory.Count > 0)
            .ToList();

        Assert.NotEmpty(measured);
        foreach (var family in measured)
        {
            // A breakdown that does not reconcile with the total would claim waits the engine never
            // reported, so the fixture must never ship one.
            var breakdown = family.WaitMillisecondsByCategory.Values.Aggregate(
                BigInteger.Zero, (sum, value) => sum + BigInteger.Parse(value, CultureInfo.InvariantCulture));
            Assert.Equal(family.TotalWaitMilliseconds, breakdown.ToString(CultureInfo.InvariantCulture));
        }

        // Families without the breakdown are kept, not dropped: absent categories are not zero waits.
        Assert.Contains(page.TopQueryFamilies, family =>
            family.WaitMillisecondsByCategory.Count == 0 && family.TotalWaitMilliseconds != "0");
    }

    [Fact]
    public async Task FixtureSourceRejectsTokensAcrossMetrics()
    {
        var source = new FixtureDatabaseCitySource();
        var first = await source.GetDatabaseAsync(
            "fixture-target-primary/database/sales", DatabaseCityMetric.Cpu, 1, null, CancellationToken.None);

        await Assert.ThrowsAsync<DatabaseCityPageTokenException>(() => source.GetDatabaseAsync(
            first!.DatabaseId, DatabaseCityMetric.Reads, 1, first.NextPageToken, CancellationToken.None));
    }
}
