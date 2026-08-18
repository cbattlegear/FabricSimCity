namespace SqlSimCity.Storage;

/// <summary>
/// Async storage for encrypted operational records. Only <see cref="ProtectedRecordId"/>,
/// record kind, captured timestamp, and <see cref="StorageResolution"/> are ever
/// plaintext metadata; <c>payload</c> bytes are always AES-256-GCM encrypted before
/// they reach SQLite. Implementations must fail closed: they must not silently
/// fall back to an unencrypted store on key or integrity failure.
/// </summary>
public interface IProtectedRecordStore
{
    /// <summary>Maximum plaintext bytes accepted by one protected record.</summary>
    int MaxPayloadBytes { get; }

    /// <summary>Encrypts and upserts a record under its opaque id.</summary>
    Task PutAsync(
        ProtectedRecordId id,
        string recordKind,
        DateTimeOffset capturedAt,
        StorageResolution resolution,
        ReadOnlyMemory<byte> payload,
        CancellationToken cancellationToken = default);

    /// <summary>Reads and decrypts a caller-owned record, or <c>null</c>; dispose it to zero the payload.</summary>
    Task<ProtectedRecord?> GetAsync(ProtectedRecordId id, CancellationToken cancellationToken = default);

    /// <summary>Deletes a record. Returns <c>false</c> if the id was absent.</summary>
    Task<bool> DeleteAsync(ProtectedRecordId id, CancellationToken cancellationToken = default);

    /// <summary>
    /// Atomically replaces every record whose opaque id starts with <paramref name="idPrefix"/>.
    /// The replacement sequence is consumed inside one storage transaction.
    /// </summary>
    Task ReplaceSetAsync(
        string idPrefix,
        IEnumerable<ProtectedRecordWrite> records,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Prunes records older than the configured retention window for their
    /// resolution, deleting at most the configured <c>PruneBatchSize</c> per
    /// invocation. Callers repeat it to drain additional expired rows. Never
    /// deletes canary or configuration metadata.
    /// </summary>
    Task<int> PruneExpiredAsync(CancellationToken cancellationToken = default);
}

public sealed record ProtectedRecordWrite(
    ProtectedRecordId Id,
    string RecordKind,
    DateTimeOffset CapturedAt,
    StorageResolution Resolution,
    ReadOnlyMemory<byte> Payload);
