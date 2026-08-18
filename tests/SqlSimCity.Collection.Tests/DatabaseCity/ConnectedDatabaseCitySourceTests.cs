using SqlSimCity.Collection.DatabaseCity;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Collection.Tests.DatabaseCity;

public sealed class ConnectedDatabaseCitySourceTests
{
    [Fact]
    public async Task PagesParentsBeforeIndexExpansionAndSeparatesEvidence()
    {
        var source = new ConnectedDatabaseCitySource(new FakeAtlasSource(), new FakeCityProbeExecutor());

        var page = await source.GetDatabaseAsync(
            "target/database/sales", DatabaseCityMetric.Cpu, 1, null, CancellationToken.None);

        Assert.NotNull(page);
        var item = Assert.Single(page.Objects);
        Assert.Equal("81920", item.ReservedBytes);
        Assert.Equal("40960", item.UsedBytes);
        Assert.Equal("5", item.DirectActivity.TotalOperations);
        Assert.Equal(EvidenceSource.LiveDmvCumulative, item.DirectActivity.Evidence.Source);
        Assert.Equal(EvidenceSource.NotProbed, item.AttributedExposure.Evidence.Source);
        Assert.Null(item.DirectActivity.ResetEpochToken);
        Assert.All(item.Indexes, index => Assert.Null(index.DirectActivity.ResetEpochToken));
        Assert.Single(item.Indexes);
        Assert.NotNull(page.NextPageToken);
        Assert.Null(page.OtherWorkload.TotalCpuMicroseconds);
        Assert.Equal("1", Assert.Single(page.Schemas).ObjectCount);
    }

    [Fact]
    public async Task SummaryDoesNotClaimAtlasAllocationAsObjectReservedBytes()
    {
        var source = new ConnectedDatabaseCitySource(new FakeAtlasSource(), new FakeCityProbeExecutor());

        var summaries = await source.GetSummariesAsync(CancellationToken.None);

        Assert.Null(Assert.Single(summaries.Databases).ReservedBytes);
    }

    [Fact]
    public async Task IndexlessParentRemainsUnknownAndDoesNotEndPaging()
    {
        var source = new ConnectedDatabaseCitySource(new FakeAtlasSource(), new IndexlessCityProbeExecutor());

        var page = await source.GetDatabaseAsync(
            "target/database/sales", DatabaseCityMetric.Cpu, 1, null, CancellationToken.None);

        var item = Assert.Single(page!.Objects);
        Assert.Equal("target/database/sales/object/10", item.ObjectId);
        Assert.Equal(MeasurementStatus.Unknown, item.SizeStatus);
        Assert.Empty(item.Indexes);
        Assert.NotNull(page.NextPageToken);
    }

