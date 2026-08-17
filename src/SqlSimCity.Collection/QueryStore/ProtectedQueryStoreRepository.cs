using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SqlSimCity.Storage;

namespace SqlSimCity.Collection.QueryStore;

public sealed class ProtectedQueryStoreRepository
{
    private readonly IProtectedRecordStore _store;

    public ProtectedQueryStoreRepository(IProtectedRecordStore store) =>
        _store = store ?? throw new ArgumentNullException(nameof(store));

    public Task StoreQueryTextAsync(
        string databaseId,
        string queryTextId,
        DateTimeOffset capturedAt,
        string queryText,
        CancellationToken cancellationToken = default) =>
        PutUtf8Async(
            Id("query-text", databaseId, queryTextId), "query-store-query-text",
            capturedAt, queryText, StorageResolution.Detail, cancellationToken);

    public Task StorePlanXmlAsync(
        string databaseId,
        string planId,
        DateTimeOffset capturedAt,
        string showplanXml,
        CancellationToken cancellationToken = default) =>
        PutUtf8Async(
            Id("showplan", databaseId, planId), "query-store-showplan",
            capturedAt, showplanXml, StorageResolution.Detail, cancellationToken);

    public async Task StoreNormalizedFactAsync<T>(
        string databaseId,
        string factId,
        DateTimeOffset capturedAt,
        StorageResolution resolution,
        T value,
        CancellationToken cancellationToken = default)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value);
        try
        {
            await _store.PutAsync(
                Id("fact", databaseId, factId), "query-store-normalized-fact",
                capturedAt, resolution, bytes, cancellationToken);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    public async Task<string?> ReadSensitiveTextAsync(
        string kind,
        string databaseId,
        string sourceId,
        CancellationToken cancellationToken = default)
    {
        if (kind is not ("query-text" or "showplan")) throw new ArgumentOutOfRangeException(nameof(kind));
        var record = await _store.GetAsync(Id(kind, databaseId, sourceId), cancellationToken);
        return record is null ? null : Encoding.UTF8.GetString(record.Payload.Span);
    }

    private async Task PutUtf8Async(
        ProtectedRecordId id,
        string recordKind,
        DateTimeOffset capturedAt,
        string value,
        StorageResolution resolution,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(value);
        var bytes = Encoding.UTF8.GetBytes(value);
        try
        {
            await _store.PutAsync(id, recordKind, capturedAt, resolution, bytes, cancellationToken);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    private static ProtectedRecordId Id(string kind, string databaseId, string sourceId)
    {
        var opaque = SHA256.HashData(Encoding.UTF8.GetBytes($"{kind}\n{databaseId}\n{sourceId}"));
        return new ProtectedRecordId($"qs:{Convert.ToHexString(opaque).ToLowerInvariant()}");
    }
}
