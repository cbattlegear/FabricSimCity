using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.QueryStore;

public sealed class QueryStoreAggregationTests
{
    [Fact]
    public void ActiveDuplicatesUseCompleteKeyAndWeightedFractionalAverage()
    {
        var rows = new[]
        {
            Row(40, 2_000m, QueryStoreExecutionType.Regular, "primary"),
            Row(7, 2_000m, QueryStoreExecutionType.Regular, "primary"),
            Row(1_000, 2_000m, QueryStoreExecutionType.Aborted, "replica-2"),
            Row(10, 200_000m, QueryStoreExecutionType.Aborted, "replica-2"),
        };

        var result = QueryStoreRuntimeAggregator.Aggregate(rows);

        Assert.Equal(2, result.Count);
        Assert.Equal(47, result.Single(x => x.Key.ExecutionType == QueryStoreExecutionType.Regular).ExecutionCount);
        Assert.Equal(3_960.3960396039603960396039604m,
            result.Single(x => x.Key.ExecutionType == QueryStoreExecutionType.Aborted).AverageDurationMicroseconds);
    }

    [Fact]
    public void FamilyKeyNeverMergesUnavailableTextOrHashCollisions()
    {
        var availableA = QueryFamilyIdentity.Create("db", "0x01", "select 1", "query-1");
        var availableB = QueryFamilyIdentity.Create("db", "0x01", "select 2", "query-2");
        var restrictedA = QueryFamilyIdentity.Create("db", "0x01", null, "query-1");
        var restrictedB = QueryFamilyIdentity.Create("db", "0x01", null, "query-2");

        Assert.NotEqual(availableA.FamilyId, availableB.FamilyId);
        Assert.NotEqual(restrictedA.FamilyId, restrictedB.FamilyId);
    }

    private static RuntimeStatInput Row(
        long count, decimal duration, QueryStoreExecutionType type, string replica) =>
        new("plan-1", "interval-active", new DateTimeOffset(2026, 8, 17, 17, 0, 0, TimeSpan.Zero),
            new DateTimeOffset(2026, 8, 17, 18, 0, 0, TimeSpan.Zero), type, replica, count,
            duration, duration / 2, 0.4m);
}
