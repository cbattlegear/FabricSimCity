using SqlSimCity.Api.Social;

namespace SqlSimCity.Api.Tests;

/// <summary>
/// Covers the rewrite of the single-page app's document head.
/// </summary>
public sealed class SocialDocumentTests
{
    private const string Template = """
        <!doctype html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <meta name="description" content="the old one" />
            <title>SQLSimCity atlas</title>
            <script type="module" crossorigin src="/assets/index-B7f3xQ1a.js"></script>
          </head>
          <body><div id="root"></div></body>
        </html>
        """;

    private static string Render(SocialLink link) =>
        SocialDocument.Render(Template, link, "https://city.example/", "https://city.example/social-card.png");

    private static SocialLink Link(string title = "SQL Sim City", string? database = null) =>
        new(title, "Reticulating splines", SocialMetadata.CardPath(database), database);

    [Fact]
    public void TitleIsReplacedRatherThanDuplicated()
    {
        var document = Render(Link("SQL Sim City - Ledger", "Ledger"));

        Assert.DoesNotContain("SQLSimCity atlas", document, StringComparison.Ordinal);
        Assert.Equal(1, Occurrences(document, "<title>"));
        Assert.Contains("<title>SQL Sim City - Ledger</title>", document, StringComparison.Ordinal);
    }

    [Fact]
    public void OldDescriptionIsReplacedRatherThanDuplicated()
    {
        var document = Render(Link());

        Assert.DoesNotContain("the old one", document, StringComparison.Ordinal);
        Assert.Equal(1, Occurrences(document, "name=\"description\""));
    }

    /// <summary>
    /// Vite fingerprints these at build time; rewriting the head must not disturb them.
    /// </summary>
    [Fact]
    public void FingerprintedAssetTagsSurvive()
    {
        var document = Render(Link());

        Assert.Contains("/assets/index-B7f3xQ1a.js", document, StringComparison.Ordinal);
        Assert.Contains("<div id=\"root\"></div>", document, StringComparison.Ordinal);
    }

    [Fact]
    public void PreviewClientsGetTheTagsTheyActuallyRead()
    {
        var document = Render(Link("SQL Sim City - Ledger", "Ledger"));

        Assert.Contains("<meta property=\"og:title\" content=\"SQL Sim City - Ledger\" />", document, StringComparison.Ordinal);
        Assert.Contains("<meta property=\"og:image\" content=\"https://city.example/social-card.png\" />", document, StringComparison.Ordinal);
        Assert.Contains("<meta property=\"og:image:width\" content=\"1200\" />", document, StringComparison.Ordinal);
        Assert.Contains("<meta property=\"og:image:height\" content=\"630\" />", document, StringComparison.Ordinal);
        Assert.Contains("<meta name=\"twitter:card\" content=\"summary_large_image\" />", document, StringComparison.Ordinal);
        Assert.Contains("content=\"The Ledger database drawn as a city.\"", document, StringComparison.Ordinal);
    }

    [Fact]
    public void AtlasLinkDescribesItsOwnImage()
    {
        var document = Render(Link());

        Assert.Contains("content=\"The SQL Sim City server atlas, one tower per database.\"", document, StringComparison.Ordinal);
    }

    /// <summary>
    /// The database name reaches the document from the query string, so it is attacker-influenced.
    /// </summary>
    [Fact]
    public void NamesCannotCloseTheAttributeTheySitIn()
    {
        var document = Render(Link("SQL Sim City - \"><script>x</script>", "\"><script>x</script>"));

        Assert.DoesNotContain("<script>x</script>", document, StringComparison.Ordinal);
        Assert.Contains("&quot;&gt;&lt;script&gt;", document, StringComparison.Ordinal);
    }

    [Fact]
    public void TagsGoInsideTheHead()
    {
        var document = Render(Link());

        Assert.True(
            document.IndexOf("og:title", StringComparison.Ordinal) < document.IndexOf("</head>", StringComparison.Ordinal),
            "Open Graph tags must be emitted before the head closes.");
    }

    /// <summary>
    /// Nothing sensible can be added to a document with no head, and serving the app still beats
    /// serving a mangled one.
    /// </summary>
    [Fact]
    public void DocumentWithoutAHeadIsLeftAlone()
    {
        const string fragment = "<html><body>nothing here</body></html>";

        Assert.Equal(fragment, SocialDocument.Render(fragment, Link(), "https://city.example/", "https://city.example/c.png"));
    }

    private static int Occurrences(string haystack, string needle)
    {
        var count = 0;
        var index = haystack.IndexOf(needle, StringComparison.Ordinal);
        while (index >= 0)
        {
            count++;
            index = haystack.IndexOf(needle, index + needle.Length, StringComparison.Ordinal);
        }

        return count;
    }
}
