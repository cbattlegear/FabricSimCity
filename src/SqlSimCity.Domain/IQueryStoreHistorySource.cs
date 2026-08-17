using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Domain;

public interface IQueryStoreHistorySource
{
    PageV1<QueryFamilySummaryV1> GetQueries(
        string? databaseId,
        string metric,
        int pageSize,
        string? pageToken);
    QueryFamilyDetailV1? GetFamily(string familyId);
    NormalizedShowplanV1? GetPlan(string planId);
    PlanComparisonV1? ComparePlans(string leftPlanId, string rightPlanId);
}
