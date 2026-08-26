using SqlSimCity.Collection.DatabaseCity;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.DatabaseCity;

/// <summary>
/// Covers the estimate of how much data one execution of a compiled plan moves.
///
/// <para>
/// The figure decides how large a vehicle the map drives down a road, so the two ways it can lie
/// are what these tests pin. Counting rows more than once -- once at the scan and again at every
/// operator above it -- would send a semi-truck down a road carrying a bicycle's worth of data.
/// Treating a missing <c>AvgRowSize</c> as zero bytes would do the reverse, and silently: a wide
/// table read through an operator that stated no row size would look like a query moving nothing.
/// </para>
/// </summary>
public sealed class PlanDataVolumeTests
{
    private static readonly QueryStoreEvidenceV1 Evidence = new(
        QueryStoreSource.QueryStore, DataStatus.Available, null, null, "Fixture plan.", "None.");

    private static readonly string[] ExpectedAlphabeticalOrder = ["Alpha", "Mike", "Zulu"];

    private static ShowplanObjectV1 Table(string name) => new("sales", "dbo", name, null);

    private static ShowplanNodeV1 Node(
        int nodeId,
        int? parentNodeId,
        string physical,
        decimal? rows,
        decimal? rowSize,
        ShowplanObjectV1? reference = null) =>
        new(nodeId, parentNodeId, physical, physical, rows, null, null, null, false, reference, null, [],
            rowSize);

    private static NormalizedShowplanV1 Plan(params ShowplanNodeV1[] nodes) => new(
        "1.0", "db:plan", "1.539", null, null, null, nodes,
        QueryOptimizationKind.None, null, "fingerprint", "Compiled estimates only.", Evidence);

    private static decimal BytesFor(PlanDataVolumeSplit split, string table) =>
        split.Objects.Where(entry => entry.Reference.Table == table).Sum(entry => entry.EstimatedBytes);

    [Fact]
    public void LeafScanContributesRowsTimesRowSize()
    {
        var split = PlanDataVolume.Split(Plan(
            Node(1, null, "Clustered Index Scan", 1_000m, 120m, Table("Customer"))));

        Assert.True(split.HasVolume);
        Assert.Equal(120_000m, split.TotalBytes);
        Assert.Equal(120_000m, BytesFor(split, "Customer"));
        Assert.Equal(1, split.OperatorsMeasured);
        Assert.Equal(0, split.OperatorsMissingRowSize);
    }

    [Fact]
    public void OperatorsAboveAScanDoNotCountTheSameRowsAgain()
    {
        // This is the whole reason the split does not push down the way the cost split does. The
        // filter and the sort re-emit rows the scan already produced; counting them would report
        // three times the data for a plan that read one table once.
        var split = PlanDataVolume.Split(Plan(
            Node(1, null, "Sort", 1_000m, 120m),
            Node(2, 1, "Filter", 1_000m, 120m),
            Node(3, 2, "Clustered Index Scan", 1_000m, 120m, Table("Customer"))));

        Assert.Equal(120_000m, split.TotalBytes);
        Assert.Equal(1, split.OperatorsMeasured);
    }

    [Fact]
    public void OperatorsNamingNoObjectAreNotCountedAsMissingEither()
    {
        // A sort naming no object is not a gap in the plan's disclosure -- it genuinely has no
        // object to attribute bytes to. Counting it as missing would make every plan look partial.
        var split = PlanDataVolume.Split(Plan(
            Node(1, null, "Sort", 1_000m, 120m),
            Node(2, 1, "Clustered Index Scan", 1_000m, 120m, Table("Customer"))));

        Assert.Equal(0, split.OperatorsMissingRowSize);
    }

