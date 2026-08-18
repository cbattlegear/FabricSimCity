using System.Collections.ObjectModel;
using System.Globalization;
using System.Numerics;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Collection.DatabaseCity;

/// <summary>
/// One catalog object on the current bounded city page, in the shape the plan-attribution join
/// needs: the contract id exposure is attributed to, and the schema-qualified name a normalized
/// showplan object reference is matched against.
/// </summary>
public sealed record CityAttributionObject(
    string ObjectId,
    string SchemaName,
    string ObjectName,
    DatabaseObjectKind Kind);

/// <summary>
/// The joined result. <see cref="ExposureByObjectId"/> only contains objects that at least one
/// single-object plan named; an absent object has no attributed exposure evidence, which is not
/// the same as zero exposure.
/// </summary>
public sealed record CityAttributionResult(
    IReadOnlyList<DatabaseCityQueryEvidence> Families,
    DatabaseCityWorkloadAggregateV1 OtherWorkload,
    IReadOnlyList<DatabaseCityRouteV1> Routes,
    IReadOnlyDictionary<string, DatabaseCityAttributedExposureV1> ExposureByObjectId,
    EvidenceV1 Evidence);

/// <summary>
/// Joins Query Store query families to the catalog objects of a bounded database-city page by
/// reading each family's normalized compiled plans and resolving their showplan object references.
/// <para>
/// The join never guesses. A plan that names several objects keeps its totals at query level and
/// is never divided between them, and never handed whole to whichever object happens to be on this
/// page. A reference that names a real object outside the current page is reported as off-page
/// rather than dropped, and a reference that names another database becomes a cross-database route
/// instead of local exposure.
/// </para>
/// </summary>
public sealed class QueryStoreCityAttribution(IQueryStoreHistorySource queryStore)
{
    /// <summary>Families requested per page, matching the fixture city's top-N.</summary>
    public const int DefaultTopFamilyCount = 12;

    /// <summary>Compiled plans hydrated for one family before the rest are disclosed as skipped.</summary>
    public const int MaxPlansPerFamily = 8;

    /// <summary>Compiled plans hydrated for one page across every family.</summary>
    public const int MaxPlansPerPage = 96;

    private static readonly EvidenceV1 UnavailableEvidence = new(
        EvidenceSource.NotProbed, DataStatus.Unknown, null, null,
        "No Query Store history source is available for this page, so no plan attribution was attempted.");

    /// <param name="databaseName">
    /// The SQL database name. It is both the key connected Query Store history is collected and
    /// indexed under, and the name a three-part showplan reference is matched against to decide
    /// whether it stays local. It is deliberately not the atlas contract id the city page is
    /// addressed by: that id matches no published Query Store index set, which would silently
    /// unattribute every object on the page.
    /// </param>
    public async Task<CityAttributionResult> AttributeAsync(
        string databaseName,
        DatabaseCityMetric metric,
        IReadOnlyList<CityAttributionObject> pageObjects,
        IReadOnlyDictionary<string, string> databaseIdsByName,
        int topFamilyCount,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databaseName);
        ArgumentNullException.ThrowIfNull(pageObjects);
        ArgumentNullException.ThrowIfNull(databaseIdsByName);
        if (topFamilyCount is < 1 or > 100)
            throw new ArgumentOutOfRangeException(nameof(topFamilyCount));

        PageV1<QueryFamilySummaryV1> page;
        try
        {
            page = await queryStore.GetQueriesAsync(
                databaseName, MetricToken(metric), topFamilyCount, null, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception) when (exception is ProbeExecutionException or InvalidDataException)
        {
            return Unavailable(new EvidenceV1(
                EvidenceSource.QueryStoreAggregate, DataStatus.Unknown, null, null,
                $"Query Store history could not be read for this page: {exception.Message}"));
        }

        var pageEvidence = ToEvidence(page.Evidence);
        if (page.Items.Count == 0)
            return Unavailable(pageEvidence);

        var index = new PageObjectIndex(pageObjects, databaseName, databaseIdsByName);
        var families = new List<DatabaseCityQueryEvidence>(page.Items.Count);
        var exposureEligible = new List<DatabaseCityQueryEvidence>(page.Items.Count);
        var routes = new RouteAccumulator(pageEvidence);
        var planBudget = MaxPlansPerPage;

        foreach (var summary in page.Items)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var resolved = await AttributeFamilyAsync(
                summary, index, routes, planBudget, cancellationToken).ConfigureAwait(false);
            planBudget -= resolved.PlansHydrated;
            families.Add(resolved.Family);
            if (resolved.ExposureEligible)
                exposureEligible.Add(resolved.Family);
        }

