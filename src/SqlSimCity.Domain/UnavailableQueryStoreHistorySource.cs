using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Domain;

public sealed class UnavailableQueryStoreHistorySource : IQueryStoreHistorySource
{
    public PageV1<QueryFamilySummaryV1> GetQueries(
        string? databaseId, string metric, int pageSize, string? pageToken) =>
        new("1.0", [], null, Math.Clamp(pageSize, 1, 200), null)
        {
            Evidence = new QueryStoreEvidenceV1(
                QueryStoreSource.QueryStore, DataStatus.Unknown, null, null,
                "Connected Query Store history collection is not enabled; no fixture data is substituted.",
                "No history is shown as zero. Configure protected storage before enabling connected history collection."),
        };

    public QueryFamilyDetailV1? GetFamily(string familyId) => null;
    public NormalizedShowplanV1? GetPlan(string planId) => null;
    public PlanComparisonV1? ComparePlans(string leftPlanId, string rightPlanId) => null;
}
