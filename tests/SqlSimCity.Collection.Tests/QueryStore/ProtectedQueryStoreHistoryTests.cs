using System.Numerics;
using System.Globalization;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Storage;

namespace SqlSimCity.Collection.Tests.QueryStore;

public sealed class ProtectedQueryStoreHistoryTests
{
    private static readonly DateTimeOffset Now = new(2026, 8, 17, 18, 0, 0, TimeSpan.Zero);
    private static readonly string[] SensitiveRecordKinds =
        ["query-store-query-text", "query-store-showplan"];

    [Fact]
    public async Task SnapshotPointerPublishesAtomically()
    {
        var store = new MemoryProtectedStore();
        var repository = new ProtectedQueryStoreRepository(store);
        var first = Snapshot("first", 1);
        await repository.PublishSnapshotAsync(first);
        store.ThrowRecordKind = "query-store-snapshot-pointer";

        await Assert.ThrowsAsync<IOException>(() =>
            repository.PublishSnapshotAsync(Snapshot("partial", 2)));
        store.ThrowRecordKind = null;

        var current = await repository.ReadPublishedSnapshotAsync();
        Assert.Equal("first", current?.SnapshotId);
        Assert.Contains(store.Records.Values, record => record.RecordKind == "query-store-published-snapshot");
    }

    [Fact]
    public async Task ActiveRuntimeIsReplacedAndVariantRollsIntoParentAcrossRestart()
    {
        var store = new MemoryProtectedStore();
        var repository = new ProtectedQueryStoreRepository(store);
        var tracker = new QueryStoreCollectionStatusTracker();
        await PublishCycleAsync(new ProtectedQueryStoreHistorySink(repository, tracker), 40);

        var restarted = new ProtectedQueryStoreHistorySink(repository, tracker);
        await PublishCycleAsync(restarted, 47);

        var snapshot = await repository.ReadPublishedSnapshotAsync();
        var family = Assert.Single(snapshot!.Families);
        Assert.Equal("47", family.Family.ExecutionCount);
        Assert.Equal(2, family.Family.PhysicalQueries.Count);
        Assert.Equal(2, family.Plans.Count);
        Assert.False(family.Plans.Single(plan => plan.PlanType == QueryPlanType.Dispatcher).RuntimeCounted);
        Assert.Single(family.Runtime);
        Assert.Equal("db:variant-plan", family.Runtime[0].PlanId);
    }

    [Fact]
    public async Task RawPayloadsUseOnlySensitiveProtectedRecordKinds()
    {
        var store = new MemoryProtectedStore();
        var repository = new ProtectedQueryStoreRepository(store);
        await repository.StoreQueryTextAsync("db", "text", Now, "private marker");
        await repository.StorePlanXmlAsync("db", "plan", Now, "<PrivatePlan marker='secret'/>");

        Assert.All(store.Records.Values, record =>
            Assert.Contains(record.RecordKind, SensitiveRecordKinds));
        Assert.Equal("private marker", await repository.ReadSensitiveTextAsync("query-text", "db", "text"));
        Assert.Equal("<PrivatePlan marker='secret'/>", await repository.ReadSensitiveTextAsync("showplan", "db", "plan"));
    }

    [Fact]
    public async Task LargeSnapshotsUseBoundedEncryptedFamilyChunks()
    {
        var store = new MemoryProtectedStore();
        var repository = new ProtectedQueryStoreRepository(store);
        var evidence = new QueryStoreEvidenceV1(
            QueryStoreSource.QueryStore, DataStatus.Available, Now, Now.AddMinutes(3), "ready", "aggregate");
        var largeText = new string('x', 300_000);
        var families = Enumerable.Range(0, 4).Select(index =>
        {
            var text = new QueryTextDescriptorV1(QueryTextAvailability.Available, largeText, $"fp-{index}", "safe");
            var physical = new PhysicalQueryIdentityV1(
                "db", $"q-{index}", $"t-{index}", $"h-{index}",
                new QueryContextSettingsV1("c", null, null, null, "160", null), text);
            var summary = new QueryFamilySummaryV1(
                $"f-{index}", "db", $"h-{index}", $"fp-{index}", text, [physical],
                "1", "1", "1", "1", "0", Now, Now, evidence);
            return new QueryFamilyDetailV1("1.0", summary, [], []);
        }).ToArray();

        await repository.PublishSnapshotAsync(Snapshot("chunked", 1) with { Families = families });
        var restored = await repository.ReadPublishedSnapshotAsync();

        Assert.Equal(4, restored!.Families.Count);
        Assert.Equal(4, store.Records.Values.Count(record =>
            record.RecordKind == "query-store-snapshot-families"));
        Assert.All(store.Records.Values, record => Assert.True(record.Payload.Length < 1_048_576));
    }

