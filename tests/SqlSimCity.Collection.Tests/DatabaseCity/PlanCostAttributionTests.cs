using SqlSimCity.Collection.DatabaseCity;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.DatabaseCity;

/// <summary>
/// Covers the split of a compiled plan's estimated cost between the objects it reads.
///
/// <para>
/// The split exists so a query's one measured wait total can be spread over the tables the query
/// actually worked on. It is therefore load-bearing in a specific way: if the arithmetic double
/// counts, or quietly parks cost on a table that did not earn it, the map shows waiting where no
/// waiting happened. These tests pin the two places that could go wrong -- what an operator's own
/// cost is, and where cost goes when the operator names no object.
/// </para>
/// </summary>
public sealed class PlanCostAttributionTests
{
    private static readonly QueryStoreEvidenceV1 Evidence = new(
        QueryStoreSource.QueryStore, DataStatus.Available, null, null, "Fixture plan.", "None.");

    private static ShowplanObjectV1 Table(string name) => new("sales", "dbo", name, null);

    private static ShowplanNodeV1 Node(
        int nodeId,
        int? parentNodeId,
        string physical,
        decimal? cpu,
        decimal? io,
        ShowplanObjectV1? reference = null,
        decimal? subtree = null) =>
        new(nodeId, parentNodeId, physical, physical, null, cpu, io, subtree, false, reference, null, []);

    private static NormalizedShowplanV1 Plan(params ShowplanNodeV1[] nodes) => new(
        "1.0", "db:plan", "1.539", null, null, null, nodes,
        QueryOptimizationKind.None, null, "fingerprint", "Compiled estimates only.", Evidence);

    private static decimal ShareOf(PlanCostSplit split, string table) =>
        split.Objects.Where(entry => entry.Reference.Table == table).Sum(entry => entry.Cost) / split.TotalCost;

    [Fact]
    public void LeafScanKeepsItsOwnCost()
    {
        var split = PlanCostAttribution.Split(Plan(
            Node(1, null, "Clustered Index Scan", 1m, 3m, Table("Customer"))));

        Assert.Equal(4m, split.TotalCost);
        Assert.Equal(0m, split.UnattributedCost);
        Assert.Equal(1m, ShareOf(split, "Customer"));
    }

    [Fact]
    public void JoinCostIsPushedDownOntoTheTablesThatFedIt()
    {
        // A hash join costs what it costs because of the rows its inputs produced. Stranding that
        // cost at the join would under-count exactly the tables driving the query.
        var split = PlanCostAttribution.Split(Plan(
            Node(1, null, "Hash Match", 4m, 0m),
            Node(2, 1, "Clustered Index Scan", 3m, 0m, Table("Customer")),
            Node(3, 1, "Index Seek", 1m, 0m, Table("OrderHeader"))));

        Assert.Equal(8m, split.TotalCost);
        Assert.Equal(0m, split.UnattributedCost);
        Assert.Equal(0.75m, ShareOf(split, "Customer"));
        Assert.Equal(0.25m, ShareOf(split, "OrderHeader"));
    }

    [Fact]
    public void SubtreeCostIsNeverSummedAsIfItWerePerOperator()
    {
        // EstimatedTotalSubtreeCost is cumulative. Summing it across a chain counts every child
        // again at each ancestor, so a deep plan would claim many times its own cost.
        var split = PlanCostAttribution.Split(Plan(
            Node(1, null, "Nested Loops", 1m, 0m, subtree: 10m),
            Node(2, 1, "Filter", 1m, 0m, subtree: 6m),
            Node(3, 2, "Index Seek", 1m, 0m, Table("Customer"), subtree: 3m)));

        Assert.Equal(3m, split.TotalCost);
        Assert.Equal(1m, ShareOf(split, "Customer"));
    }

    [Fact]
    public void PlanWithNoPerOperatorEstimateFallsBackToSubtreeDeltas()
    {
        var split = PlanCostAttribution.Split(Plan(
            Node(1, null, "Nested Loops", null, null, subtree: 10m),
            Node(2, 1, "Index Seek", null, null, Table("Customer"), subtree: 6m),
            Node(3, 1, "Index Seek", null, null, Table("OrderHeader"), subtree: 2m)));

        // Root keeps 10 - (6 + 2) = 2, pushed down 6:2 onto the seeks.
        Assert.Equal(10m, split.TotalCost);
        Assert.Equal(0m, split.UnattributedCost);
        Assert.Equal(0.75m, ShareOf(split, "Customer"));
        Assert.Equal(0.25m, ShareOf(split, "OrderHeader"));
    }

