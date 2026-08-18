using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Domain;

public sealed class QueryStorePageTokenException(string message) : Exception(message);

public interface IQueryStoreHistorySource
{
    Task<PageV1<QueryFamilySummaryV1>> GetQueriesAsync(
        string? databaseId,
        string metric,
        int pageSize,
        string? pageToken,
        CancellationToken cancellationToken);
    Task<QueryFamilyDetailV1?> GetFamilyAsync(string familyId, CancellationToken cancellationToken);
    Task<NormalizedShowplanV1?> GetPlanAsync(string planId, CancellationToken cancellationToken);
    Task<PlanComparisonV1?> ComparePlansAsync(
        string leftPlanId,
        string rightPlanId,
        CancellationToken cancellationToken);
    Task<QueryStoreCollectorStatusV1> GetStatusAsync(CancellationToken cancellationToken);
}
