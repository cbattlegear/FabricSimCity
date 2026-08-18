using System.Security.Cryptography;
using System.Text;
using Microsoft.SqlServer.TransactSql.ScriptDom;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.QueryStore;

public static class SqlTextNormalizer
{
    private const int MaximumSqlCharacters = 256 * 1024;

    public static QueryTextDescriptorV1 Normalize(
        string? rawText,
        bool isEncrypted,
        bool isRestricted,
        bool? initialQuotedIdentifiers = true)
    {
        if (isEncrypted)
            return Missing(QueryTextAvailability.Encrypted, "Query text belongs to an encrypted module.");
        if (isRestricted)
            return Missing(QueryTextAvailability.Restricted, "Query Store marks this query text as restricted.");
        if (string.IsNullOrWhiteSpace(rawText))
            return Missing(QueryTextAvailability.Missing, "Query Store returned no query text.");
        if (rawText.Length > MaximumSqlCharacters)
            return Missing(QueryTextAvailability.Missing, "Query text exceeds the safe normalization limit.");
        if (initialQuotedIdentifiers is null && rawText.Contains('"'))
            return Missing(QueryTextAvailability.Missing,
                "Query text contains double quotes but its QUOTED_IDENTIFIER context is unavailable.");

        var parser = new TSql170Parser(initialQuotedIdentifiers ?? true);
        using var reader = new StringReader(rawText);
        var fragment = parser.Parse(reader, out var errors);
        if (errors.Count != 0 || fragment.ScriptTokenStream is null)
            return Missing(QueryTextAvailability.Missing, "SQL text could not be safely normalized by ScriptDom.");

        var normalized = new StringBuilder(rawText.Length);
        foreach (var token in fragment.ScriptTokenStream)
        {
            if (token.TokenType is TSqlTokenType.WhiteSpace or TSqlTokenType.MultilineComment or
                TSqlTokenType.SingleLineComment or TSqlTokenType.EndOfFile) continue;
            if (normalized.Length > 0) normalized.Append(' ');
            normalized.Append(SafeToken(token, initialQuotedIdentifiers ?? true));
        }

        var value = normalized.ToString();
        return new QueryTextDescriptorV1(
            QueryTextAvailability.Available, value, Fingerprint(value),
            "Literals were replaced by the SQL Server 2025 ScriptDom parser; raw SQL remains encrypted.");
    }

    private static string SafeToken(TSqlParserToken token, bool quotedIdentifiers)
    {
        if (token.Text.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) return "0x00";
        if (!quotedIdentifiers && token.Text.Length >= 2 &&
            token.Text[0] == '"' && token.Text[^1] == '"') return "\"?\"";
        return token.TokenType switch
        {
        TSqlTokenType.AsciiStringLiteral => "'?'",
        TSqlTokenType.UnicodeStringLiteral => "N'?'",
        TSqlTokenType.Integer or TSqlTokenType.Numeric or TSqlTokenType.Real or TSqlTokenType.Money => "0",
        _ => token.Text,
        };
    }

    private static QueryTextDescriptorV1 Missing(QueryTextAvailability availability, string reason) =>
        new(availability, null, null, reason);

    private static string Fingerprint(string normalized) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized))).ToLowerInvariant();
}
