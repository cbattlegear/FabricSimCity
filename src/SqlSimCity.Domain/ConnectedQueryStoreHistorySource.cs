using System.Globalization;
using System.Numerics;
using System.Text;
using System.Text.Json;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Domain;

public sealed class ConnectedQueryStoreHistorySource(
    ProtectedQueryStoreRepository repository,
    IQueryStoreIncrementalSource incrementalSource,
    SecureShowplanParser showplanParser,
    QueryStoreCollectionStatusTracker statusTracker,
    TimeProvider timeProvider) : IQueryStoreHistorySource
{
    public async Task<PageV1<QueryFamilySummaryV1>> GetQueriesAsync(
        string? databaseId,
        string metric,
        int pageSize,
        string? pageToken,
        CancellationToken cancellationToken)
    {
        var snapshot = await repository.ReadPublishedSnapshotAsync(cancellationToken).ConfigureAwait(false);
        if (snapshot is null)
            return Empty(pageSize, "No complete connected Query Store snapshot has been published yet.");

        var cursor = DecodeToken(pageToken);
        if (cursor is not null &&
            (!string.Equals(cursor.SnapshotId, snapshot.SnapshotId, StringComparison.Ordinal) ||
             !string.Equals(cursor.Metric, metric, StringComparison.Ordinal) ||
             !string.Equals(cursor.DatabaseId, databaseId, StringComparison.Ordinal)))
            throw new QueryStorePageTokenException("The Query Store page token is stale or belongs to another filter.");

        var summaries = snapshot.Families.Select(detail => detail.Family)
            .Where(family => databaseId is null ||
                             string.Equals(family.DatabaseId, databaseId, StringComparison.Ordinal))
            .Select(family => new RankedFamily(family, MetricValue(family, metric)))
            .Where(item => cursor is null ||
                item.Value.CompareTo(ExactNumber.Parse(cursor.LastValue)) < 0 ||
                item.Value.CompareTo(ExactNumber.Parse(cursor.LastValue)) == 0 &&
                string.CompareOrdinal(item.Family.FamilyId, cursor.LastFamilyId) > 0)
            .OrderByDescending(item => item.Value)
            .ThenBy(item => item.Family.FamilyId, StringComparer.Ordinal)
            .Take(pageSize + 1)
            .ToArray();
        var hasMore = summaries.Length > pageSize;
        var page = summaries.Take(pageSize).ToArray();
        var last = page.LastOrDefault();
        var next = hasMore && last is not null
            ? EncodeToken(new QueryPageCursor(
                snapshot.SnapshotId, metric, databaseId, last.Value.ToString(), last.Family.FamilyId))
            : null;
        var total = snapshot.Families.Count(detail => databaseId is null ||
            string.Equals(detail.Family.DatabaseId, databaseId, StringComparison.Ordinal));
        return new PageV1<QueryFamilySummaryV1>(
            "1.0", page.Select(item => item.Family).ToArray(), next, pageSize,
            total.ToString(CultureInfo.InvariantCulture))
        {
            Evidence = (snapshot.Families.Count > 0 ? snapshot.Families[0].Family.Evidence : null) ??
                ConnectedEvidence(snapshot.PublishedAt, snapshot.Status.State),
        };
    }

    public async Task<QueryFamilyDetailV1?> GetFamilyAsync(
        string familyId,
        CancellationToken cancellationToken)
    {
        var snapshot = await repository.ReadPublishedSnapshotAsync(cancellationToken).ConfigureAwait(false);
        var detail = snapshot?.Families.SingleOrDefault(
            detail => string.Equals(detail.Family.FamilyId, familyId, StringComparison.Ordinal));
        if (detail is null) return null;
        var physical = new List<PhysicalQueryIdentityV1>(detail.Family.PhysicalQueries.Count);
        foreach (var identity in detail.Family.PhysicalQueries)
        {
            var descriptor = identity.Text;
            if (descriptor.Availability == QueryTextAvailability.Missing)
            {
                var payload = await incrementalSource.ReadQueryTextAsync(
                    identity.DatabaseId, identity.QueryTextId, cancellationToken).ConfigureAwait(false);
                if (payload.Text is not null && !payload.IsEncrypted && !payload.IsRestricted)
                    await repository.StoreQueryTextAsync(
                        identity.DatabaseId, identity.QueryTextId, timeProvider.GetUtcNow(),
                        payload.Text, cancellationToken).ConfigureAwait(false);
                descriptor = SqlTextNormalizer.Normalize(
                    payload.Text, payload.IsEncrypted, payload.IsRestricted,
                    QuotedIdentifiers(identity.Context.SetOptions));
                await repository.StoreTextDescriptorAsync(
                    identity.DatabaseId, identity.QueryTextId, descriptor,
                    timeProvider.GetUtcNow(), cancellationToken).ConfigureAwait(false);
            }
            physical.Add(identity with { Text = descriptor });
        }
        var displayText = physical.Select(item => item.Text)
            .FirstOrDefault(item => item.Availability == QueryTextAvailability.Available) ??
            physical[0].Text;
        var plans = new List<QueryPlanSummaryV1>(detail.Plans.Count);
        foreach (var plan in detail.Plans)
        {
            var normalized = await repository.ReadNormalizedPlanAsync(
                plan.PlanId, cancellationToken).ConfigureAwait(false);
            plans.Add(normalized is null ? plan : plan with { Optimization = normalized.Optimization });
        }
        return detail with
        {
            Family = detail.Family with
            {
                Text = displayText,
                NormalizedTextFingerprint = displayText.NormalizedTextFingerprint,
                PhysicalQueries = physical,
            },
            Plans = plans,
        };
    }

    public async Task<NormalizedShowplanV1?> GetPlanAsync(
        string planId,
        CancellationToken cancellationToken)
    {
        var record = await repository.ReadNormalizedPlanAsync(planId, cancellationToken).ConfigureAwait(false);
        if (record is not null) return record;
        if (planId.StartsWith("archived:", StringComparison.Ordinal)) return null;
        var separator = planId.LastIndexOf(':');
        if (separator <= 0 || separator == planId.Length - 1) return null;
        var databaseId = planId[..separator];
        var rawPlanId = planId[(separator + 1)..];
        var xml = await incrementalSource.ReadPlanXmlAsync(
            databaseId, rawPlanId, cancellationToken).ConfigureAwait(false);
        if (xml is null) return null;
        await repository.StorePlanXmlAsync(
            databaseId, rawPlanId, timeProvider.GetUtcNow(), xml, cancellationToken).ConfigureAwait(false);
        var normalized = await showplanParser.ParseAsync(planId, xml, cancellationToken).ConfigureAwait(false);
        await repository.StoreNormalizedPlanAsync(
            normalized, timeProvider.GetUtcNow(), cancellationToken).ConfigureAwait(false);
        return normalized;
    }

    public async Task<PlanComparisonV1?> ComparePlansAsync(
        string leftPlanId,
        string rightPlanId,
        CancellationToken cancellationToken)
    {
        var left = await GetPlanAsync(leftPlanId, cancellationToken).ConfigureAwait(false);
        var right = await GetPlanAsync(rightPlanId, cancellationToken).ConfigureAwait(false);
        return left is null || right is null ? null : PlanComparer.Compare(left, right);
    }

    public async Task<QueryStoreCollectorStatusV1> GetStatusAsync(CancellationToken cancellationToken)
    {
        var snapshot = await repository.ReadPublishedSnapshotAsync(cancellationToken).ConfigureAwait(false);
        return statusTracker.Current ?? snapshot?.Status ?? new QueryStoreCollectorStatusV1(
            "1.0", QueryStoreCollectorState.Starting, 0, null, null, null, [],
            "Protected storage is ready; the first connected Query Store cycle has not published.");
    }

    private static bool? QuotedIdentifiers(string? setOptions)
    {
        if (string.IsNullOrWhiteSpace(setOptions)) return null;
        var span = setOptions.AsSpan();
        if (span.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) span = span[2..];
        return BigInteger.TryParse(span, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var value)
            ? (value & 64) != 0
            : null;
    }

    private static ExactNumber MetricValue(QueryFamilySummaryV1 family, string metric) =>
        ExactNumber.Parse(metric switch
        {
            "execution" or "executions" => family.ExecutionCount,
            "duration" => family.TotalDurationMicroseconds,
            "reads" => family.TotalLogicalReads8KiBPages,
            "waits" => family.TotalWaitMilliseconds,
            _ => family.TotalCpuMicroseconds,
        });

    private static PageV1<QueryFamilySummaryV1> Empty(int pageSize, string reason) =>
        new("1.0", [], null, pageSize, null)
        {
            Evidence = new QueryStoreEvidenceV1(
                QueryStoreSource.QueryStore, DataStatus.Unknown, null, null, reason,
                "Missing connected history is unavailable, never numeric zero."),
        };

    private static QueryStoreEvidenceV1 ConnectedEvidence(
        DateTimeOffset observedAt,
        QueryStoreCollectorState state) =>
        new(QueryStoreSource.QueryStore,
            state is QueryStoreCollectorState.Partial or QueryStoreCollectorState.Stale
                ? DataStatus.Stale : DataStatus.Available,
            observedAt, observedAt.AddMinutes(3),
            $"Connected Query Store snapshot is {state}.",
            "Compiled plan structure with aggregate query-level runtime; no actual operator metrics.");

    private static string EncodeToken(QueryPageCursor cursor) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(cursor)));

    private static QueryPageCursor? DecodeToken(string? token)
    {
        if (token is null) return null;
        try
        {
            return JsonSerializer.Deserialize<QueryPageCursor>(
                Convert.FromBase64String(token)) ??
                throw new QueryStorePageTokenException("The Query Store page token is malformed.");
        }
        catch (Exception ex) when (ex is FormatException or JsonException)
        {
            throw new QueryStorePageTokenException("The Query Store page token is malformed.");
        }
    }

    private sealed record RankedFamily(QueryFamilySummaryV1 Family, ExactNumber Value);
    private sealed record QueryPageCursor(
        string SnapshotId,
        string Metric,
        string? DatabaseId,
        string LastValue,
        string LastFamilyId);

    private readonly record struct ExactNumber(BigInteger Unscaled, int Scale) : IComparable<ExactNumber>
    {
        public static ExactNumber Parse(string value)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(value);
            var span = value.AsSpan();
            var negative = span[0] == '-';
            if (negative) span = span[1..];
            var point = span.IndexOf('.');
            var scale = point < 0 ? 0 : span.Length - point - 1;
            var digits = point < 0 ? span.ToString() : string.Concat(span[..point], span[(point + 1)..]);
            var unscaled = BigInteger.Parse(digits, CultureInfo.InvariantCulture);
            return new ExactNumber(negative ? -unscaled : unscaled, scale);
        }

        public int CompareTo(ExactNumber other)
        {
            var scale = Math.Max(Scale, other.Scale);
            return (Unscaled * BigInteger.Pow(10, scale - Scale))
                .CompareTo(other.Unscaled * BigInteger.Pow(10, scale - other.Scale));
        }

        public override string ToString()
        {
            var sign = Unscaled.Sign < 0 ? "-" : "";
            var digits = BigInteger.Abs(Unscaled).ToString(CultureInfo.InvariantCulture);
            if (Scale == 0) return sign + digits;
            digits = digits.PadLeft(Scale + 1, '0');
            return $"{sign}{digits[..^Scale]}.{digits[^Scale..]}";
        }
    }
}
