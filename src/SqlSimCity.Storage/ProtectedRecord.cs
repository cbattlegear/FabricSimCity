namespace SqlSimCity.Storage;

/// <summary>
/// A decrypted protected record. <see cref="Payload"/> is the caller's original
/// plaintext bytes; it is never persisted or logged outside this type.
/// </summary>
public sealed record ProtectedRecord(
    ProtectedRecordId Id,
    string RecordKind,
    DateTimeOffset CapturedAt,
    StorageResolution Resolution,
    ReadOnlyMemory<byte> Payload);
