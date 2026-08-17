using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using SqlSimCity.Storage;

namespace SqlSimCity.Storage.Crypto;

/// <summary>
/// Seals and opens the versioned protected storage envelope:
/// <c>[formatVersion:1][keyVersion:4 BE][nonce:12][tag:16][ciphertext:N]</c>.
/// AES-256-GCM authenticated associated data binds record kind, opaque record
/// id, and key version (length-prefixed to avoid delimiter ambiguity), so a
/// ciphertext copied onto a different record's row fails authentication.
/// </summary>
internal static class EnvelopeCodec
{
    private const byte FormatVersion1 = 1;
    private const int NonceSizeBytes = 12;
    private const int TagSizeBytes = 16;
    private const int HeaderSizeBytes = 1 + 4 + NonceSizeBytes + TagSizeBytes;

    public static byte[] Seal(KeyRing keyRing, string recordKind, string recordId, ReadOnlySpan<byte> plaintext)
    {
        ArgumentNullException.ThrowIfNull(keyRing);
        ArgumentException.ThrowIfNullOrEmpty(recordKind);
        ArgumentException.ThrowIfNullOrEmpty(recordId);

        var keyVersion = keyRing.ActiveKeyVersion;
        var key = keyRing.GetKey(keyVersion);

        Span<byte> nonce = stackalloc byte[NonceSizeBytes];
        RandomNumberGenerator.Fill(nonce);
        Span<byte> tag = stackalloc byte[TagSizeBytes];
        var ciphertext = new byte[plaintext.Length];
        var aad = BuildAssociatedData(recordKind, recordId, keyVersion);

        using (var aesGcm = new AesGcm(key, TagSizeBytes))
        {
            aesGcm.Encrypt(nonce, plaintext, ciphertext, tag, aad);
        }

        var envelope = new byte[HeaderSizeBytes + ciphertext.Length];
        var span = envelope.AsSpan();
        span[0] = FormatVersion1;
        BinaryPrimitives.WriteUInt32BigEndian(span.Slice(1, 4), keyVersion);
        nonce.CopyTo(span.Slice(5, NonceSizeBytes));
        tag.CopyTo(span.Slice(5 + NonceSizeBytes, TagSizeBytes));
        ciphertext.CopyTo(span[HeaderSizeBytes..]);
        return envelope;
    }

    public static byte[] Open(KeyRing keyRing, string recordKind, string recordId, ReadOnlySpan<byte> envelope)
        => Open(keyRing, recordKind, recordId, envelope, onAuthenticationFailure: null);

    internal static byte[] Open(
        KeyRing keyRing,
        string recordKind,
        string recordId,
        ReadOnlySpan<byte> envelope,
        Action<byte[]>? onAuthenticationFailure)
    {
        ArgumentNullException.ThrowIfNull(keyRing);
        ArgumentException.ThrowIfNullOrEmpty(recordKind);
        ArgumentException.ThrowIfNullOrEmpty(recordId);

        if (envelope.Length < HeaderSizeBytes)
        {
            throw new EnvelopeIntegrityException(
                $"Envelope is {envelope.Length} bytes, shorter than the {HeaderSizeBytes}-byte header.");
        }

        var formatVersion = envelope[0];
        if (formatVersion != FormatVersion1)
        {
            throw new EnvelopeIntegrityException($"Unsupported envelope format version {formatVersion}.");
        }

        var keyVersion = BinaryPrimitives.ReadUInt32BigEndian(envelope.Slice(1, 4));
        var nonce = envelope.Slice(5, NonceSizeBytes);
        var tag = envelope.Slice(5 + NonceSizeBytes, TagSizeBytes);
        var ciphertext = envelope[HeaderSizeBytes..];

        var key = keyRing.GetKey(keyVersion);
        var aad = BuildAssociatedData(recordKind, recordId, keyVersion);
        var plaintext = new byte[ciphertext.Length];

        try
        {
            using var aesGcm = new AesGcm(key, TagSizeBytes);
            aesGcm.Decrypt(nonce, ciphertext, tag, plaintext, aad);
        }
        catch (CryptographicException ex)
        {
            CryptographicOperations.ZeroMemory(plaintext);
            onAuthenticationFailure?.Invoke(plaintext);
            throw new EnvelopeIntegrityException(
                "Envelope failed AES-256-GCM authentication (wrong key, tampering, or a mismatched record).", ex);
        }

        return plaintext;
    }

    /// <summary>
    /// Length-prefixes each field so no separator character can make two
    /// distinct (kind, id) pairs collide into the same associated data bytes.
    /// </summary>
    private static byte[] BuildAssociatedData(string recordKind, string recordId, uint keyVersion)
    {
        var kindBytes = Encoding.UTF8.GetBytes(recordKind);
        var idBytes = Encoding.UTF8.GetBytes(recordId);
        var aad = new byte[4 + kindBytes.Length + 4 + idBytes.Length + 4];
        var span = aad.AsSpan();

        BinaryPrimitives.WriteInt32BigEndian(span, kindBytes.Length);
        kindBytes.CopyTo(span[4..]);
        var offset = 4 + kindBytes.Length;

        BinaryPrimitives.WriteInt32BigEndian(span.Slice(offset, 4), idBytes.Length);
        idBytes.CopyTo(span[(offset + 4)..]);
        offset += 4 + idBytes.Length;

        BinaryPrimitives.WriteUInt32BigEndian(span.Slice(offset, 4), keyVersion);
        return aad;
    }
}
