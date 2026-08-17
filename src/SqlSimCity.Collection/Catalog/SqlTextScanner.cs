using System.Text;
using System.Text.RegularExpressions;

namespace SqlSimCity.Collection.Catalog;

/// <summary>
/// Dependency-free runtime port of <c>test/lib/sqlGuard.mjs</c>. It strips comments, validates
/// named parameters, rejects mutating/dynamic SQL, and permits only documented session SETs plus
/// static SELECT/CTE result paths.
/// </summary>
public static partial class SqlTextScanner
{
    [GeneratedRegex(@"(?<!@)@([A-Za-z_][A-Za-z0-9_]*)")]
    private static partial Regex ParameterPattern();

    [GeneratedRegex(@"\b(ALTER|DBCC|EXEC|EXECUTE|INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|DROP|GRANT|DENY|REVOKE|USE)\b", RegexOptions.IgnoreCase)]
    private static partial Regex ForbiddenStatementPattern();

    [GeneratedRegex(@"\b(OPENROWSET|OPENQUERY|OPENDATASOURCE|sp_executesql|sp_query_store_\w+|xp_cmdshell)\b", RegexOptions.IgnoreCase)]
    private static partial Regex ForbiddenFacilityPattern();

    [GeneratedRegex(@"QUERY_STORE\s*(CLEAR|=\s*OFF)", RegexOptions.IgnoreCase)]
    private static partial Regex QueryStoreMutationPattern();

    [GeneratedRegex(@"\bSELECT\b(?:(?!\bFROM\b)[\s\S])*?\bINTO\b", RegexOptions.IgnoreCase)]
    private static partial Regex SelectIntoPattern();

    [GeneratedRegex(@"^SET\s+(NOCOUNT\s+ON|DEADLOCK_PRIORITY\s+LOW|LOCK_TIMEOUT\s+\d+)\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex SafeSetPattern();

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

    public static IReadOnlyList<string> ValidateReadOnlyShape(string sql)
    {
        var stripped = StripComments(sql);
        var errors = new List<string>();
        if (ForbiddenStatementPattern().IsMatch(stripped))
        {
            errors.Add("contains a mutating or dynamic statement keyword");
        }
        if (ForbiddenFacilityPattern().IsMatch(stripped))
        {
            errors.Add("contains a dynamic or external SQL facility");
        }
        if (QueryStoreMutationPattern().IsMatch(stripped))
        {
            errors.Add("contains Query Store maintenance");
        }
        if (SelectIntoPattern().IsMatch(stripped))
        {
            errors.Add("contains SELECT INTO");
        }

        var statements = stripped.Split(';', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        var sawResult = false;
        foreach (var statement in statements)
        {
            var firstWord = Regex.Match(statement, @"^\s*([A-Za-z_]+)").Groups[1].Value;
            if (firstWord.Equals("SET", StringComparison.OrdinalIgnoreCase))
            {
                if (!SafeSetPattern().IsMatch(statement))
                {
                    errors.Add($"contains undocumented SET statement '{statement}'");
                }
                continue;
            }

            if (firstWord.Equals("SELECT", StringComparison.OrdinalIgnoreCase) ||
                firstWord.Equals("WITH", StringComparison.OrdinalIgnoreCase))
            {
                sawResult = true;
                continue;
            }

            errors.Add($"contains unsafe top-level statement shape '{firstWord}'");
        }

        if (!sawResult)
        {
            errors.Add("contains no SELECT/CTE result path");
        }

        return errors;
    }
}
