using System.Security.Cryptography;

namespace SqlSimCity.Storage;

/// <summary>A decrypted protected record whose payload is zeroed when disposed.</summary>
public sealed class ProtectedRecord : IDisposable
{
    private byte[]? _payload;

    public ProtectedRecord(
        ProtectedRecordId id,
        string recordKind,
        DateTimeOffset capturedAt,
        StorageResolution resolution,
        ReadOnlyMemory<byte> payload)
    {
        Id = id;
        RecordKind = recordKind;
        CapturedAt = capturedAt;
        Resolution = resolution;
        _payload = payload.ToArray();
    }

    public ProtectedRecordId Id { get; }
    public string RecordKind { get; }
    public DateTimeOffset CapturedAt { get; }
    public StorageResolution Resolution { get; }
    public ReadOnlyMemory<byte> Payload =>
        _payload ?? throw new ObjectDisposedException(nameof(ProtectedRecord));

    public void Dispose()
    {
        var payload = Interlocked.Exchange(ref _payload, null);
        if (payload is not null) CryptographicOperations.ZeroMemory(payload);
    }
}
