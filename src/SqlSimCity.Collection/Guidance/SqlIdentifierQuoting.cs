namespace SqlSimCity.Collection.Guidance;

/// <summary>
/// A tested, minimal reimplementation of T-SQL's <c>QUOTENAME</c> default (bracket) form, used so
/// every identifier the least-privilege guidance generator writes into a script is safely
/// delimited: any embedded <c>]</c> is doubled so the identifier can never be terminated early by
/// its own content. This module only ever produces text for a human to review -- it does not
/// execute anything.
/// </summary>
public static class SqlIdentifierQuoting
{
    /// <summary>Quotes <paramref name="identifier"/> exactly as <c>QUOTENAME(identifier)</c> would, using <c>[ ]</c>.</summary>
    public static string QuoteBracketIdentifier(string identifier)
    {
        ArgumentNullException.ThrowIfNull(identifier);
        if (identifier.Contains('\0'))
        {
            throw new ArgumentException("Identifiers must not contain NUL characters.", nameof(identifier));
        }

        return "[" + identifier.Replace("]", "]]", StringComparison.Ordinal) + "]";
    }
}
