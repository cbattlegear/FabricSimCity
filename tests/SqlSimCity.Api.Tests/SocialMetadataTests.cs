using SqlSimCity.Api.Social;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Api.Tests;

/// <summary>
/// Covers what a link says about itself, which is a pure function of the request and the atlas.
/// </summary>
public sealed class SocialMetadataTests
{
    private static AtlasSnapshotV1 Atlas(params (string Id, string Name)[] databases) =>
        SocialCardFixtures.Atlas([.. databases.Select(entry =>
            SocialCardFixtures.Database(entry.Name, "1024") with { DatabaseId = entry.Id })]);

    private static Dictionary<string, string?> Query(params (string Key, string? Value)[] pairs) =>
        pairs.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);

    [Fact]
    public void RootLinkIsTitledWithTheProductNameAlone()
    {
        var link = SocialMetadata.Compose("/", Query(), Atlas(), 0);

        Assert.Equal("SQL Sim City", link.Title);
        Assert.Null(link.DatabaseName);
        Assert.Equal("/social-card.png", link.CardPath);
    }

    [Fact]
    public void CityLinkIsTitledWithTheNameTheDatabaseReports()
    {
        var query = Query(("view", "city"), ("database", "primary/database/AdventureWorks"));

        var link = SocialMetadata.Compose("/", query, Atlas(("primary/database/AdventureWorks", "AdventureWorks")), 0);

        Assert.Equal("SQL Sim City - AdventureWorks", link.Title);
        Assert.Equal("AdventureWorks", link.DatabaseName);
        Assert.Equal("/social-card.png?database=AdventureWorks", link.CardPath);
    }

    /// <summary>
    /// A <c>database=</c> the app is not currently reading must not rename the link.
    /// </summary>
    [Fact]
    public void DatabaseWithoutCityViewIsIgnored()
    {
        var query = Query(("database", "primary/database/AdventureWorks"));

        Assert.Null(SocialMetadata.ResolveDatabaseName(query, Atlas(("primary/database/AdventureWorks", "AW"))));
    }

    [Fact]
    public void BlankDatabaseIsTreatedAsAbsent()
    {
        Assert.Null(SocialMetadata.ResolveDatabaseName(Query(("view", "city"), ("database", "   ")), Atlas()));
        Assert.Null(SocialMetadata.ResolveDatabaseName(Query(("view", "city"), ("database", null)), Atlas()));
    }

    /// <summary>
    /// The window before the first collection, and links to databases that have since been dropped.
    /// </summary>
    [Fact]
    public void UnknownDatabaseFallsBackToTheIdTail()
    {
        var query = Query(("view", "city"), ("database", "somewhere/database/Ledger"));

        Assert.Equal("Ledger", SocialMetadata.ResolveDatabaseName(query, null));
        Assert.Equal("Ledger", SocialMetadata.ResolveDatabaseName(query, Atlas(("other/database/Sales", "Sales"))));
    }

    [Fact]
    public void SnapshotNameWinsOverTheIdTail()
    {
        var query = Query(("view", "city"), ("database", "primary/database/stale-key"));

        var resolved = SocialMetadata.ResolveDatabaseName(query, Atlas(("primary/database/stale-key", "Reporting")));

        Assert.Equal("Reporting", resolved);
    }

    /// <summary>
    /// Newlines survive HTML escaping and would still split a <c>&lt;meta&gt;</c> line in two.
    /// </summary>
    [Fact]
    public void ControlCharactersAreStrippedFromNames()
    {
        var query = Query(("view", "city"), ("database", "e/database/Sa\r\nles\tOne"));

        Assert.Equal("Sa  les One", SocialMetadata.ResolveDatabaseName(query, null));
    }

    [Fact]
    public void OverlongNamesAreTruncatedRatherThanDrawnOffTheCard()
    {
        var query = Query(("view", "city"), ("database", $"e/database/{new string('x', 400)}"));

        var resolved = SocialMetadata.ResolveDatabaseName(query, null);

        Assert.NotNull(resolved);
        Assert.Equal(96, resolved.Length);
        Assert.EndsWith("\u2026", resolved, StringComparison.Ordinal);
    }

    [Fact]
    public void AttributeEscapingClosesOffTheInjectionRoute()
    {
        var escaped = SocialMetadata.HtmlAttribute("\"><script>alert('x')</script>&");

        Assert.Equal(
            "&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;",
            escaped);
    }

    [Fact]
    public void CardPathEscapesNamesThatWouldOtherwiseBreakTheQueryString()
    {
        Assert.Equal("/social-card.png?database=a%20%26%20b", SocialMetadata.CardPath("a & b"));
    }
}
