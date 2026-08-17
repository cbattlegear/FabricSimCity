namespace SqlSimCity.Collection.Atlas;

public interface IAtlasProbeExecutor
{
    Task<AtlasTargetIdentity> GetTargetIdentityAsync(CancellationToken cancellationToken);
    Task<IReadOnlyList<AtlasDatabaseIdentity>> DiscoverDatabasesAsync(CancellationToken cancellationToken);
    Task<AtlasDatabaseProbeResult> CollectDatabaseAsync(
        string databaseName,
        AtlasProbeSelection selection,
        DateTimeOffset queryStoreWindowStart,
        DateTimeOffset queryStoreWindowEnd,
        CancellationToken cancellationToken);
}

public interface ILiveAtlasActivitySource
{
    ValueTask<SqlSimCity.Contracts.V1.LiveActivityV1> GetActivityAsync(
        string databaseId,
        string databaseName,
        DateTimeOffset collectedAt,
        CancellationToken cancellationToken);
}

public sealed class NotProbedLiveAtlasActivitySource : ILiveAtlasActivitySource
{
    public ValueTask<SqlSimCity.Contracts.V1.LiveActivityV1> GetActivityAsync(
        string databaseId,
        string databaseName,
        DateTimeOffset collectedAt,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        const string reason = "Live request activity was not probed by the server-atlas collector.";
        return ValueTask.FromResult(new SqlSimCity.Contracts.V1.LiveActivityV1(
            null, null, null, null,
            new SqlSimCity.Contracts.V1.EvidenceV1(
                SqlSimCity.Contracts.V1.EvidenceSource.NotProbed,
                SqlSimCity.Contracts.V1.DataStatus.Unknown,
                null, null, reason)));
    }
}

public sealed class FixtureLiveAtlasActivitySource(
    IReadOnlyDictionary<string, SqlSimCity.Contracts.V1.LiveActivityV1> values) : ILiveAtlasActivitySource
{
    public ValueTask<SqlSimCity.Contracts.V1.LiveActivityV1> GetActivityAsync(
        string databaseId,
        string databaseName,
        DateTimeOffset collectedAt,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (values.TryGetValue(databaseId, out var activity))
            return ValueTask.FromResult(activity);
        const string reason = "The deterministic fixture contains no live value for this database.";
        return ValueTask.FromResult(new SqlSimCity.Contracts.V1.LiveActivityV1(
            null, null, null, null,
            new SqlSimCity.Contracts.V1.EvidenceV1(
                SqlSimCity.Contracts.V1.EvidenceSource.Fixture,
                SqlSimCity.Contracts.V1.DataStatus.Unknown,
                null, null, reason)));
    }
}