    [Fact]
    public void EachTableInAJoinIsSizedByItsOwnRows()
    {
        var split = PlanDataVolume.Split(Plan(
            Node(1, null, "Hash Match", 5_000m, 200m),
            Node(2, 1, "Clustered Index Scan", 1_000m, 120m, Table("Customer")),
            Node(3, 1, "Index Seek", 50m, 40m, Table("OrderHeader"))));

        Assert.Equal(120_000m, BytesFor(split, "Customer"));
        Assert.Equal(2_000m, BytesFor(split, "OrderHeader"));
        Assert.Equal(122_000m, split.TotalBytes);
    }

    [Fact]
    public void RepeatedReadsOfOneTableAccumulateOnThatTable()
    {
        // A table scanned on both sides of a self-join really is read twice, and the bytes really do
        // move twice. This is not the double-counting the pushdown rule guards against.
        var split = PlanDataVolume.Split(Plan(
            Node(1, null, "Merge Join", 1_000m, 120m),
            Node(2, 1, "Clustered Index Scan", 400m, 100m, Table("Customer")),
            Node(3, 1, "Clustered Index Scan", 600m, 100m, Table("Customer"))));

        Assert.Single(split.Objects);
        Assert.Equal(100_000m, BytesFor(split, "Customer"));
    }

    [Fact]
    public void AnIndexOnTheSameTableIsItsOwnObject()
    {
        // The city draws indexes as their own structures, so an index seek's bytes must not be
        // silently folded into the base table's.
        var split = PlanDataVolume.Split(Plan(
            Node(1, null, "Clustered Index Scan", 10m, 100m, new ShowplanObjectV1("sales", "dbo", "Customer", null)),
            Node(2, null, "Index Seek", 10m, 20m, new ShowplanObjectV1("sales", "dbo", "Customer", "IX_Customer_Name"))));

        Assert.Equal(2, split.Objects.Count);
        Assert.Equal(1_200m, split.TotalBytes);
    }

    [Fact]
    public void MissingRowSizeIsDisclosedRatherThanCountedAsZeroBytes()
    {
        var split = PlanDataVolume.Split(Plan(
            Node(1, null, "Clustered Index Scan", 1_000m, 120m, Table("Customer")),
            Node(2, null, "Remote Scan", 5_000_000m, null, Table("Ledger"))));

        Assert.Equal(1, split.OperatorsMissingRowSize);
        Assert.Equal(120_000m, split.TotalBytes);
        Assert.DoesNotContain(split.Objects, entry => entry.Reference.Table == "Ledger");
    }

    [Fact]
    public void MissingRowCountIsDisclosedTheSameWay()
    {
        var split = PlanDataVolume.Split(Plan(
            Node(1, null, "Clustered Index Scan", 1_000m, 120m, Table("Customer")),
            Node(2, null, "Table Scan", null, 400m, Table("Ledger"))));

        Assert.Equal(1, split.OperatorsMissingRowSize);
        Assert.Equal(120_000m, split.TotalBytes);
    }

    [Fact]
    public void ZeroEstimatedRowsIsARealEstimateAndNotAGap()
    {
        // The optimizer expecting nothing from a branch is something it said, not something it
        // failed to say. Reporting it as missing would understate how well the plan disclosed.
        var split = PlanDataVolume.Split(Plan(
            Node(1, null, "Clustered Index Scan", 1_000m, 120m, Table("Customer")),
            Node(2, null, "Index Seek", 0m, 40m, Table("OrderHeader"))));

        Assert.Equal(0, split.OperatorsMissingRowSize);
        Assert.Equal(2, split.OperatorsMeasured);
        Assert.Equal(0m, BytesFor(split, "OrderHeader"));
    }

    [Fact]
    public void APlanWhereNothingStatedARowSizeReportsNoVolumeRatherThanZero()
    {
        var split = PlanDataVolume.Split(Plan(
            Node(1, null, "Clustered Index Scan", 1_000m, null, Table("Customer")),
            Node(2, null, "Index Seek", 50m, null, Table("OrderHeader"))));

        Assert.False(split.HasVolume);
        Assert.Empty(split.Objects);
        Assert.Equal(0m, split.TotalBytes);

        // "Two operators named an object and neither stated a row size" is a different fact from
        // "this plan reads nothing", and the count is what carries the difference.
        Assert.Equal(2, split.OperatorsMissingRowSize);
    }