    [Fact]
    public async Task ResetEpochArchivesOldIdsWithoutMixingTheirRuntime()
    {
        var store = new MemoryProtectedStore();
        var repository = new ProtectedQueryStoreRepository(store);
        var sink = new ProtectedQueryStoreHistorySink(repository, new QueryStoreCollectionStatusTracker());
        await PublishCycleAsync(sink, 40, "epoch-1");
        await PublishCycleAsync(sink, 5, "epoch-2", reset: true);

        var snapshot = await repository.ReadPublishedSnapshotAsync();
        Assert.Equal(2, snapshot!.Families.Count);
        var archived = snapshot.Families.Single(detail =>
            detail.Family.FamilyId.Contains(":epoch:", StringComparison.Ordinal));
        var current = snapshot.Families.Single(detail =>
            !detail.Family.FamilyId.Contains(":epoch:", StringComparison.Ordinal));
        Assert.Equal("40", archived.Family.ExecutionCount);
        Assert.Equal(DataStatus.Stale, archived.Family.Evidence.Status);
        Assert.Equal("5", current.Family.ExecutionCount);
    }

    private static async Task PublishCycleAsync(
        ProtectedQueryStoreHistorySink sink,
        long count,
        string epoch = "epoch",
        bool reset = false)
    {
        var state = new QueryStoreDatabaseState(
            "db", QueryStoreCollectionState.ReadWrite, epoch, Now.AddDays(-1), Now,
            "available", 16, 160, true, true, false, false);
        await sink.BeginDatabaseCycleAsync(state, reset, default);
        await sink.StageFactsAsync("db", new QueryStoreFactPage(QueryStoreFactKind.Identity,
        [
            new QueryIdentityFact("parent", "parent-text", "context-a", "hash-a", Now, false, true, null, null, null, null),
            new QueryIdentityFact("variant", "variant-text", "context-b", "hash-b", Now, false, true, null, null, null, null),
        ], null, false), default);
        await sink.StageFactsAsync("db", new QueryStoreFactPage(QueryStoreFactKind.Plan,
        [
            new QueryPlanFact("dispatcher", "parent", "dispatcher-hash", QueryPlanType.Dispatcher, null,
                false, null, BigInteger.Zero, null, "16", "160", Now),
            new QueryPlanFact("variant-plan", "variant", "variant-hash", QueryPlanType.Variant, "dispatcher",
                false, null, BigInteger.One, "NO_INDEX", "16", "160", Now),
        ], null, false), default);
        await sink.StageFactsAsync("db", new QueryStoreFactPage(QueryStoreFactKind.Variant,
        [
            new QueryVariantFact("variant", "parent", "dispatcher", QueryOptimizationKind.ParameterSensitivePlan),
        ], null, false), default);
        await sink.StageRuntimeBucketsAsync("db",
        [
            Bucket("dispatcher", 999),
            Bucket("variant-plan", count),
        ], true, default);
        await sink.CommitDatabaseCycleAsync(state,
            new QueryStoreWatermark("db", epoch, Now, new Dictionary<QueryStoreFactKind, string?>()), default);
        await sink.PublishAsync(new QueryStoreCollectionResult(false, Now.AddSeconds(-1), Now,
        [
            new QueryStoreDatabaseCollectionResult(
                "db", QueryStoreCollectionState.ReadWrite, 4, 2, false, "available", null),
        ]), default);
    }

    private static AggregatedRuntimeBucket Bucket(string planId, long count) =>
        new(new RuntimeBucketKey(planId, "active", Now.AddHours(-1), Now,
                QueryStoreExecutionType.Regular, "primary"),
            count, 2_000m, 1_000m, 2m,
            (count * 2_000).ToString(CultureInfo.InvariantCulture),
            (count * 1_000).ToString(CultureInfo.InvariantCulture),
            (count * 2).ToString(CultureInfo.InvariantCulture));

    private static QueryStorePublishedSnapshot Snapshot(string id, long sequence) =>
        new("1.0", id, sequence, Now, [],
            new QueryStoreCollectorStatusV1(
                "1.0", QueryStoreCollectorState.Ready, sequence, Now, Now, null, [], "ready"));

    private sealed class MemoryProtectedStore : IProtectedRecordStore
    {
        public Dictionary<string, ProtectedRecord> Records { get; } = new(StringComparer.Ordinal);
        public string? ThrowRecordKind { get; set; }

        public Task PutAsync(
            ProtectedRecordId id, string recordKind, DateTimeOffset capturedAt,
            StorageResolution resolution, ReadOnlyMemory<byte> payload,
            CancellationToken cancellationToken = default)
        {
            if (recordKind == ThrowRecordKind) throw new IOException("synthetic protected-store failure");
            Records[id.Value] = new ProtectedRecord(
                id, recordKind, capturedAt, resolution, payload.ToArray());
            return Task.CompletedTask;
        }

        public Task<ProtectedRecord?> GetAsync(
            ProtectedRecordId id, CancellationToken cancellationToken = default) =>
            Task.FromResult(Records.GetValueOrDefault(id.Value));

        public Task<bool> DeleteAsync(
            ProtectedRecordId id, CancellationToken cancellationToken = default) =>
            Task.FromResult(Records.Remove(id.Value));

        public Task<int> PruneExpiredAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult(0);
    }
}
