using System.Xml;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.Findings.Engine;

namespace SqlSimCity.Findings.Evidence;

/// <summary>
/// The default <see cref="IFindingsEvidenceProvider"/>. It assembles a bundle from the registered
/// atlas, Query Store history, capability, and (optionally) live-incident sources, exactly as a human
/// would by opening each tab. It is bounded: it pages a small number of top families per ranking metric,
/// deduplicates them, loads detail only for that bounded set, and loads at most a capped number of
/// Showplans. It therefore stays bounded even against a 100k-family target, and it never opens its own
/// SQL connection -- it consumes whatever the already-wired sources return.
/// </summary>
public sealed class SourceBackedFindingsEvidenceProvider : IFindingsEvidenceProvider
{
    private const int FamiliesPerMetricPage = 50;

    private readonly IAtlasSnapshotSource _atlas;
    private readonly IQueryStoreHistorySource _queryStore;
    private readonly ICapabilitiesSource _capabilities;
    private readonly Func<LiveIncidentSnapshotV1?> _liveSnapshot;
    private readonly TimeProvider _timeProvider;
    private readonly FindingsEvidenceOptions _options;

    public SourceBackedFindingsEvidenceProvider(
        IAtlasSnapshotSource atlas,
        IQueryStoreHistorySource queryStore,
        ICapabilitiesSource capabilities,
        Func<LiveIncidentSnapshotV1?> liveSnapshot,
        TimeProvider timeProvider,
        FindingsEvidenceOptions? options = null)
    {
        _atlas = atlas ?? throw new ArgumentNullException(nameof(atlas));
        _queryStore = queryStore ?? throw new ArgumentNullException(nameof(queryStore));
        _capabilities = capabilities ?? throw new ArgumentNullException(nameof(capabilities));
        _liveSnapshot = liveSnapshot ?? throw new ArgumentNullException(nameof(liveSnapshot));
        _timeProvider = timeProvider ?? throw new ArgumentNullException(nameof(timeProvider));
        _options = options ?? new FindingsEvidenceOptions();
        _options.Validate();
    }

    public async Task<FindingsEvidenceBundle> GetBundleAsync(CancellationToken cancellationToken)
    {
        var generatedAt = _timeProvider.GetUtcNow();
        var atlas = _atlas.GetCurrent();
        var capabilities = SafeCapabilities();
        var live = _liveSnapshot();
        var status = await _queryStore.GetStatusAsync(cancellationToken).ConfigureAwait(false);

        var familyIds = await SelectTopFamilyIdsAsync(cancellationToken).ConfigureAwait(false);
        var families = new List<QueryFamilyDetailV1>(familyIds.Count);
        foreach (var familyId in familyIds)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (await _queryStore.GetFamilyAsync(familyId, cancellationToken).ConfigureAwait(false) is { } detail)
                families.Add(detail);
        }

        var plans = await LoadPlansAsync(families, cancellationToken).ConfigureAwait(false);

        var reason = families.Count == 0
            ? "No Query Store families were available; findings rest on atlas, capability, and live evidence only."
            : $"Bounded evaluation over the top {families.Count} query families (cap {_options.MaxFamilies}) plus atlas, capability, and live evidence.";
        if (plans.Skipped.Count > 0)
        {
            // Disclosed rather than silently dropped: a plan that cannot be normalized is missing
            // evidence, and the Showplan rules must not be read as if it had been examined.
            reason +=
                $" {plans.Skipped.Count} Showplan(s) could not be normalized and were excluded from Showplan rules: " +
                string.Join("; ", plans.Skipped.Take(3)) +
                (plans.Skipped.Count > 3 ? "; …" : string.Empty);
        }

        return new FindingsEvidenceBundle(
            atlas.Target.TargetId,
            atlas.Target.DisplayName,
            generatedAt,
            capabilities,
            atlas,
            live,
            status,
            families,
            plans.Plans,
            reason);
    }

    private CapabilitiesSnapshotV1? SafeCapabilities()
    {
        try { return _capabilities.GetCurrent(); }
        catch (NotSupportedException) { return null; }
    }

    private async Task<IReadOnlyList<string>> SelectTopFamilyIdsAsync(CancellationToken cancellationToken)
    {
        // Page a bounded number of top families per ranking metric and union them. This is the bounded
        // projection: it never enumerates the whole store, only the highest-impact candidates.
        var ordered = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var metric in _options.Metrics)
        {
            cancellationToken.ThrowIfCancellationRequested();
            PageV1<QueryFamilySummaryV1> page;
            try
            {
                page = await _queryStore.GetQueriesAsync(null, metric, FamiliesPerMetricPage, null, cancellationToken).ConfigureAwait(false);
            }
            catch (QueryStorePageTokenException) { continue; }

            foreach (var summary in page.Items)
            {
                if (ordered.Count >= _options.MaxFamilies)
                    return ordered;
                if (seen.Add(summary.FamilyId))
                    ordered.Add(summary.FamilyId);
            }
        }
        return ordered;
    }

    /// <summary>The plans that loaded, and a reason for every plan that could not be normalized.</summary>
    private sealed record PlanLoad(IReadOnlyList<NormalizedShowplanV1> Plans, IReadOnlyList<string> Skipped);

    private async Task<PlanLoad> LoadPlansAsync(
        IReadOnlyList<QueryFamilyDetailV1> families, CancellationToken cancellationToken)
    {
        if (_options.MaxPlans == 0)
            return new PlanLoad([], []);
        var planIds = families
            .SelectMany(family => family.Plans.Select(plan => plan.PlanId))
            .Distinct(StringComparer.Ordinal)
            .Take(_options.MaxPlans)
            .ToArray();
        var plans = new List<NormalizedShowplanV1>(planIds.Length);
        var skipped = new List<string>();
        foreach (var planId in planIds)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                if (await _queryStore.GetPlanAsync(planId, cancellationToken).ConfigureAwait(false) is { } plan)
                    plans.Add(plan);
            }
            // One unusable Showplan -- oversized, malformed, or unreadable -- must never take down the
            // whole findings evaluation. Every other source in the bundle is still valid evidence.
            catch (XmlException ex)
            {
                skipped.Add($"{planId}: {ex.Message}");
            }
            catch (InvalidDataException ex)
            {
                skipped.Add($"{planId}: {ex.Message}");
            }
        }
        return new PlanLoad(plans, skipped);
    }
}