    [Fact]
    public void APlanThatNamesNoObjectAtAllIsEmptyWithNothingMissing()
    {
        var split = PlanDataVolume.Split(Plan(
            Node(1, null, "Constant Scan", 1m, 8m)));

        Assert.False(split.HasVolume);
        Assert.Equal(0, split.OperatorsMissingRowSize);
    }

    [Fact]
    public void AnEmptyPlanIsEmpty()
    {
        var split = PlanDataVolume.Split(Plan());

        Assert.False(split.HasVolume);
        Assert.Equal(0, split.OperatorsMeasured);
        Assert.Equal(0, split.OperatorsMissingRowSize);
    }

    [Fact]
    public void NegativeRowCountsAreTreatedAsMissingNotSubtracted()
    {
        // Nothing should emit a negative estimate, but if one arrives it must not cancel out real
        // bytes read elsewhere in the plan.
        var split = PlanDataVolume.Split(Plan(
            Node(1, null, "Clustered Index Scan", 1_000m, 120m, Table("Customer")),
            Node(2, null, "Table Scan", -500m, 100m, Table("Ledger"))));

        Assert.Equal(120_000m, split.TotalBytes);
        Assert.Equal(1, split.OperatorsMissingRowSize);
    }

    [Fact]
    public void NegativeRowSizesAreTreatedAsMissingNotSubtracted()
    {
        var split = PlanDataVolume.Split(Plan(
            Node(1, null, "Clustered Index Scan", 1_000m, 120m, Table("Customer")),
            Node(2, null, "Table Scan", 500m, -100m, Table("Ledger"))));

        Assert.Equal(120_000m, split.TotalBytes);
        Assert.Equal(1, split.OperatorsMissingRowSize);
    }

    [Fact]
    public void ObjectOrderIsFixedRatherThanTakenFromPlanShape()
    {
        // A city that redraws itself in a different order on a second read of the same plan is a
        // city nobody can trust, so the published order cannot come from dictionary enumeration.
        var forwards = PlanDataVolume.Split(Plan(
            Node(1, null, "Index Seek", 10m, 10m, Table("Zulu")),
            Node(2, null, "Index Seek", 10m, 10m, Table("Alpha")),
            Node(3, null, "Index Seek", 10m, 10m, Table("Mike"))));

        var backwards = PlanDataVolume.Split(Plan(
            Node(1, null, "Index Seek", 10m, 10m, Table("Mike")),
            Node(2, null, "Index Seek", 10m, 10m, Table("Alpha")),
            Node(3, null, "Index Seek", 10m, 10m, Table("Zulu"))));

        Assert.Equal(
            ExpectedAlphabeticalOrder,
            forwards.Objects.Select(entry => entry.Reference.Table).ToArray());
        Assert.Equal(
            forwards.Objects.Select(entry => entry.Reference.Table).ToArray(),
            backwards.Objects.Select(entry => entry.Reference.Table).ToArray());
    }

    [Fact]
    public void TotalEqualsTheSumOfThePublishedObjects()
    {
        // The total is what sizes the vehicle and the per-object figures are what place it; if they
        // disagree the map contradicts itself between the road and the building.
        var split = PlanDataVolume.Split(Plan(
            Node(1, null, "Hash Match", 5_000m, 200m),
            Node(2, 1, "Clustered Index Scan", 1_000m, 120m, Table("Customer")),
            Node(3, 1, "Index Seek", 50m, 40m, Table("OrderHeader")),
            Node(4, 1, "Table Scan", 7m, 3m, Table("Audit"))));

        Assert.Equal(split.Objects.Sum(entry => entry.EstimatedBytes), split.TotalBytes);
    }

    [Fact]
    public void ThrowsOnANullPlanRatherThanReportingAQuietQuery()
    {
        Assert.Throws<ArgumentNullException>(() => PlanDataVolume.Split(null!));
    }
}
