using SqlSimCity.Collection.DatabaseCity;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Collection.Tests.DatabaseCity;

/// <summary>
/// Covers the step that turns per-plan data volume into the figure the city publishes for a query
/// family.
///
/// <para>
/// A family can retain several compiled plans, and each one describes the whole query. Summing them
/// would report a query as moving several times the data it moves, purely because Query Store kept
/// more than one plan for it -- so the accumulator averages, and these tests pin that. They also pin
/// the two silences the field has to keep apart: "no plan stated a row size", which publishes
/// nothing, and "the plans stated a row size and it was small", which publishes a small number.
/// </para>
/// </summary>
public sealed class PlanDataVolumeAttributionTests
{
    private const string DatabaseId = FakeQueryStore.DatabaseId;
    private const string CustomerId = "target/database/sales/object/10";
    private const string OrderId = "target/database/sales/object/20";

    private static readonly IReadOnlyList<CityAttributionObject> PageObjects =
    [
        new(CustomerId, "dbo", "Customer", DatabaseObjectKind.Table),
        new(OrderId, "dbo", "OrderHeader", DatabaseObjectKind.Table),
    ];

    private static Task<CityAttributionResult> AttributeAsync(FakeQueryStore store) =>
        new QueryStoreCityAttribution(store).AttributeAsync(
            FakeQueryStore.DatabaseName,
            DatabaseCityMetric.Cpu,
            PageObjects,
            new Dictionary<string, string> { ["sales"] = DatabaseId },
            topFamilyCount: 12,
            CancellationToken.None);

    private static FakeQueryStore.PlanNode Node(string table, decimal? rows, decimal? rowSize) =>
        new(FakeQueryStore.Reference(table: table), rows, rowSize);

    private static string BytesFor(DatabaseCityPlanDataVolumeV1 volume, string objectId) =>
        volume.ByObject.Single(entry => entry.ObjectId == objectId).EstimatedBytesPerExecution;

