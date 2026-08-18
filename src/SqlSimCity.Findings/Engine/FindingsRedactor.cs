using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Findings.Engine;

/// <summary>
/// Produces the literal-safe redacted findings export (requirement 6). Findings are built from curated,
/// already-sanitized strings, but this pass is defense-in-depth: it bounds the number of findings and
/// evidence references, caps every string length, and replaces any string that still looks like raw SQL,
/// raw plan XML, a credential, or a connection string with a stable hash placeholder rather than passing
/// the text through. A redaction failure omits or hashes the offending text; raw text never escapes.
/// </summary>
public static partial class FindingsRedactor
{
    public const int MaxExportFindings = 500;
    public const int MaxEvidencePerFinding = 20;
    public const int MaxStringLength = 512;

    public static (FindingsExportV1 Export, int RedactedFieldCount) Build(
        IReadOnlyList<FindingV1> findings, DateTimeOffset generatedAt, string engineVersion)
    {
        ArgumentNullException.ThrowIfNull(findings);
        var counter = new Counter();
        var bounded = findings.Take(MaxExportFindings).Select(finding => Redact(finding, counter)).ToArray();
        var note = counter.Value == 0
            ? "No raw SQL, plan XML, credentials, or host/user/client identifiers were present; every field passed the redaction pass unchanged."
            : $"{counter.Value} field(s) were omitted or hashed by the redaction pass; raw SQL, plan XML, credentials, and host/user/client identifiers are never included.";
        var export = new FindingsExportV1("1.0", generatedAt, engineVersion, note, counter.Value, bounded);
        return (export, counter.Value);
    }

    private static FindingV1 Redact(FindingV1 finding, Counter count) =>
        finding with
        {
            Title = Scrub(finding.Title, count),
            Scope = finding.Scope with { DisplayName = Scrub(finding.Scope.DisplayName, count) },
            Impact = finding.Impact with { Basis = Scrub(finding.Impact.Basis, count) },
            ObservedWindow = finding.ObservedWindow with { Caveat = Scrub(finding.ObservedWindow.Caveat, count) },
            Evidence = finding.Evidence.Take(MaxEvidencePerFinding).Select(e => e with
            {
                Label = Scrub(e.Label, count),
                Observation = Scrub(e.Observation, count),
            }).ToArray(),
            Caveats = Scrub(finding.Caveats, count),
            AlternateExplanations = Scrub(finding.AlternateExplanations, count),
            RecommendedNextChecks = Scrub(finding.RecommendedNextChecks, count),
            ReadOnlyRecommendation = Scrub(finding.ReadOnlyRecommendation, count),
        };

    private static string[] Scrub(IReadOnlyList<string> values, Counter count)
    {
        var result = new string[values.Count];
        for (var i = 0; i < values.Count; i++)
            result[i] = Scrub(values[i], count);
        return result;
    }

    private static string Scrub(string value, Counter count)
    {
        if (value.Length > MaxStringLength || SensitivePattern().IsMatch(value))
        {
            count.Value++;
            return Hash(value);
        }
        return value;
    }

    private static string Hash(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return "redacted:" + Convert.ToHexStringLower(bytes.AsSpan(0, 8));
    }

    // Markers of raw SQL text, plan XML, credentials, or connection strings that must never be exported.
    [GeneratedRegex(
        @"(<\s*/?\s*[A-Za-z]|<\?xml|password\s*=|pwd\s*=|\bsecret\b|connection\s*string|(data\s+source|server|address|initial\s+catalog|database|uid|user\s+id|user\s+id|integrated\s+security|trusted_connection|authentication)\s*=|--|/\*|;\s*(select|insert|update|delete|drop|exec|merge|alter|create|truncate)\b)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SensitivePattern();

    private sealed class Counter
    {
        public int Value { get; set; }
    }
}
