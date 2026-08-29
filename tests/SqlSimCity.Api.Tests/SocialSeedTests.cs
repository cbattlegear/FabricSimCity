using SqlSimCity.Api.Social;

namespace SqlSimCity.Api.Tests;

/// <summary>
/// Covers the seed that chooses a link's saying.
/// </summary>
public sealed class SocialSeedTests
{
    private static readonly DateTimeOffset Noon = new(2026, 8, 29, 12, 0, 0, TimeSpan.Zero);

    private static Dictionary<string, string?> Query(params (string Key, string? Value)[] pairs) =>
        pairs.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);

    /// <summary>
    /// A preview client fetches the same URL more than once, and several readers fetch it in
    /// parallel. A line that changed per request would read as instability, not as variety.
    /// </summary>
    [Fact]
    public void SameLinkOnTheSameDayGetsTheSameSaying()
    {
        var query = Query(("view", "city"), ("database", "primary/database/Ledger"));

        Assert.Equal(
            SocialSeed.For(query, Noon),
            SocialSeed.For(query, Noon.AddHours(6)));
    }

    [Fact]
    public void SameLinkGetsADifferentSayingTomorrow()
    {
        var query = Query(("view", "city"), ("database", "primary/database/Ledger"));

        Assert.NotEqual(SocialSeed.For(query, Noon), SocialSeed.For(query, Noon.AddDays(1)));
    }

    [Fact]
    public void DifferentDatabasesGetDifferentSayings()
    {
        Assert.NotEqual(
            SocialSeed.For(Query(("view", "city"), ("database", "e/database/A")), Noon),
            SocialSeed.For(Query(("view", "city"), ("database", "e/database/B")), Noon));
    }

    /// <summary>
    /// The day boundary is UTC, so an offset does not move a link into a different day's saying.
    /// </summary>
    [Fact]
    public void DayIsCountedInUtc()
    {
        var utc = new DateTimeOffset(2026, 8, 29, 23, 30, 0, TimeSpan.Zero);
        var elsewhere = utc.ToOffset(TimeSpan.FromHours(-7));

        Assert.Equal(SocialSeed.DayNumber(utc), SocialSeed.DayNumber(elsewhere));
    }

    /// <summary>
    /// <c>string.GetHashCode</c> is randomised per process, so it would have handed out a different
    /// saying after every restart. This is why the seed is FNV-1a rather than the obvious call.
    /// </summary>
    [Fact]
    public void SeedIsStableAcrossProcessesByConstruction()
    {
        Assert.Equal(6531833638680780624L, SocialSeed.For("city|primary/database/Ledger", Noon));
    }
}
