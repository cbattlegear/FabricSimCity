using System.Text;
using System.Text.RegularExpressions;

namespace SqlSimCity.Collection.Catalog;

/// <summary>
/// A minimal, dependency-free C# port of the comment-stripping and named-parameter-extraction
/// logic in <c>test/lib/sqlGuard.mjs</c>, used so <see cref="ProbeCatalog"/> can validate that
/// every manifest-declared parameter is referenced by its probe file (and vice versa) without
/// shelling out to Node at runtime. The full mutating-token/SELECT-shape guard remains a
/// Node-based CI check only (see <c>test/validate-manifest.test.mjs</c>); this class exists only
/// for the parameter-matching check the .NET loader performs at startup.
/// </summary>
public static partial class SqlTextScanner
{
    [GeneratedRegex(@"(?<!@)@([A-Za-z_][A-Za-z0-9_]*)")]
    private static partial Regex ParameterPattern();

    /// <summary>Strips <c>-- line</c> and <c>/* block */</c> comments, preserving string literal content.</summary>
    public static string StripComments(string sql)
    {
        ArgumentNullException.ThrowIfNull(sql);
        var output = new StringBuilder(sql.Length);
        var i = 0;
        var inString = false;
        var length = sql.Length;

        while (i < length)
        {
            var ch = sql[i];
            var next = i + 1 < length ? sql[i + 1] : '\0';

            if (inString)
            {
                output.Append(ch);
                if (ch == '\'' && next == '\'')
                {
                    output.Append(next);
                    i += 2;
                    continue;
                }

                if (ch == '\'')
                {
                    inString = false;
                }

                i += 1;
                continue;
            }

            if (ch == '\'')
            {
                inString = true;
                output.Append(ch);
                i += 1;
                continue;
            }

            if (ch == '-' && next == '-')
            {
                while (i < length && sql[i] != '\n')
                {
                    i += 1;
                }

                continue;
            }

            if (ch == '/' && next == '*')
            {
                i += 2;
                while (i < length && !(sql[i] == '*' && i + 1 < length && sql[i + 1] == '/'))
                {
                    i += 1;
                }

                i += 2;
                continue;
            }

            output.Append(ch);
            i += 1;
        }

        return output.ToString();
    }

    /// <summary>Extracts the set of named <c>@Parameter</c> placeholders, excluding <c>@@system</c> variables.</summary>
    public static IReadOnlySet<string> ExtractParameterNames(string sql)
    {
        var stripped = StripComments(sql);
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (Match match in ParameterPattern().Matches(stripped))
        {
            names.Add("@" + match.Groups[1].Value);
        }

        return names;
    }
}
