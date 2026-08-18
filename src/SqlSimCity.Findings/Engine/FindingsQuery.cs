using System.Buffers.Text;
using System.Globalization;
using System.Text;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Findings.Engine;

/// <summary>Raised when a caller supplies a findings page token that is malformed, out of range, or no longer valid.</summary>
public sealed class FindingsPageTokenException(string message) : Exception(message);

/// <summary>How a findings page is sorted. The default mirrors the engine's own severity-major ordering.</summary>
public enum FindingsSort { SeverityThenImpact, Impact, Confidence, Severity }

/// <summary>
/// A bounded, read-only query over an already-computed, ordered finding list. Every input is clamped:
/// the page size, the offset carried by the opaque token, the number of filter values, and the length
/// of each filter value are all bounded so a hostile caller cannot turn paging or filtering into a DoS
/// (requirement 9). Filtering and sorting are pure and deterministic.
/// </summary>
public static class FindingsQuery
{
    public const int DefaultPageSize = 25;
    public const int MaxPageSize = 100;
    public const int MaxOffset = 100_000;
    public const int MaxFilterValues = 32;
    public const int MaxFilterValueLength = 64;

    public static FindingsPageV1 Page(
        IReadOnlyList<FindingV1> findings,
        DateTimeOffset generatedAt,
        int? pageSize = null,
        string? pageToken = null,
        FindingsSort sort = FindingsSort.SeverityThenImpact,
        IReadOnlyCollection<FindingSeverity>? severities = null,
        IReadOnlyCollection<FindingConfidence>? confidences = null,
        string? ruleId = null,
        string? databaseId = null)
    {
        ArgumentNullException.ThrowIfNull(findings);
        var size = Math.Clamp(pageSize ?? DefaultPageSize, 1, MaxPageSize);
        var offset = DecodeToken(pageToken);
        ValidateFilter(ruleId);
        ValidateFilter(databaseId);
        ValidateFilterSet(severities);
        ValidateFilterSet(confidences);

        IEnumerable<FindingV1> query = findings;
        if (severities is { Count: > 0 })
            query = query.Where(f => severities.Contains(f.Severity));
        if (confidences is { Count: > 0 })
            query = query.Where(f => confidences.Contains(f.Confidence));
        if (!string.IsNullOrEmpty(ruleId))
            query = query.Where(f => string.Equals(f.RuleId, ruleId, StringComparison.Ordinal));
        if (!string.IsNullOrEmpty(databaseId))
            query = query.Where(f => string.Equals(f.Scope.DatabaseId, databaseId, StringComparison.Ordinal));

        var filtered = Sort(query, sort).ToArray();
        if (offset > filtered.Length)
            throw new FindingsPageTokenException("The findings page token is out of range for the current result set.");

        var items = filtered.Skip(offset).Take(size).ToArray();
        var next = offset + items.Length < filtered.Length ? EncodeToken(offset + items.Length) : null;
        return new FindingsPageV1("1.0", items, next, size, filtered.Length, generatedAt);
    }

    private static IEnumerable<FindingV1> Sort(IEnumerable<FindingV1> query, FindingsSort sort) => sort switch
    {
        FindingsSort.Impact => query
            .OrderByDescending(FindingImpact.MagnitudeOf)
            .ThenByDescending(f => (int)f.Severity)
            .ThenBy(f => f.FindingId, StringComparer.Ordinal),
        FindingsSort.Confidence => query
            .OrderByDescending(f => (int)f.Confidence)
            .ThenByDescending(f => (int)f.Severity)
            .ThenByDescending(FindingImpact.MagnitudeOf)
            .ThenBy(f => f.FindingId, StringComparer.Ordinal),
        FindingsSort.Severity => query
            .OrderByDescending(f => (int)f.Severity)
            .ThenBy(f => f.FindingId, StringComparer.Ordinal),
        _ => query
            .OrderByDescending(f => (int)f.Severity)
            .ThenByDescending(f => (int)f.Confidence)
            .ThenByDescending(FindingImpact.MagnitudeOf)
            .ThenBy(f => f.FindingId, StringComparer.Ordinal),
    };

    private static void ValidateFilter(string? value)
    {
        if (value is not null && value.Length > MaxFilterValueLength)
            throw new FindingsPageTokenException("A findings filter value exceeds the maximum allowed length.");
    }

    private static void ValidateFilterSet<T>(IReadOnlyCollection<T>? values)
    {
        if (values is { Count: > MaxFilterValues })
            throw new FindingsPageTokenException("Too many findings filter values were supplied.");
    }

    private static int DecodeToken(string? token)
    {
        if (string.IsNullOrEmpty(token))
            return 0;
        if (token.Length > 64)
            throw new FindingsPageTokenException("The findings page token is too long.");
        Span<byte> buffer = stackalloc byte[48];
        if (!Base64.IsValid(token) || !Convert.TryFromBase64String(token, buffer, out var written))
            throw new FindingsPageTokenException("The findings page token is malformed.");
        var raw = Encoding.UTF8.GetString(buffer[..written]);
        if (!int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var offset) || offset < 0 || offset > MaxOffset)
            throw new FindingsPageTokenException("The findings page token is malformed or out of bounds.");
        return offset;
    }

    private static string EncodeToken(int offset) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(offset.ToString(CultureInfo.InvariantCulture)));
}