    [Fact]
    public async Task PropagatesCallerCancellationBeforeReading()
    {
        var source = new ConnectedDatabaseCitySource(new FakeAtlasSource(), new FakeCityProbeExecutor());
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => source.GetDatabaseAsync(
            "target/database/sales", DatabaseCityMetric.Cpu, 1, null,
            new CancellationToken(canceled: true)));
    }

    [Fact]
    public async Task QueryStoreFamiliesRoutesAndExposureReachTheConnectedPage()
    {
        var queryStore = new FakeQueryStore();
        queryStore.AddFamily("family-1", cpu: "900", executions: "30", plans:
            [FakeQueryStore.Plan("plan-1", FakeQueryStore.Reference(table: "Customer"))]);
        queryStore.AddFamily("family-2", cpu: "400", executions: "12", plans:
        [
            FakeQueryStore.Plan(
                "plan-2",
                FakeQueryStore.Reference(table: "Customer"),
                FakeQueryStore.Reference(table: "OrderHeader")),
        ]);

        var source = new ConnectedDatabaseCitySource(
            new FakeAtlasSource(),
            new FakeCityProbeExecutor(expectedTopN: 3),
            new QueryStoreCityAttribution(queryStore));

        var page = await source.GetDatabaseAsync(
            "target/database/sales", DatabaseCityMetric.Cpu, 2, null, CancellationToken.None);

        Assert.NotNull(page);
        Assert.Equal(["family-1", "family-2"], page!.TopQueryFamilies.Select(family => family.FamilyId));
        Assert.Equal("900", page.TopQueryFamilies[0].TotalCpuMicroseconds);

        var route = Assert.Single(page.Routes);
        Assert.Equal("target/database/sales/object/10", route.FromObjectId);
        Assert.Equal("target/database/sales/object/20", route.ToId);

        // family-1 named only the Customer table, so its totals attach to that building;
        // family-2 named two objects and is deliberately left at query level.
        var customer = page.Objects.Single(item => item.ObjectId == "target/database/sales/object/10");
        Assert.Equal("900", customer.AttributedExposure.TotalCpuMicroseconds);
        Assert.Equal(QueryAttributionConfidence.Confirmed, customer.AttributedExposure.Confidence);
        var orderHeader = page.Objects.Single(item => item.ObjectId == "target/database/sales/object/20");
        Assert.Null(orderHeader.AttributedExposure.TotalCpuMicroseconds);
        Assert.Equal(QueryAttributionConfidence.Unknown, orderHeader.AttributedExposure.Confidence);
        Assert.Contains(
            "not measured zero", orderHeader.AttributedExposure.Rationale, StringComparison.Ordinal);
    }

    /// <summary>
    /// Query Store history is collected per database name, while the city page is addressed by the
    /// atlas contract id. Filtering the join by the atlas id matches no published Query Store index,
    /// which silently reports every object on the page as having no attributed exposure.
    /// </summary>
    [Fact]
    public async Task QueryStoreIsFilteredByDatabaseNameNotTheAtlasDatabaseId()
    {
        var queryStore = new FakeQueryStore();
        queryStore.AddFamily("family-1", cpu: "900", executions: "30", plans:
            [FakeQueryStore.Plan("plan-1", FakeQueryStore.Reference(table: "Customer"))]);

        var source = new ConnectedDatabaseCitySource(
            new FakeAtlasSource(),
            new FakeCityProbeExecutor(expectedTopN: 3),
            new QueryStoreCityAttribution(queryStore));

        var page = await source.GetDatabaseAsync(
            "target/database/sales", DatabaseCityMetric.Cpu, 2, null, CancellationToken.None);

        Assert.Equal("sales", queryStore.RequestedDatabaseId);
        Assert.Equal(
            "900",
            page!.Objects.Single(item => item.ObjectId == "target/database/sales/object/10")
                .AttributedExposure.TotalCpuMicroseconds);
    }

    private sealed class FakeCityProbeExecutor(int expectedTopN = 2) : IDatabaseCityProbeExecutor
    {
        public Task<DatabaseCityProbePage> CollectPageAsync(
            string databaseName,
            int afterObjectId,
            int topN,
            CancellationToken cancellationToken)
        {
            Assert.Equal("sales", databaseName);
            Assert.Equal(0, afterObjectId);
            Assert.Equal(expectedTopN, topN);
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(new DatabaseCityProbePage(
                [
                    new DatabaseCityInventoryRow(
                        10, 1001, 2, "dbo", "Customer", DatabaseObjectKind.Table,
                        "10", "5", 1, "PK_Customer", DatabaseIndexKind.Clustered),
                    new DatabaseCityInventoryRow(
                        20, 1001, 2, "dbo", "OrderHeader", DatabaseObjectKind.Table,
                        "20", "10", 1, "PK_OrderHeader", DatabaseIndexKind.Clustered),
                ],
                [new DatabaseCityIndexUsageRow(10, 1, "5")],
                DataStatus.Available,
                "Direct cumulative index usage counters.",
                new DateTimeOffset(2026, 8, 17, 17, 0, 0, TimeSpan.Zero)));
        }
    }

    private sealed class IndexlessCityProbeExecutor : IDatabaseCityProbeExecutor
    {
        public Task<DatabaseCityProbePage> CollectPageAsync(
            string databaseName,
            int afterObjectId,
            int topN,
            CancellationToken cancellationToken) =>
            Task.FromResult(new DatabaseCityProbePage(
                [
                    new DatabaseCityInventoryRow(
                        10, 1001, 2, "dbo", "ExternalCustomer", DatabaseObjectKind.Table,
                        null, null, null, null, null),
                    new DatabaseCityInventoryRow(
                        20, 1001, 2, "dbo", "OrderHeader", DatabaseObjectKind.Table,
                        "20", "10", 1, "PK_OrderHeader", DatabaseIndexKind.Clustered),
                ],
                [],
                DataStatus.Available,
                "Direct cumulative index usage counters.",
                new DateTimeOffset(2026, 8, 17, 17, 0, 0, TimeSpan.Zero)));
    }

    private sealed class FakeAtlasSource : IAtlasSnapshotSource
    {
        public AtlasSnapshotV1 GetCurrent()
        {
            var now = new DateTimeOffset(2026, 8, 17, 17, 0, 0, TimeSpan.Zero);
            var evidence = new EvidenceV1(
                EvidenceSource.CatalogSnapshot, DataStatus.Available, now, null, "Fixture.");
            var allocated = new ByteMeasurementV1("163840", MeasurementStatus.Known, null, evidence);
            var used = new ByteMeasurementV1("81920", MeasurementStatus.Known, null, evidence);
            var queryStore = new QueryStoreHistoryV1(
                null, null, null, null, null, QueryStoreCapability.Unknown,
                QueryStoreHealth.Unknown, "Not collected.", evidence);
            var database = new DatabaseAtlasItemV1(
                "target/database/sales", "sales", allocated, used,
                new LiveActivityV1(null, null, null, null, evidence), queryStore)
            {
                FileIo = new FileIoV1(
                    null, null, null, null, null, "epoch:1", evidence),
            };
            return new AtlasSnapshotV1(
                "1.0", "snapshot:1", new AtlasTargetV1("target", "Target", "SQL Server"),
                now, [database], []);
        }
    }
}
