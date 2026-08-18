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
    public async Task PropagatesCallerCancellationBeforeReading()
    {
        var source = new ConnectedDatabaseCitySource(new FakeAtlasSource(), new FakeCityProbeExecutor());
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => source.GetDatabaseAsync(
            "target/database/sales", DatabaseCityMetric.Cpu, 1, null,
            new CancellationToken(canceled: true)));
    }

    private sealed class FakeCityProbeExecutor : IDatabaseCityProbeExecutor
    {
        public Task<DatabaseCityProbePage> CollectPageAsync(
            string databaseName,
            int afterObjectId,
            int topN,
            CancellationToken cancellationToken)
        {
            Assert.Equal("sales", databaseName);
            Assert.Equal(0, afterObjectId);
            Assert.Equal(2, topN);
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
