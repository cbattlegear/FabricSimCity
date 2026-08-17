using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Storage;

namespace SqlSimCity.Collection.QueryStore;

public sealed class ProtectedQueryStoreRepository(IProtectedRecordStore store)
{
    private static readonly ProtectedRecordId CurrentPointerId = new("qs:current-snapshot-pointer");
    private const int TargetChunkBytes = 512 * 1024;

    public Task StoreQueryTextAsync(
        string databaseId, string queryTextId, DateTimeOffset capturedAt, string queryText,
        CancellationToken cancellationToken = default) =>
        PutUtf8Async(Id("query-text", databaseId, queryTextId), "query-store-query-text",
            capturedAt, queryText, StorageResolution.Detail, cancellationToken);

    public Task StorePlanXmlAsync(
        string databaseId, string planId, DateTimeOffset capturedAt, string showplanXml,
        CancellationToken cancellationToken = default) =>
        PutUtf8Async(Id("showplan", databaseId, planId), "query-store-showplan",
            capturedAt, showplanXml, StorageResolution.Detail, cancellationToken);

    public Task StoreNormalizedPlanAsync(
        NormalizedShowplanV1 plan, DateTimeOffset capturedAt,
        CancellationToken cancellationToken = default) =>
        PutJsonAsync(Id("normalized-plan", plan.PlanId, "current"),
            "query-store-normalized-plan", capturedAt, StorageResolution.Detail, plan, cancellationToken);

    public Task<NormalizedShowplanV1?> ReadNormalizedPlanAsync(
        string planId, CancellationToken cancellationToken = default) =>
        ReadJsonAsync<NormalizedShowplanV1>(Id("normalized-plan", planId, "current"), cancellationToken);

    public Task StoreTextDescriptorAsync(
        string databaseId, string queryTextId, QueryTextDescriptorV1 descriptor,
        DateTimeOffset capturedAt, CancellationToken cancellationToken = default) =>
        PutJsonAsync(Id("text-descriptor", databaseId, queryTextId),
            "query-store-text-descriptor", capturedAt, StorageResolution.Detail, descriptor, cancellationToken);

    public Task<QueryTextDescriptorV1?> ReadTextDescriptorAsync(
        string databaseId, string queryTextId, CancellationToken cancellationToken = default) =>
        ReadJsonAsync<QueryTextDescriptorV1>(Id("text-descriptor", databaseId, queryTextId), cancellationToken);

    public Task StoreNormalizedFactAsync<T>(
        string databaseId, string factId, DateTimeOffset capturedAt,
        StorageResolution resolution, T value, CancellationToken cancellationToken = default) =>
        PutJsonAsync(Id("fact", databaseId, factId), "query-store-normalized-fact",
            capturedAt, resolution, value, cancellationToken);

    public async Task PublishSnapshotAsync(
        QueryStorePublishedSnapshot snapshot,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        var chunkIds = new List<string>();
        var chunk = new List<QueryFamilyDetailV1>();
        var chunkBytes = 0;
        foreach (var family in snapshot.Families)
        {
            var familyBytes = SerializedSize(family);
            if (chunk.Count > 0 && chunkBytes + familyBytes > TargetChunkBytes)
            {
                chunkIds.Add(await StoreFamilyChunkAsync(
                    snapshot, chunkIds.Count, chunk, cancellationToken).ConfigureAwait(false));
                chunk = [];
                chunkBytes = 0;
            }
            chunk.Add(family);
            chunkBytes += familyBytes;
        }
        if (chunk.Count > 0)
            chunkIds.Add(await StoreFamilyChunkAsync(
                snapshot, chunkIds.Count, chunk, cancellationToken).ConfigureAwait(false));

        var index = snapshot with { Families = [], FamilyChunkRecordIds = chunkIds };
        var snapshotId = Id("snapshot", snapshot.SnapshotId,
            snapshot.Sequence.ToString(CultureInfo.InvariantCulture));
        await PutJsonAsync(snapshotId, "query-store-published-snapshot", snapshot.PublishedAt,
            StorageResolution.Detail, index, cancellationToken).ConfigureAwait(false);
        await PutJsonAsync(CurrentPointerId, "query-store-snapshot-pointer", snapshot.PublishedAt,
            StorageResolution.Detail, new QueryStoreSnapshotPointer(snapshotId.Value), cancellationToken)
            .ConfigureAwait(false);
    }

