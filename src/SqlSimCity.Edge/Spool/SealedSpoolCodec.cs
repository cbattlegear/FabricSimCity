using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace SqlSimCity.Edge.Spool;

/// <summary>Raised when a sealed spool file cannot be authenticated (wrong key, corruption, or tampering).</summary>
public sealed class SpoolIntegrityException : Exception
{
    public SpoolIntegrityException(string message) : base(message) { }
    public SpoolIntegrityException(string message, Exception inner) : base(message, inner) { }
}

/// <summary>
/// Seals and opens a spooled batch with AES-256-GCM. The on-disk format is
/// <c>[formatVersion:1][keyVersion:4 BE][nonce:12][tag:16][ciphertext:N]</c>. The batch id is bound
/// as authenticated associated data, so a sealed file renamed onto a different batch's slot fails to
/// open. A wrong or corrupt key fails closed with <see cref="SpoolIntegrityException"/>; it never
/// returns partial plaintext.
/// </summary>
internal static class SealedSpoolCodec
{
    private const byte FormatVersion1 = 1;
    private const int NonceSizeBytes = 12;
    private const int TagSizeBytes = 16;
    private const int HeaderSizeBytes = 1 + 4 + NonceSizeBytes + TagSizeBytes;

    public static byte[] Seal(SpoolKey key, string batchId, ReadOnlySpan<byte> plaintext)
    {
        Span<byte> nonce = stackalloc byte[NonceSizeBytes];
        RandomNumberGenerator.Fill(nonce);
        Span<byte> tag = stackalloc byte[TagSizeBytes];
        var ciphertext = new byte[plaintext.Length];
        var aad = BuildAssociatedData(batchId, key.Version);

        using (var aesGcm = new AesGcm(key.Bytes, TagSizeBytes))
            aesGcm.Encrypt(nonce, plaintext, ciphertext, tag, aad);

        var envelope = new byte[HeaderSizeBytes + ciphertext.Length];
        var span = envelope.AsSpan();
        span[0] = FormatVersion1;
        BinaryPrimitives.WriteUInt32BigEndian(span.Slice(1, 4), key.Version);
        nonce.CopyTo(span.Slice(5, NonceSizeBytes));
        tag.CopyTo(span.Slice(5 + NonceSizeBytes, TagSizeBytes));
        ciphertext.CopyTo(span[HeaderSizeBytes..]);
        return envelope;
    }

    public static byte[] Open(SpoolKey key, string batchId, ReadOnlySpan<byte> envelope)
    {
        if (envelope.Length < HeaderSizeBytes)
            throw new SpoolIntegrityException("Sealed spool file is shorter than its header.");
        if (envelope[0] != FormatVersion1)
            throw new SpoolIntegrityException($"Unsupported sealed spool format version {envelope[0]}.");

        var keyVersion = BinaryPrimitives.ReadUInt32BigEndian(envelope.Slice(1, 4));
        if (keyVersion != key.Version)
            throw new SpoolIntegrityException("Sealed spool file was written under a different key version.");

        var nonce = envelope.Slice(5, NonceSizeBytes);
        var tag = envelope.Slice(5 + NonceSizeBytes, TagSizeBytes);
        var ciphertext = envelope[HeaderSizeBytes..];
        var aad = BuildAssociatedData(batchId, keyVersion);
        var plaintext = new byte[ciphertext.Length];

        try
        {
            using var aesGcm = new AesGcm(key.Bytes, TagSizeBytes);
            aesGcm.Decrypt(nonce, ciphertext, tag, plaintext, aad);
        }
        catch (CryptographicException ex)
        {
            CryptographicOperations.ZeroMemory(plaintext);
            throw new SpoolIntegrityException(
                "Sealed spool file failed AES-256-GCM authentication (wrong key, tampering, or a mismatched batch).", ex);
        }

        return plaintext;
    }

    private static byte[] BuildAssociatedData(string batchId, uint keyVersion)
    {
        var idBytes = Encoding.UTF8.GetBytes(batchId);
        var aad = new byte[4 + idBytes.Length + 4];
        var span = aad.AsSpan();
        BinaryPrimitives.WriteInt32BigEndian(span, idBytes.Length);
        idBytes.CopyTo(span[4..]);
        BinaryPrimitives.WriteUInt32BigEndian(span.Slice(4 + idBytes.Length, 4), keyVersion);
        return aad;
    }
}
