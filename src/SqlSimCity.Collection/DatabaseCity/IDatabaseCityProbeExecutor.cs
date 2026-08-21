using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.DatabaseCity;

public sealed record DatabaseCityInventoryRow(
    int ObjectId,
    int SchemaId,
    int SchemaLayoutOrdinal,
    string SchemaName,
    string ObjectName,
    DatabaseObjectKind Kind,
    string? ReservedPages8KiB,
    string? UsedPages8KiB,
    int? IndexId,
    string? IndexName,
    DatabaseIndexKind? IndexKind);

public sealed record DatabaseCityIndexUsageRow(
    int ObjectId,
    int IndexId,
    string TotalOperations);

/// <param name="TotalObjects">
/// Every object the inventory probe would return across all pages, unbounded by the keyset, or
/// <see langword="null"/> when the count could not be established. It is not the number of rows on
/// this page.
/// </param>
public sealed record DatabaseCityProbePage(
    IReadOnlyList<DatabaseCityInventoryRow> Inventory,
    IReadOnlyList<DatabaseCityIndexUsageRow> Usage,
    DataStatus UsageStatus,
    string UsageReason,
    DateTimeOffset ObservedAt,
    string? TotalObjects = null);

public interface IDatabaseCityProbeExecutor
{
    Task<DatabaseCityProbePage> CollectPageAsync(
        string databaseName,
        int afterObjectId,
        int topN,
        CancellationToken cancellationToken);
}