    [Fact]
    public void ComputeOverNoObjectStaysUnattributed()
    {
        var split = PlanCostAttribution.Split(Plan(
            Node(1, null, "Compute Scalar", 2m, 0m),
            Node(2, 1, "Constant Scan", 1m, 0m)));

        Assert.Equal(3m, split.TotalCost);
        Assert.Equal(3m, split.UnattributedCost);
        Assert.Empty(split.Objects);
    }

    [Fact]
    public void UnattributedCostTakesItsShareOfWorkPushedDownOverIt()
    {
        // Half the join's input came from a table and half from nowhere, so the join's own cost must
        // not arrive wholly at the table: that would make the table look responsible for compute it
        // never fed.
        var split = PlanCostAttribution.Split(Plan(
            Node(1, null, "Nested Loops", 4m, 0m),
            Node(2, 1, "Index Seek", 2m, 0m, Table("Customer")),
            Node(3, 1, "Constant Scan", 2m, 0m)));

        Assert.Equal(8m, split.TotalCost);
        Assert.Equal(0.5m, ShareOf(split, "Customer"));
        Assert.Equal(4m, split.UnattributedCost);
    }

    [Fact]
    public void FreeReadsBeneathAnExpensiveOperatorStillEarnItsCost()
    {
        var split = PlanCostAttribution.Split(Plan(
            Node(1, null, "Sort", 6m, 0m),
            Node(2, 1, "Index Seek", 0m, 0m, Table("Customer")),
            Node(3, 1, "Index Seek", 0m, 0m, Table("OrderHeader"))));

        Assert.Equal(6m, split.TotalCost);
        Assert.Equal(0m, split.UnattributedCost);
        Assert.Equal(0.5m, ShareOf(split, "Customer"));
        Assert.Equal(0.5m, ShareOf(split, "OrderHeader"));
    }

    [Fact]
    public void SeparateIndexesOnOneTableBothCountTowardsIt()
    {
        var split = PlanCostAttribution.Split(Plan(
            Node(1, null, "Nested Loops", 0m, 0m),
            Node(2, 1, "Index Seek", 1m, 0m, new ShowplanObjectV1("sales", "dbo", "Customer", "IX_A")),
            Node(3, 1, "Index Seek", 3m, 0m, new ShowplanObjectV1("sales", "dbo", "Customer", "IX_B"))));

        Assert.Equal(4m, split.TotalCost);
        Assert.Equal(1m, ShareOf(split, "Customer"));
    }

    [Fact]
    public void CyclicParentLinksLoseNoCost()
    {
        // A malformed plan must not silently shrink the workload it describes.
        var split = PlanCostAttribution.Split(Plan(
            Node(1, 2, "Nested Loops", 1m, 0m, Table("Customer")),
            Node(2, 1, "Nested Loops", 1m, 0m, Table("OrderHeader"))));

        Assert.Equal(2m, split.TotalCost);
    }

    [Fact]
    public void PlanWithoutAnyCostEstimateClaimsNothing()
    {
        var split = PlanCostAttribution.Split(Plan(
            Node(1, null, "Index Seek", null, null, Table("Customer"))));

        Assert.False(split.HasCost);
        Assert.Empty(split.Objects);
    }

    [Fact]
    public void EmptyPlanClaimsNothing()
    {
        Assert.False(PlanCostAttribution.Split(Plan()).HasCost);
    }

    [Fact]
    public void PublishedOrderIsStableAcrossReads()
    {
        var nodes = new[]
        {
            Node(1, null, "Nested Loops", 0m, 0m),
            Node(2, 1, "Index Seek", 1m, 0m, Table("Zebra")),
            Node(3, 1, "Index Seek", 1m, 0m, Table("Apple")),
            Node(4, 1, "Index Seek", 1m, 0m, Table("Mango")),
        };

        var first = PlanCostAttribution.Split(Plan(nodes));
        var second = PlanCostAttribution.Split(Plan([.. nodes.Reverse()]));

        Assert.Equal(
            first.Objects.Select(entry => entry.Reference.Table),
            second.Objects.Select(entry => entry.Reference.Table));
        Assert.Equal(["Apple", "Mango", "Zebra"], first.Objects.Select(entry => entry.Reference.Table));
    }
}
