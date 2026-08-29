using System.Text;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Api.Social;

/// <summary>
/// What one link to this instance says about itself when it is pasted somewhere.
/// </summary>
/// <param name="Title">The document title, and the card headline.</param>
/// <param name="Description">The card's second line.</param>
/// <param name="CardPath">Relative path of the card image, query string included.</param>
/// <param name="DatabaseName">The database this link opens, or <see langword="null"/> for the atlas.</param>
public sealed record SocialLink(string Title, string Description, string CardPath, string? DatabaseName);

/// <summary>
/// Builds the <c>og:</c> metadata for a request, from the request alone plus the current atlas.
/// </summary>
/// <remarks>
/// <para>
/// This exists on the server because the clients that read it do not run scripts. Discord, Slack,
/// iMessage, Teams and every crawler behind them fetch the HTML and read the <c>&lt;head&gt;</c> as
/// delivered; a title set by React after hydration is set long after the only reader that mattered
/// has gone. That is why the shared link in the issue read "SQLSimCity atlas" no matter which
/// database it opened -- the SPA's one static <c>index.html</c> is the whole of what a crawler ever
/// saw.
/// </para>
/// <para>
/// Everything here is a pure function of the request and a snapshot, so the interesting cases are
/// unit tests rather than something to be confirmed by pasting links into a chat client.
/// </para>
/// </remarks>
public static class SocialMetadata
{
    /// <summary>The product name as it is meant to be read aloud, spaces and all.</summary>
    public const string ProductName = "SQL Sim City";

    /// <summary>Fallback description, used only when there is no seed to pick a saying with.</summary>
    public const string FallbackDescription =
        "A city built from SQL Server evidence, with nothing invented to fill the gaps.";

    /// <summary>
    /// Composes the metadata for one request.
    /// </summary>
    /// <param name="path">Request path, used only to keep the card URL under the same origin.</param>
    /// <param name="query">The request's query string, already decoded.</param>
    /// <param name="atlas">
    /// The current snapshot, or <see langword="null"/> when none has been collected yet. Used to turn
    /// a database id into the name that database actually reports.
    /// </param>
    /// <param name="seed">Chooses the saying. See <see cref="SocialCardSayings.Pick"/>.</param>
    public static SocialLink Compose(
        string path,
        IReadOnlyDictionary<string, string?> query,
        AtlasSnapshotV1? atlas,
        long seed)
    {
        ArgumentNullException.ThrowIfNull(path);
        ArgumentNullException.ThrowIfNull(query);

        var databaseName = ResolveDatabaseName(query, atlas);
        var title = databaseName is null ? ProductName : $"{ProductName} - {databaseName}";
        return new SocialLink(title, SocialCardSayings.Pick(seed), CardPath(databaseName), databaseName);
    }

    /// <summary>
    /// The name of the database a link opens, or <see langword="null"/> when it opens the atlas.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Two conditions, both required. <c>view=city</c> is what the app itself reads to decide it is
    /// showing a city, so a <c>database=</c> left behind in the URL by something else does not rename
    /// a link that opens the atlas.
    /// </para>
    /// <para>
    /// The name is looked up in the snapshot rather than parsed out of the id wherever the snapshot
    /// can answer, because the id is a composed key (<c>endpoint/database/Name</c>) and the atlas is
    /// the thing that knows what the database calls itself. Parsing is the fallback for the window
    /// before the first collection lands, and it is a fallback rather than the rule so that a link to
    /// a database this instance cannot see is not answered with a confident name for it.
    /// </para>
    /// </remarks>
    public static string? ResolveDatabaseName(
        IReadOnlyDictionary<string, string?> query,
        AtlasSnapshotV1? atlas)
    {
        ArgumentNullException.ThrowIfNull(query);
        if (!query.TryGetValue("view", out var view) || !string.Equals(view, "city", StringComparison.Ordinal))
        {
            return null;
        }

        if (!query.TryGetValue("database", out var databaseId) || string.IsNullOrWhiteSpace(databaseId))
        {
            return null;
        }

        var known = atlas?.Databases
            .FirstOrDefault(database => string.Equals(database.DatabaseId, databaseId, StringComparison.Ordinal));
        if (known is not null)
        {
            return Sanitize(known.Name);
        }

        var separator = databaseId.LastIndexOf("/database/", StringComparison.Ordinal);
        var tail = separator >= 0 ? databaseId[(separator + "/database/".Length)..] : databaseId;
        return string.IsNullOrWhiteSpace(tail) ? null : Sanitize(tail);
    }

    /// <summary>Relative URL of the card image for a link, atlas or city.</summary>
    public static string CardPath(string? databaseName) =>
        databaseName is null
            ? "/social-card.png"
            : $"/social-card.png?database={Uri.EscapeDataString(databaseName)}";

    /// <summary>
    /// Trims a name to something that fits a card and cannot carry control characters into markup.
    /// </summary>
    /// <remarks>
    /// The escaping that makes this safe in HTML is <see cref="HtmlAttribute"/>'s job, not this one.
    /// What this removes is the class of character that survives escaping and still breaks the
    /// output: newlines, tabs and C0 controls, which SQL Server permits in a quoted identifier and
    /// which would otherwise be drawn onto an image as a blank or split a <c>&lt;meta&gt;</c> line.
    /// </remarks>
    private static string Sanitize(string value)
    {
        var cleaned = new StringBuilder(value.Length);
        foreach (var character in value)
        {
            cleaned.Append(char.IsControl(character) ? ' ' : character);
        }

        var trimmed = cleaned.ToString().Trim();
        const int limit = 96;
        return trimmed.Length <= limit ? trimmed : string.Concat(trimmed.AsSpan(0, limit - 1).TrimEnd(), "\u2026");
    }

    /// <summary>
    /// Escapes a value for use inside a double-quoted HTML attribute.
    /// </summary>
    /// <remarks>
    /// Hand-written because this runs over raw <c>index.html</c> bytes rather than through a view
    /// engine, and because the value is a database name -- operator-supplied text arriving from the
    /// query string, which is exactly the input that must not be able to close the attribute it sits
    /// in. Both quote forms are escaped even though only one is used as the delimiter, so the helper
    /// stays correct if the surrounding markup ever changes.
    /// </remarks>
    public static string HtmlAttribute(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        var escaped = new StringBuilder(value.Length + 16);
        foreach (var character in value)
        {
            switch (character)
            {
                case '&': escaped.Append("&amp;"); break;
                case '<': escaped.Append("&lt;"); break;
                case '>': escaped.Append("&gt;"); break;
                case '"': escaped.Append("&quot;"); break;
                case '\'': escaped.Append("&#39;"); break;
                default: escaped.Append(character); break;
            }
        }

        return escaped.ToString();
    }
}
