using System.Globalization;
using System.Numerics;
using SqlSimCity.Collection.DatabaseCity;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain.DatabaseCity;

namespace SqlSimCity.Collection.Tests.DatabaseCity;

/// <summary>
/// Covers the division of a query family's measured wait milliseconds by estimated plan cost.
///
/// <para>
/// The promise these tests hold to is reconciliation: whatever the split does, adding the parts and
/// the remainder back up must return the measured total exactly. An apportionment that does not
/// reconcile is indistinguishable from an invented number, and this codebase withholds numbers it
/// cannot stand behind rather than showing approximate ones.
/// </para>
/// </summary>
public sealed class WaitApportionmentTests
{
    private const string Reason = "fixture";

    private static BigInteger Sum(DatabaseCityWaitAttributionV1 attribution)
    {
        var total = BigInteger.Parse(attribution.UnattributedWaitMilliseconds, CultureInfo.InvariantCulture);
        foreach (var entry in attribution.Objects)
            total += BigInteger.Parse(entry.WaitMilliseconds, CultureInfo.InvariantCulture);
        return total;
    }

    [Fact]
    public void PartsAreProportionalToEstimatedCost()
    {
        var attribution = WaitApportionment.Apportion(
            [new ObjectCostShare("a", 0.75m), new ObjectCostShare("b", 0.25m)], "1000", 1, Reason);

        Assert.Equal("750", attribution.Objects.Single(entry => entry.ObjectId == "a").WaitMilliseconds);
        Assert.Equal("250", attribution.Objects.Single(entry => entry.ObjectId == "b").WaitMilliseconds);
        Assert.Equal("0", attribution.UnattributedWaitMilliseconds);
    }

    [Theory]
    [InlineData("1000")]
    [InlineData("1")]
    [InlineData("7")]
    [InlineData("999999999999999999999999")]
    public void PartsAndRemainderAlwaysSumToTheMeasuredTotal(string total)
    {
        // Thirds never divide cleanly, so this is the case where a sloppy split loses or gains time.
        var third = 1m / 3m;
        var attribution = WaitApportionment.Apportion(
            [new ObjectCostShare("a", third), new ObjectCostShare("b", third), new ObjectCostShare("c", third)],
            total, 1, Reason);

        Assert.Equal(BigInteger.Parse(total, CultureInfo.InvariantCulture), Sum(attribution));
    }

    [Fact]
    public void ShareThatLandedOffThisPageStaysInTheRemainder()
    {
        // The caller only passes shares that resolved to a drawn building. What is missing from 1 is
        // cost on objects this page does not draw, and it must not be handed to the ones it does.
        var attribution = WaitApportionment.Apportion(
            [new ObjectCostShare("a", 0.25m)], "1000", 1, Reason);

        Assert.Equal("250", attribution.Objects.Single().WaitMilliseconds);
        Assert.Equal("750", attribution.UnattributedWaitMilliseconds);
    }

    [Fact]
    public void NoResolvedShareLeavesEveryMillisecondUnapportioned()
    {
        var attribution = WaitApportionment.Apportion([], "4321", 2, Reason);

        Assert.Empty(attribution.Objects);
        Assert.Equal("4321", attribution.UnattributedWaitMilliseconds);
        Assert.Equal(2, attribution.PlansRead);
    }

    [Fact]
    public void TiesAreBrokenByObjectIdSoOnePlanAlwaysSplitsTheSameWay()
    {
        var forwards = WaitApportionment.Apportion(
            [new ObjectCostShare("a", 0.5m), new ObjectCostShare("b", 0.5m)], "1", 1, Reason);
        var backwards = WaitApportionment.Apportion(
            [new ObjectCostShare("b", 0.5m), new ObjectCostShare("a", 0.5m)], "1", 1, Reason);

        Assert.Equal("1", forwards.Objects.Single(entry => entry.ObjectId == "a").WaitMilliseconds);
        Assert.Equal("1", backwards.Objects.Single(entry => entry.ObjectId == "a").WaitMilliseconds);
        Assert.Equal(BigInteger.One, Sum(forwards));
    }

    [Fact]
    public void ARemainingMillisecondPrefersABuildingOverTheUnattributedPool()
    {
        // One millisecond, one building holding every bit of the estimated cost: the building gets it.
        var attribution = WaitApportionment.Apportion(
            [new ObjectCostShare("a", 1m)], "1", 1, Reason);

        Assert.Equal("1", attribution.Objects.Single().WaitMilliseconds);
        Assert.Equal("0", attribution.UnattributedWaitMilliseconds);
    }

    [Fact]
    public void ZeroWaitApportionsZeroRatherThanRefusing()
    {
        var attribution = WaitApportionment.Apportion(
            [new ObjectCostShare("a", 0.5m)], "0", 1, Reason);

        Assert.Equal("0", attribution.Objects.Single().WaitMilliseconds);
        Assert.Equal("0", attribution.UnattributedWaitMilliseconds);
    }

    [Fact]
    public void UnreadableTotalIsRefusedRatherThanGuessed()
    {
        var attribution = WaitApportionment.Apportion(
            [new ObjectCostShare("a", 0.5m)], "not a number", 1, Reason);

        Assert.Empty(attribution.Objects);
        Assert.Equal(DatabaseCityWaitAttributionV1.None, attribution);
    }

    [Fact]
    public void SharesRoundingPastTheWholeStillReconcile()
    {
        var attribution = WaitApportionment.Apportion(
            [new ObjectCostShare("a", 0.9m), new ObjectCostShare("b", 0.9m)], "1000", 1, Reason);

        Assert.Equal(new BigInteger(1000), Sum(attribution));
    }

    [Fact]
    public void PublishedShareIsRoundedButThePartsStillReconcile()
    {
        var attribution = WaitApportionment.Apportion(
            [new ObjectCostShare("a", 1m / 3m), new ObjectCostShare("b", 2m / 3m)], "1000", 1, Reason);

        Assert.Equal(0.333333m, attribution.Objects.Single(entry => entry.ObjectId == "a").EstimatedCostShare);
        Assert.Equal(new BigInteger(1000), Sum(attribution));
    }
}