    [Fact]
    public async Task PublishesRowsTimesRowSizeForASinglePlan()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "900", executions: "30", plans:
            [FakeQueryStore.SizedPlan("plan-1", Node("Customer", 1_000m, 120m))]);

        var family = Assert.Single((await AttributeAsync(store)).Families);
        var volume = family.PlanDataVolume;
        Assert.NotNull(volume);

        Assert.Equal("120000", volume.EstimatedBytesPerExecution);
        Assert.Equal("120000", BytesFor(volume, CustomerId));
        Assert.Equal(1, volume.PlansRead);
    }

    [Fact]
    public async Task AveragesAcrossRetainedPlansRatherThanSummingThem()
    {
        // Both plans describe the same query. Summing would say this family moves 300 KB per
        // execution because Query Store happens to hold two plans, which is an artifact of plan
        // retention rather than anything the query does.
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "900", executions: "30", plans:
        [
            FakeQueryStore.SizedPlan("plan-1", Node("Customer", 1_000m, 100m)),
            FakeQueryStore.SizedPlan("plan-2", Node("Customer", 2_000m, 100m)),
        ]);

        var family = Assert.Single((await AttributeAsync(store)).Families);
        var volume = family.PlanDataVolume;
        Assert.NotNull(volume);

        Assert.Equal("150000", volume.EstimatedBytesPerExecution);
        Assert.Equal("150000", BytesFor(volume, CustomerId));
        Assert.Equal(2, volume.PlansRead);
    }

    [Fact]
    public async Task PerObjectFiguresAreAveragedOnTheSameDivisorAsTheTotal()
    {
        // A plan that reads a table the other plan does not still divides by every plan read. The
        // alternative -- dividing each object by only the plans that named it -- makes the per-object
        // figures sum to more than the total the road is drawn from.
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "900", executions: "30", plans:
        [
            FakeQueryStore.SizedPlan("plan-1", Node("Customer", 100m, 100m)),
            FakeQueryStore.SizedPlan("plan-2", Node("Customer", 100m, 100m), Node("OrderHeader", 200m, 100m)),
        ]);

        var family = Assert.Single((await AttributeAsync(store)).Families);
        var volume = family.PlanDataVolume;
        Assert.NotNull(volume);

        Assert.Equal("10000", BytesFor(volume, CustomerId));
        Assert.Equal("10000", BytesFor(volume, OrderId));
        Assert.Equal("20000", volume.EstimatedBytesPerExecution);
    }

    [Fact]
    public async Task AFamilyWhosePlansStatedNoRowSizeReportsNothingRatherThanZero()
    {
        // This is the case that would otherwise put the smallest vehicle on the map for a query
        // that may move gigabytes, so the field has to be absent rather than "0".
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "900", executions: "30", plans:
            [FakeQueryStore.Plan("plan-1", FakeQueryStore.Reference(table: "Customer"))]);

        var family = Assert.Single((await AttributeAsync(store)).Families);

        Assert.Null(family.PlanDataVolume);
    }

    [Fact]
    public async Task PlansThatStatedNoRowSizeDoNotDiluteThePlansThatDid()
    {
        // A plan carrying no estimate is not evidence that the query moves less data; it is no
        // evidence at all. Averaging it in as a zero would halve the figure for no reason.
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "900", executions: "30", plans:
        [
            FakeQueryStore.SizedPlan("plan-1", Node("Customer", 1_000m, 100m)),
            FakeQueryStore.Plan("plan-2", FakeQueryStore.Reference(table: "Customer")),
        ]);

        var family = Assert.Single((await AttributeAsync(store)).Families);
        var volume = family.PlanDataVolume;
        Assert.NotNull(volume);

        Assert.Equal("100000", volume.EstimatedBytesPerExecution);
        Assert.Equal(1, volume.PlansRead);

        // Silently dropping it would leave the reader thinking every retained plan agreed.
        Assert.Contains("stated no row size at all", volume.Rationale, StringComparison.Ordinal);
    }

    [Fact]
    public async Task BytesReadFromObjectsThisPageDoesNotDrawStayInTheTotal()
    {
        // The total answers "how much data does this query move", which is true regardless of what
        // this page happens to draw. Dropping off-page bytes would make a query that reads mostly
        // elsewhere look small on the one road it does touch.
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "900", executions: "30", plans:
            [FakeQueryStore.SizedPlan(
                "plan-1",
                Node("Customer", 100m, 100m),
                Node("Archive", 900m, 100m))]);

        var family = Assert.Single((await AttributeAsync(store)).Families);
        var volume = family.PlanDataVolume;
        Assert.NotNull(volume);

        Assert.Equal("100000", volume.EstimatedBytesPerExecution);
        Assert.Equal("10000", BytesFor(volume, CustomerId));
        Assert.Single(volume.ByObject);
        Assert.Contains("does not draw", volume.Rationale, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnOperatorMissingARowSizeIsDisclosedAsAnUnderstatement()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "900", executions: "30", plans:
            [FakeQueryStore.SizedPlan(
                "plan-1",
                Node("Customer", 100m, 100m),
                Node("OrderHeader", 5_000_000m, null))]);

        var family = Assert.Single((await AttributeAsync(store)).Families);
        var volume = family.PlanDataVolume;
        Assert.NotNull(volume);

        Assert.Equal("10000", volume.EstimatedBytesPerExecution);
        Assert.Contains("understates", volume.Rationale, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheRationaleSaysTheFigureIsAnEstimateAndNotAMeasurement()
    {
        // Every modelled number in this city is obliged to label itself. A byte count reads like a
        // measurement unless it says otherwise, and this one is the optimizer's guess.
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "900", executions: "30", plans:
            [FakeQueryStore.SizedPlan("plan-1", Node("Customer", 1_000m, 120m))]);

        var family = Assert.Single((await AttributeAsync(store)).Families);
        var volume = family.PlanDataVolume;
        Assert.NotNull(volume);

        Assert.Contains("estimate", volume.Rationale, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("not a measurement", volume.Rationale, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ObjectOrderIsStableAcrossReads()
    {
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "900", executions: "30", plans:
            [FakeQueryStore.SizedPlan(
                "plan-1",
                Node("OrderHeader", 200m, 100m),
                Node("Customer", 100m, 100m))]);

        var first = Assert.Single((await AttributeAsync(store)).Families).PlanDataVolume;
        var second = Assert.Single((await AttributeAsync(store)).Families).PlanDataVolume;
        Assert.NotNull(first);
        Assert.NotNull(second);
        Assert.Equal(
            first.ByObject.Select(entry => entry.ObjectId).ToArray(),
            second.ByObject.Select(entry => entry.ObjectId).ToArray());
    }

    [Fact]
    public async Task AFractionalAverageIsRoundedToWholeBytes()
    {
        // A third of a byte is an artifact of averaging plans, not something the optimizer claimed,
        // and a field named in bytes should not publish one.
        var store = new FakeQueryStore();
        store.AddFamily("family-1", cpu: "900", executions: "30", plans:
        [
            FakeQueryStore.SizedPlan("plan-1", Node("Customer", 1m, 1m)),
            FakeQueryStore.SizedPlan("plan-2", Node("Customer", 1m, 2m)),
            FakeQueryStore.SizedPlan("plan-3", Node("Customer", 1m, 1m)),
        ]);

        var family = Assert.Single((await AttributeAsync(store)).Families);
        var volume = family.PlanDataVolume;
        Assert.NotNull(volume);

        Assert.Equal("1", volume.EstimatedBytesPerExecution);
    }
}
