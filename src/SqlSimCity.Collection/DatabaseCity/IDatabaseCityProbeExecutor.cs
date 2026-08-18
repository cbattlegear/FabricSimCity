using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.DatabaseCity;

public sealed record DatabaseCityInventoryRow(
    int ObjectId,
    int SchemaId,
    int SchemaLayoutOrdinal,
    string SchemaName,
    string ObjectName,
    DatabaseObjectKind Kind,
    string ReservedPages8KiB,
    string UsedPages8KiB,
    int IndexId,
    string? IndexName,
    DatabaseIndexKind IndexKind);

public sealed record DatabaseCityIndexUsageRow(
    int ObjectId,
    int IndexId,
    string TotalOperations);

public sealed record DatabaseCityProbePage(
    IReadOnlyList<DatabaseCityInventoryRow> Inventory,
    IReadOnlyList<DatabaseCityIndexUsageRow> Usage,
    DataStatus UsageStatus,
    string UsageReason,
    DateTimeOffset ObservedAt);

public interface IDatabaseCityProbeExecutor
{
    Task<DatabaseCityProbePage> CollectPageAsync(
        string databaseName,
        int afterObjectId,
        int topN,
        CancellationToken cancellationToken);
}