    public async Task<QueryStorePublishedSnapshot?> ReadPublishedSnapshotAsync(
        CancellationToken cancellationToken = default)
    {
        var pointer = await ReadJsonAsync<QueryStoreSnapshotPointer>(
            CurrentPointerId, cancellationToken).ConfigureAwait(false);
        if (pointer is null) return null;
        var snapshot = await ReadJsonAsync<QueryStorePublishedSnapshot>(
            new ProtectedRecordId(pointer.SnapshotRecordId), cancellationToken).ConfigureAwait(false);
        if (snapshot is null) return null;
        if (snapshot.FamilyChunkRecordIds is null) return snapshot;
        var families = new List<QueryFamilyDetailV1>();
        foreach (var chunkId in snapshot.FamilyChunkRecordIds)
        {
            var chunk = await ReadJsonAsync<QueryStoreFamilyChunk>(
                new ProtectedRecordId(chunkId), cancellationToken).ConfigureAwait(false) ??
                throw new InvalidDataException("A protected Query Store snapshot family chunk is missing.");
            families.AddRange(chunk.Families);
        }
        return snapshot with { Families = families };
    }

    public Task StoreWatermarkAsync(
        QueryStoreWatermark watermark,
        CancellationToken cancellationToken = default) =>
        PutJsonAsync(Id("watermark", watermark.DatabaseId, "current"),
            "query-store-watermark", watermark.Through, StorageResolution.Detail, watermark, cancellationToken);

    public Task<QueryStoreWatermark?> ReadWatermarkAsync(
        string databaseId,
        CancellationToken cancellationToken = default) =>
        ReadJsonAsync<QueryStoreWatermark>(Id("watermark", databaseId, "current"), cancellationToken);

    public async Task<string?> ReadSensitiveTextAsync(
        string kind, string databaseId, string sourceId,
        CancellationToken cancellationToken = default)
    {
        if (kind is not ("query-text" or "showplan")) throw new ArgumentOutOfRangeException(nameof(kind));
        var record = await store.GetAsync(Id(kind, databaseId, sourceId), cancellationToken).ConfigureAwait(false);
        return record is null ? null : Encoding.UTF8.GetString(record.Payload.Span);
    }

    private async Task PutUtf8Async(
        ProtectedRecordId id, string recordKind, DateTimeOffset capturedAt, string value,
        StorageResolution resolution, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(value);
        var bytes = Encoding.UTF8.GetBytes(value);
        try
        {
            await store.PutAsync(id, recordKind, capturedAt, resolution, bytes, cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    private async Task<string> StoreFamilyChunkAsync(
        QueryStorePublishedSnapshot snapshot,
        int index,
        IReadOnlyList<QueryFamilyDetailV1> families,
        CancellationToken cancellationToken)
    {
        var id = Id("snapshot-families", snapshot.SnapshotId, index.ToString(CultureInfo.InvariantCulture));
        await PutJsonAsync(id, "query-store-snapshot-families", snapshot.PublishedAt,
            StorageResolution.Detail, new QueryStoreFamilyChunk(families), cancellationToken)
            .ConfigureAwait(false);
        return id.Value;
    }

    private static int SerializedSize<T>(T value)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value);
        try { return bytes.Length; }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    private async Task PutJsonAsync<T>(
        ProtectedRecordId id, string recordKind, DateTimeOffset capturedAt,
        StorageResolution resolution, T value, CancellationToken cancellationToken)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value);
        try
        {
            await store.PutAsync(id, recordKind, capturedAt, resolution, bytes, cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    private async Task<T?> ReadJsonAsync<T>(
        ProtectedRecordId id,
        CancellationToken cancellationToken)
    {
        var record = await store.GetAsync(id, cancellationToken).ConfigureAwait(false);
        return record is null ? default : JsonSerializer.Deserialize<T>(record.Payload.Span);
    }

    private static ProtectedRecordId Id(string kind, string databaseId, string sourceId)
    {
        var opaque = SHA256.HashData(Encoding.UTF8.GetBytes($"{kind}\n{databaseId}\n{sourceId}"));
        return new ProtectedRecordId($"qs:{Convert.ToHexString(opaque).ToLowerInvariant()}");
    }
}

public sealed record QueryStoreSnapshotPointer(string SnapshotRecordId);

public sealed record QueryStorePublishedSnapshot(
    string SchemaVersion,
    string SnapshotId,
    long Sequence,
    DateTimeOffset PublishedAt,
    IReadOnlyList<QueryFamilyDetailV1> Families,
    QueryStoreCollectorStatusV1 Status,
    IReadOnlyList<string>? FamilyChunkRecordIds = null);

public sealed record QueryStoreFamilyChunk(IReadOnlyList<QueryFamilyDetailV1> Families);
