using SqlSimCity.Api.Social;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Api.Tests;

/// <summary>
/// Covers the step between measurement and picture: which plots exist and how tall they stand.
/// </summary>
public sealed class SocialCardSceneTests
{
    private static AtlasSnapshotV1 Atlas(params (string Name, string? Bytes)[] databases) =>
        SocialCardFixtures.Atlas([.. databases.Select(entry => SocialCardFixtures.Database(entry.Name, entry.Bytes))]);

    [Fact]
    public void EmptyMeasurementDrawsNoSkylineRatherThanAnInventedOne()
    {
        Assert.Empty(SocialCardScenes.Normalize([]));
        Assert.Empty(SocialCardScenes.ForAtlas(Atlas(), "saying").Towers);
    }

    [Fact]
    public void HeightsAreOrderedTheSameWayTheSizesAre()
    {
        var heights = SocialCardScenes.Normalize([1_000L, 1_000_000L, 10L]);

        Assert.Equal(1.0, heights[1], 6);
        Assert.True(heights[0] > heights[2]);
    }

    /// <summary>
    /// A measured object drawn as a kerbstone is counted in the stats line and invisible in the
    /// picture, which makes the card look like it lost something.
    /// </summary>
    [Fact]
    public void SmallestMeasuredObjectStillStandsAtTheFloor()
    {
        var heights = SocialCardScenes.Normalize([1L, 900_000_000_000L]);

        Assert.Equal(SocialCardScenes.Floor, heights.Min(), 6);
        Assert.Equal(1.0, heights.Max(), 6);
    }

    /// <summary>
    /// Dividing by a zero span is not an answer; standing them level is.
    /// </summary>
    [Fact]
    public void EqualSizesStandAtACommonHeight()
    {
        var heights = SocialCardScenes.Normalize([4096L, 4096L, 4096L]);

        Assert.All(heights, height => Assert.Equal(0.72, height, 6));
    }

    [Fact]
    public void LogScaleKeepsAThousandFoldSpreadOnTheSameCard()
    {
        var heights = SocialCardScenes.Normalize([1_000_000_000_000L, 1_000_000_000L, 1_000_000L]);

        // Linear would put the second tower at a thousandth of the first. It sits mid-card instead.
        Assert.InRange(heights[1], 0.5, 0.8);
    }

    /// <summary>
    /// A preview client fetches the image more than once; a skyline that rearranged between fetches
    /// would look like a fault in the thing being advertised.
    /// </summary>
    [Fact]
    public void ScatterIsAFunctionOfTheDataAndNothingElse()
    {
        var towers = SocialCardScenes.Skyline([9L, 400L, 30L, 8_000L, 12L], 1);

        var first = SocialCardScenes.Scatter(towers);
        var second = SocialCardScenes.Scatter(towers);

        Assert.Equal(first, second);
    }

    /// <summary>
    /// Sorted heights draw a staircase, and a staircase is a bar chart whatever the bars look like.
    /// </summary>
    [Fact]
    public void ScatterBreaksTheSortedOrder()
    {
        var sorted = SocialCardScenes.Skyline([100_000L, 10_000L, 1_000L, 100L, 10L, 1L], 0);

        var scattered = SocialCardScenes.Scatter(sorted);

        Assert.NotEqual(sorted, scattered);
        Assert.Equal(
            sorted.Select(tower => tower.Height).OrderBy(height => height),
            scattered.Select(tower => tower.Height).OrderBy(height => height));
    }

    [Fact]
    public void ScatterLeavesTooFewTowersAlone()
    {
        var pair = SocialCardScenes.Skyline([10L, 20L], 0);

        Assert.Equal(pair, SocialCardScenes.Scatter(pair));
    }

    /// <summary>
    /// The card said "8 databases" over six towers before unmeasured plots were drawn.
    /// </summary>
    [Fact]
    public void UnmeasuredDatabasesGetAPlotSoTheCountMatchesThePicture()
    {
        var scene = SocialCardScenes.ForAtlas(
            Atlas(("sales", "1024"), ("ledger", "2048"), ("archive", null), ("scratch", "0")),
            "saying");

        Assert.Equal(4, scene.Towers.Count);
        Assert.Equal(2, scene.Towers.Count(tower => tower.Measured));
        Assert.Equal(2, scene.Towers.Count(tower => !tower.Measured));
        Assert.Contains("4 databases", scene.Stats, StringComparison.Ordinal);
    }

    /// <summary>
    /// A short tower is a claim that the thing is small, and nothing measured it.
    /// </summary>
    [Fact]
    public void UnmeasuredPlotsCarryNoHeight()
    {
        var scene = SocialCardScenes.ForAtlas(Atlas(("archive", null)), "saying");

        var lot = Assert.Single(scene.Towers);
        Assert.False(lot.Measured);
        Assert.Equal(0, lot.Height);
    }

    [Fact]
    public void SkylineNeverExceedsItsCap()
    {
        var sizes = Enumerable.Range(1, 200).Select(value => (long)value * 1024).ToList();

        var towers = SocialCardScenes.Skyline(sizes, 500);

        Assert.Equal(SocialCardScenes.MaximumTowers, towers.Count);
    }

    [Fact]
    public void UnparseableByteCountsAreAbsentEvidenceRatherThanZero()
    {
        var scene = SocialCardScenes.ForAtlas(Atlas(("odd", "not-a-number")), "saying");

        Assert.False(Assert.Single(scene.Towers).Measured);
    }

    [Fact]
    public void MissingAtlasStillProducesACard()
    {
        var scene = SocialCardScenes.ForAtlas(null, "saying");

        Assert.Equal("SQL Sim City", scene.Headline);
        Assert.Empty(scene.Towers);
        Assert.Empty(scene.Stats);
    }

    [Fact]
    public void UnmeasuredCityNamesTheDatabaseItCouldNotDraw()
    {
        var scene = SocialCardScenes.ForUnmeasuredCity("Ledger", "saying");

        Assert.Equal("Ledger", scene.Headline);
        Assert.Equal("Database city", scene.Kicker);
        Assert.Empty(scene.Towers);
    }

    [Fact]
    public void CityCountsObjectsRatherThanDrawnTowers()
    {
        var page = SocialCardFixtures.City(
            "Ledger",
            "1200",
            SocialCardFixtures.CityObject("Orders", "8192"),
            SocialCardFixtures.CityObject("Lines", "4096"));

        var scene = SocialCardScenes.ForCity(page, "saying");

        Assert.Equal("1,200 objects", scene.Stats);
        Assert.Equal(2, scene.Towers.Count);
    }

    [Theory]
    [InlineData(0L, "0 B")]
    [InlineData(1023L, "1023 B")]
    [InlineData(1024L, "1 KB")]
    [InlineData(1536L, "1.5 KB")]
    [InlineData(1099511627776L, "1 TB")]
    public void ByteCountsAreFormattedTheWayTheAppFormatsThem(long bytes, string expected)
    {
        Assert.Equal(expected, SocialCardRenderer.FormatBytes(bytes));
    }
}
