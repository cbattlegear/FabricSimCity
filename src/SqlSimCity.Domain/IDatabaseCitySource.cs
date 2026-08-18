using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Domain;

public interface IDatabaseCitySource
{
    ValueTask<DatabaseCitySummarySnapshotV1> GetSummariesAsync(CancellationToken cancellationToken);

    Task<DatabaseCityPageV1?> GetDatabaseAsync(
        string databaseId,
        DatabaseCityMetric metric,
        int pageSize,
        string? pageToken,
        CancellationToken cancellationToken);
}

public sealed class DatabaseCityPageTokenException : Exception
{
    public DatabaseCityPageTokenException() : base("The database-city page token is invalid.")
    {
    }
}