        return new CityAttributionResult(
            families,
            OtherWorkload(page, families.Count, pageEvidence),
            routes.Build(),
            BuildExposure(families, exposureEligible, index, pageEvidence),
            pageEvidence);
    }

    private async Task<ResolvedFamily> AttributeFamilyAsync(
        QueryFamilySummaryV1 summary,
        PageObjectIndex index,
        RouteAccumulator routes,
        int planBudget,
        CancellationToken cancellationToken)
    {
        QueryFamilyDetailV1? detail = null;
        try
        {
            detail = await queryStore.GetFamilyAsync(summary.FamilyId, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception) when (exception is ProbeExecutionException or InvalidDataException)
        {
            return new ResolvedFamily(Unattributed(summary, ReadOnlyDictionary<string, string>.Empty,
                $"Query Store detail for this family could not be read: {exception.Message}"), 0);
        }

        if (detail is null)
        {
            return new ResolvedFamily(Unattributed(summary, ReadOnlyDictionary<string, string>.Empty,
                "Query Store no longer holds detail for this family, so no plan named any object."), 0);
        }

        var counters = detail.Family;
        var waits = WaitCategories(detail, counters.TotalWaitMilliseconds);
        var local = new SortedSet<string>(StringComparer.Ordinal);
        var offPage = new SortedSet<string>(StringComparer.Ordinal);
        var crossDatabase = new SortedSet<string>(StringComparer.Ordinal);
        var unresolved = new SortedSet<string>(StringComparer.Ordinal);
        var hydrated = 0;
        var skipped = 0;
        var unreadable = 0;

        foreach (var plan in detail.Plans.OrderBy(item => item.PlanId, StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (hydrated >= MaxPlansPerFamily || hydrated >= planBudget) { skipped++; continue; }
            NormalizedShowplanV1? showplan;
            try
            {
                showplan = await queryStore.GetPlanAsync(plan.PlanId, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception) when (exception is ProbeExecutionException or InvalidDataException)
            {
                unreadable++;
                continue;
            }

            hydrated++;
            if (showplan is null) { unreadable++; continue; }

            var planLocal = new SortedSet<string>(StringComparer.Ordinal);
            var planRemote = new SortedSet<string>(StringComparer.Ordinal);
            foreach (var node in showplan.Nodes)
            {
                if (node.ObjectReference is not { } reference) continue;
                switch (index.Resolve(reference))
                {
                    case { Kind: ReferenceKind.OnPage, Value: { } onPage }:
                        planLocal.Add(onPage);
                        break;
                    case { Kind: ReferenceKind.OffPage, Value: { } name }:
                        offPage.Add(name);
                        break;
                    case { Kind: ReferenceKind.CrossDatabase, Value: { } remote }:
                        planRemote.Add(remote);
                        break;
                    case { Kind: ReferenceKind.Unresolvable, Value: { } unnamed }:
                        unresolved.Add(unnamed);
                        break;
                    default:
                        break;
                }
            }

            local.UnionWith(planLocal);
            crossDatabase.UnionWith(planRemote);
            routes.AddPlan(planLocal, planRemote);
        }

        var objectIds = local.Concat(crossDatabase).ToArray();
        var namedElsewhere = offPage.Count + crossDatabase.Count + unresolved.Count;
        var confidence = Confidence(local, namedElsewhere, index);
        var rationale = Rationale(local, offPage, crossDatabase, unresolved, index, hydrated, skipped, unreadable);
        return new ResolvedFamily(
            new DatabaseCityQueryEvidence(
                counters.FamilyId,
                counters.QueryHash,
                counters.ExecutionCount,
                counters.TotalCpuMicroseconds,
                counters.TotalDurationMicroseconds,
                counters.TotalLogicalReads8KiBPages,
                counters.TotalWaitMilliseconds,
                objectIds,
                confidence,
                rationale)
            {
                WaitMillisecondsByCategory = waits,
            },
            hydrated,
            // Totals belong to one building only when the plans named that building and nothing
            // else at all: not another page, not another database, not something unresolvable.
            ExposureEligible: local.Count == 1 && namedElsewhere == 0);
    }

    /// <summary>
    /// Sums the family's retained runtime buckets per verbatim <c>wait_category_desc</c>. The
    /// breakdown is published only when it reconciles exactly with the family's total wait
    /// milliseconds; otherwise it is withheld as "not captured" rather than shown as a partial
    /// account of where the waiting happened.
    /// </summary>
    private static ReadOnlyDictionary<string, string> WaitCategories(
        QueryFamilyDetailV1 detail,
        string totalWaitMilliseconds)
    {
        var totals = new SortedDictionary<string, BigInteger>(StringComparer.Ordinal);
        foreach (var bucket in detail.Runtime)
        {
            foreach (var (category, milliseconds) in bucket.WaitMilliseconds)
            {
                if (!BigInteger.TryParse(
                        milliseconds, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed))
                    return ReadOnlyDictionary<string, string>.Empty;
                totals[category] = totals.GetValueOrDefault(category) + parsed;
            }
        }

        if (totals.Count == 0) return ReadOnlyDictionary<string, string>.Empty;
        if (!BigInteger.TryParse(
                totalWaitMilliseconds, NumberStyles.None, CultureInfo.InvariantCulture, out var expected) ||
            totals.Values.Aggregate(BigInteger.Zero, (sum, value) => sum + value) != expected)
            return ReadOnlyDictionary<string, string>.Empty;

        return new ReadOnlyDictionary<string, string>(totals.ToDictionary(
            entry => entry.Key,
            entry => entry.Value.ToString(CultureInfo.InvariantCulture),
            StringComparer.Ordinal));
    }

    private static QueryAttributionConfidence Confidence(
        SortedSet<string> local,
        int namedElsewhere,
        PageObjectIndex index)
    {
        if (local.Count == 0) return QueryAttributionConfidence.Unknown;
        if (local.Count > 1 || namedElsewhere > 0) return QueryAttributionConfidence.Probable;
        // A single reference to an indexed view is not confirmation that the work happened there:
        // the optimizer can expand the view over its base tables, or match it into an unrelated query.
        return index.KindOf(local.Min!) == DatabaseObjectKind.IndexedView
            ? QueryAttributionConfidence.Probable
            : QueryAttributionConfidence.Confirmed;
    }

    private static string Rationale(
        SortedSet<string> local,
        SortedSet<string> offPage,
        SortedSet<string> crossDatabase,
        SortedSet<string> unresolved,
        PageObjectIndex index,
        int hydrated,
        int skipped,
        int unreadable)
    {
        var parts = new List<string>(6);
        if (local.Count == 0 && crossDatabase.Count == 0)
        {
            parts.Add(hydrated == 0
                ? "No compiled plan could be read for this family, so no object reference was available."
                : $"{Plans(hydrated)} named no object on this page; workload remains unattributed.");
        }
        else if (local.Count == 1 && crossDatabase.Count == 0)
        {
            parts.Add(index.KindOf(local.Min!) == DatabaseObjectKind.IndexedView
                ? $"A normalized compiled plan names exactly one local object, the indexed view {index.NameOf(local.Min!)}; optimizer expansion remains a caveat, so the reference is probable rather than confirmed."
                : $"A normalized compiled plan names exactly one local object, {index.NameOf(local.Min!)}.");
        }
        else
        {
            parts.Add(
                $"Normalized plans name {(local.Count + crossDatabase.Count).ToString(CultureInfo.InvariantCulture)} objects; totals remain query-level and are not divided between them or assigned to any one of them.");
        }

        if (offPage.Count > 0)
        {
            parts.Add(
                $"{offPage.Count.ToString(CultureInfo.InvariantCulture)} referenced object(s) exist in this database but are outside the current page and are not shown as buildings: {string.Join(", ", offPage)}.");
        }

        if (crossDatabase.Count > 0)
            parts.Add($"{crossDatabase.Count.ToString(CultureInfo.InvariantCulture)} reference(s) name another database.");
        if (unresolved.Count > 0)
        {
            parts.Add(
                $"{unresolved.Count.ToString(CultureInfo.InvariantCulture)} reference(s) name a database this target's atlas does not hold and were not resolved to any city: {string.Join(", ", unresolved)}.");
        }

        if (skipped > 0)
            parts.Add($"{skipped.ToString(CultureInfo.InvariantCulture)} further compiled plan(s) were not read under this page's hydration budget, so the reference set may be incomplete.");
        if (unreadable > 0)
            parts.Add($"{unreadable.ToString(CultureInfo.InvariantCulture)} compiled plan(s) could not be read.");
        return string.Join(" ", parts);
    }

    private static string Plans(int count) => count == 1
        ? "The one compiled plan read for this family"
        : $"The {count.ToString(CultureInfo.InvariantCulture)} compiled plans read for this family";

    /// <summary>
    /// Attributes a family's totals to an object only when its plans named that object and nothing
    /// else at all. Families that also named an off-page object, another database, or an
    /// unresolvable reference are excluded rather than split by an invented ratio.
    /// <para>
    /// Excluded is not the same as hidden. A multi-object family still reaches the map as a route
    /// between the objects it named and as a shared wait lane threaded through them, both carrying
    /// its figures whole. Only this scalar per-object total refuses it, because folding it in here
    /// would require a per-object share that Query Store never measured. The rationale therefore
    /// says how many such families named the object, so the reader knows where to look for them.
    /// </para>
    /// </summary>
    private static ReadOnlyDictionary<string, DatabaseCityAttributedExposureV1> BuildExposure(
        IReadOnlyList<DatabaseCityQueryEvidence> allFamilies,
        IReadOnlyList<DatabaseCityQueryEvidence> families,
        PageObjectIndex index,
        EvidenceV1 evidence)
    {
        var sharedCounts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var family in allFamilies)
        {
            if (family.ObjectIds.Count <= 1) continue;
            foreach (var objectId in family.ObjectIds)
            {
                if (!index.IsOnPage(objectId)) continue;
                sharedCounts[objectId] = sharedCounts.GetValueOrDefault(objectId) + 1;
            }
        }

        var totals = new Dictionary<string, ExposureTotals>(StringComparer.Ordinal);
        foreach (var family in families)
        {
            if (family.ObjectIds.Count != 1) continue;
            var objectId = family.ObjectIds[0];
            if (!index.IsOnPage(objectId)) continue;
            if (!totals.TryGetValue(objectId, out var accumulated))
            {
                accumulated = new ExposureTotals();
                totals.Add(objectId, accumulated);
            }
            accumulated.Add(family);
        }

        return new ReadOnlyDictionary<string, DatabaseCityAttributedExposureV1>(
            totals.ToDictionary(
                entry => entry.Key,
                entry => entry.Value.ToContract(
                    index.NameOf(entry.Key), sharedCounts.GetValueOrDefault(entry.Key), evidence),
                StringComparer.Ordinal));
    }

    /// <summary>
    /// Reports how many families fall outside the ranked top-N. The count is exact because the
    /// Query Store index publishes it, but the remainder's counters were never aggregated for this
    /// page, so they stay unavailable instead of being reported as zero.
    /// </summary>
    private static DatabaseCityWorkloadAggregateV1 OtherWorkload(
        PageV1<QueryFamilySummaryV1> page,
        int topCount,
        EvidenceV1 pageEvidence)
    {
        string? familyCount = null;
        var reason =
            "Families outside the ranked top-N were not counted, because this Query Store index did not publish a total.";
        if (page.TotalCount is { } total &&
            BigInteger.TryParse(total, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) &&
            parsed >= topCount)
        {
            familyCount = (parsed - topCount).ToString(CultureInfo.InvariantCulture);
            reason =
                "Exact count of query families outside the ranked top-N; their execution, CPU, duration, read, and wait totals were not aggregated for this page and are unavailable, never zero.";
        }

        return new DatabaseCityWorkloadAggregateV1(
            familyCount, null, null, null, null, null, pageEvidence with { Reason = reason });
    }

    private static CityAttributionResult Unavailable(EvidenceV1 evidence) => new(
        [],
        new DatabaseCityWorkloadAggregateV1(null, null, null, null, null, null, evidence),
        [],
        ReadOnlyDictionary<string, DatabaseCityAttributedExposureV1>.Empty,
        evidence);

    private static DatabaseCityQueryEvidence Unattributed(
        QueryFamilySummaryV1 summary,
        ReadOnlyDictionary<string, string> waits,
        string rationale) =>
        new(summary.FamilyId, summary.QueryHash, summary.ExecutionCount, summary.TotalCpuMicroseconds,
            summary.TotalDurationMicroseconds, summary.TotalLogicalReads8KiBPages,
            summary.TotalWaitMilliseconds, [], QueryAttributionConfidence.Unknown, rationale)
        {
            WaitMillisecondsByCategory = waits,
        };

    internal static EvidenceV1 ToEvidence(QueryStoreEvidenceV1? evidence) => evidence is null
        ? UnavailableEvidence
        : new EvidenceV1(
            EvidenceSource.QueryStoreAggregate, evidence.Status, evidence.ObservedAt, evidence.FreshUntil,
            $"{evidence.Reason} {evidence.Caveat}".Trim());

    private static string MetricToken(DatabaseCityMetric metric) => metric switch
    {
        DatabaseCityMetric.Cpu => "cpu",
        DatabaseCityMetric.Duration => "duration",
        DatabaseCityMetric.Reads => "reads",
        DatabaseCityMetric.Executions => "execution",
        _ => throw new ArgumentOutOfRangeException(nameof(metric)),
    };

    private sealed record ResolvedFamily(
        DatabaseCityQueryEvidence Family,
        int PlansHydrated,
        bool ExposureEligible = false);

    private enum ReferenceKind { Unresolvable, OnPage, OffPage, CrossDatabase }

    private readonly record struct ResolvedReference(ReferenceKind Kind, string? Value);

    private sealed class ExposureTotals
    {
        private BigInteger _executions;
        private BigInteger _cpu;
        private BigInteger _duration;
        private BigInteger _reads;
        private QueryAttributionConfidence _confidence = QueryAttributionConfidence.Confirmed;
        private int _families;

        public void Add(DatabaseCityQueryEvidence family)
        {
            _families++;
            _executions += Parse(family.ExecutionCount);
            _cpu += Parse(family.TotalCpuMicroseconds);
            _duration += Parse(family.TotalDurationMicroseconds);
            _reads += Parse(family.TotalLogicalReads8KiBPages);
            // The object inherits the weakest confidence of any family folded into its totals.
            if (family.Confidence > _confidence) _confidence = family.Confidence;
        }

        public DatabaseCityAttributedExposureV1 ToContract(
            string name,
            int sharedFamilies,
            EvidenceV1 evidence) => new(
            _executions.ToString(CultureInfo.InvariantCulture),
            _cpu.ToString(CultureInfo.InvariantCulture),
            _duration.ToString(CultureInfo.InvariantCulture),
            _reads.ToString(CultureInfo.InvariantCulture),
            _confidence,
            $"Counts the {_families.ToString(CultureInfo.InvariantCulture)} ranked Query Store family or families whose normalized plans name {name} and no other object, because only those measured this object on its own." +
            (sharedFamilies > 0
                ? $" A further {sharedFamilies.ToString(CultureInfo.InvariantCulture)} ranked family or families name {name} alongside other objects. Query Store measures one total per query, not per object, so their figures are not added here; they are shown whole as routes between the objects they name and as shared wait lanes threaded through them."
                : string.Empty),
            evidence);

        private static BigInteger Parse(string value) =>
            BigInteger.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed)
                ? parsed
                : BigInteger.Zero;
    }

    /// <summary>
    /// Resolves showplan object references against the objects on this page, mirroring the map's own
    /// matching rules: bracket quoting is stripped, comparison is case-insensitive, and a reference
    /// without a schema only matches when exactly one object on the page carries that name.
    /// </summary>
    private sealed class PageObjectIndex
    {
        private readonly Dictionary<string, CityAttributionObject> _byQualifiedName;
        private readonly ILookup<string, CityAttributionObject> _byName;
        private readonly Dictionary<string, CityAttributionObject> _byObjectId;
        private readonly IReadOnlyDictionary<string, string> _databaseIdsByName;
        private readonly string _databaseName;

        public PageObjectIndex(
            IReadOnlyList<CityAttributionObject> objects,
            string databaseName,
            IReadOnlyDictionary<string, string> databaseIdsByName)
        {
            _databaseName = databaseName;
            _databaseIdsByName = databaseIdsByName;
            _byObjectId = objects.ToDictionary(item => item.ObjectId, StringComparer.Ordinal);
            _byQualifiedName = objects
                .GroupBy(item => Qualified(item.SchemaName, item.ObjectName), StringComparer.OrdinalIgnoreCase)
                .ToDictionary(group => group.Key, group => group.First(), StringComparer.OrdinalIgnoreCase);
            _byName = objects.ToLookup(item => item.ObjectName, StringComparer.OrdinalIgnoreCase);
        }

        public bool IsOnPage(string objectId) => _byObjectId.ContainsKey(objectId);

        public DatabaseObjectKind? KindOf(string objectId) =>
            _byObjectId.TryGetValue(objectId, out var value) ? value.Kind : null;

        public string NameOf(string objectId) =>
            _byObjectId.TryGetValue(objectId, out var value)
                ? Qualified(value.SchemaName, value.ObjectName)
                : objectId;

        public ResolvedReference Resolve(ShowplanObjectV1 reference)
        {
            var table = Unquote(reference.Table);
            if (table is null) return new ResolvedReference(ReferenceKind.Unresolvable, null);
            var database = Unquote(reference.Database);
            if (database is not null &&
                !database.Equals(_databaseName, StringComparison.OrdinalIgnoreCase))
            {
                if (_databaseIdsByName.TryGetValue(database, out var remoteId))
                    return new ResolvedReference(ReferenceKind.CrossDatabase, remoteId);

                // The plan names a database this target's atlas does not hold. Guessing which
                // database it is would invent a route, so it is reported by name instead.
                var schemaPrefix = Unquote(reference.Schema) is { } named ? $"{named}." : string.Empty;
                return new ResolvedReference(ReferenceKind.Unresolvable, $"{database}.{schemaPrefix}{table}");
            }

            var schema = Unquote(reference.Schema);
            if (schema is not null)
            {
                return _byQualifiedName.TryGetValue(Qualified(schema, table), out var match)
                    ? new ResolvedReference(ReferenceKind.OnPage, match.ObjectId)
                    : new ResolvedReference(ReferenceKind.OffPage, Qualified(schema, table));
            }

            var candidates = _byName[table].ToArray();
            return candidates.Length == 1
                ? new ResolvedReference(ReferenceKind.OnPage, candidates[0].ObjectId)
                : new ResolvedReference(ReferenceKind.OffPage, table);
        }

        private static string Qualified(string schema, string name) => $"{schema}.{name}";

        /// <summary>Strips showplan bracket quoting: <c>[dbo]</c> becomes <c>dbo</c>.</summary>
        private static string? Unquote(string? value)
        {
            if (value is null) return null;
            var trimmed = value.Trim();
            if (trimmed.Length == 0) return null;
            return trimmed.Length >= 2 && trimmed[0] == '[' && trimmed[^1] == ']'
                ? trimmed[1..^1]
                : trimmed;
        }
    }

    /// <summary>
    /// Collects co-reference routes. A route records that one normalized plan named both endpoints;
    /// it is never a claim about direction or row flow.
    /// </summary>
    private sealed class RouteAccumulator(EvidenceV1 pageEvidence)
    {
        private readonly SortedDictionary<string, DatabaseCityRouteV1> _routes = new(StringComparer.Ordinal);

        public void AddPlan(SortedSet<string> local, SortedSet<string> remote)
        {
            var ordered = local.ToArray();
            for (var left = 0; left < ordered.Length; left++)
            {
                for (var right = left + 1; right < ordered.Length; right++)
                    Add(ordered[left], ordered[right], DatabaseCityRouteKind.ObjectReference, EdgeConfidence.Confirmed,
                        "One normalized compiled plan references both local objects; this route identifies co-reference, not row flow.");
                foreach (var target in remote)
                    Add(ordered[left], target, DatabaseCityRouteKind.CrossDatabaseReference, EdgeConfidence.Probable,
                        "A normalized plan reference names another database alongside this object; direction and row flow are not established.");
            }
        }

        public DatabaseCityRouteV1[] Build() => [.. _routes.Values];

        private void Add(
            string from,
            string to,
            DatabaseCityRouteKind kind,
            EdgeConfidence confidence,
            string rationale)
        {
            var routeId = $"route:{from}~{to}";
            if (_routes.ContainsKey(routeId)) return;
            _routes.Add(routeId, new DatabaseCityRouteV1(
                routeId, from, to, kind, confidence, rationale,
                pageEvidence with
                {
                    Source = EvidenceSource.InferredTopology,
                    Reason = "Co-reference inferred from normalized compiled plan object references.",
                }));
        }
    }
}
