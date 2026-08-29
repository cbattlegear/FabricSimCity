using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace SqlSimCity.Api.Social;

/// <summary>
/// Rewrites the head of the single-page app's document so a link describes what it opens.
/// </summary>
/// <remarks>
/// <para>
/// The shipped <c>index.html</c> is one static file serving every route, which is why every link to
/// this instance previewed identically. This replaces its title and description per request and adds
/// the Open Graph and Twitter tags the preview clients actually read.
/// </para>
/// <para>
/// It rewrites rather than templates because the file is Vite's output: the script and stylesheet
/// tags in it are fingerprinted at build time and must survive untouched. Only the two elements this
/// owns are removed, and the replacements go immediately before <c>&lt;/head&gt;</c>.
/// </para>
/// </remarks>
public static partial class SocialDocument
{
    /// <summary>Card dimensions, declared to the preview clients and produced by the renderer.</summary>
    public const int CardWidth = 1200;

    /// <inheritdoc cref="CardWidth"/>
    public const int CardHeight = 630;

    [GeneratedRegex(@"<title>.*?</title>", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex TitleElement();

    [GeneratedRegex("""<meta\s+name=["']description["'][^>]*>""", RegexOptions.IgnoreCase)]
    private static partial Regex DescriptionElement();

    /// <summary>
    /// Produces the document for one request.
    /// </summary>
    /// <param name="template">The built <c>index.html</c>, verbatim.</param>
    /// <param name="metadata">What this link says about itself.</param>
    /// <param name="canonicalUrl">Absolute URL of the page being described.</param>
    /// <param name="cardUrl">Absolute URL of the card image.</param>
    public static string Render(string template, SocialLink metadata, string canonicalUrl, string cardUrl)
    {
        ArgumentNullException.ThrowIfNull(template);
        ArgumentNullException.ThrowIfNull(metadata);
        ArgumentNullException.ThrowIfNull(canonicalUrl);
        ArgumentNullException.ThrowIfNull(cardUrl);

        var stripped = DescriptionElement().Replace(TitleElement().Replace(template, string.Empty), string.Empty);
        var head = Head(metadata, canonicalUrl, cardUrl);
        var closing = stripped.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);

        // A document with no </head> is not something to guess at. Appending the tags anywhere else
        // would put them where a parser has already opened <body>, where they mean nothing; leaving
        // the document alone at least serves the app.
        return closing < 0 ? stripped : string.Concat(stripped.AsSpan(0, closing), head, stripped.AsSpan(closing));
    }

    private static string Head(SocialLink metadata, string canonicalUrl, string cardUrl)
    {
        var title = SocialMetadata.HtmlAttribute(metadata.Title);
        var description = SocialMetadata.HtmlAttribute(metadata.Description);
        var canonical = SocialMetadata.HtmlAttribute(canonicalUrl);
        var card = SocialMetadata.HtmlAttribute(cardUrl);
        var alt = SocialMetadata.HtmlAttribute(metadata.DatabaseName is null
            ? "The SQL Sim City server atlas, one tower per database."
            : $"The {metadata.DatabaseName} database drawn as a city.");

        var head = new StringBuilder();
        head.Append("\n    <title>").Append(title).Append("</title>\n");
        Meta(head, "name", "description", description);
        Meta(head, "property", "og:type", "website");
        Meta(head, "property", "og:site_name", SocialMetadata.ProductName);
        Meta(head, "property", "og:title", title);
        Meta(head, "property", "og:description", description);
        Meta(head, "property", "og:url", canonical);
        Meta(head, "property", "og:image", card);
        Meta(head, "property", "og:image:type", "image/png");
        Meta(head, "property", "og:image:width", CardWidth.ToString(CultureInfo.InvariantCulture));
        Meta(head, "property", "og:image:height", CardHeight.ToString(CultureInfo.InvariantCulture));
        Meta(head, "property", "og:image:alt", alt);
        Meta(head, "name", "twitter:card", "summary_large_image");
        Meta(head, "name", "twitter:title", title);
        Meta(head, "name", "twitter:description", description);
        Meta(head, "name", "twitter:image", card);
        Meta(head, "name", "twitter:image:alt", alt);
        head.Append("    ");
        return head.ToString();
    }

    private static void Meta(StringBuilder head, string keyAttribute, string key, string content) =>
        head.Append("    <meta ").Append(keyAttribute).Append("=\"").Append(key)
            .Append("\" content=\"").Append(content).Append("\" />\n");
}
