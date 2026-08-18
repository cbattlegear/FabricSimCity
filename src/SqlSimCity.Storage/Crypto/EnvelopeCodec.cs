using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using SqlSimCity.Storage;

namespace SqlSimCity.Storage.Crypto;

/// <summary>
/// Writes and reads the versioned protected storage envelope.
/// <para>
/// New records are written in the clear as <c>[formatVersion=2:1][plaintext:N]</c>.
/// SQL SimCity exists to show query plans, object attribution, and workload evidence, so
/// captured payloads stay readable: the value of the archive is inspection, not secrecy.
/// Protect the storage directory with filesystem permissions if the captured plans and
/// query text are sensitive, because plan XML can contain literal parameter values.
/// </para>
/// <para>
/// Records written by earlier versions use <c>[formatVersion=1:1][keyVersion:4 BE][nonce:12][tag:16][ciphertext:N]</c>
/// and are still opened with AES-256-GCM so an existing store keeps working across the
/// upgrade. Nothing writes that format any more.
/// </para>
/// </summary>
internal static class EnvelopeCodec
{
    private const byte SealedFormatVersion1 = 1;
    private const byte PlaintextFormatVersion2 = 2;
    private const int NonceSizeBytes = 12;
    private const int TagSizeBytes = 16;
    private const int SealedHeaderSizeBytes = 1 + 4 + NonceSizeBytes + TagSizeBytes;
    private const int PlaintextHeaderSizeBytes = 1;

    public static byte[] Seal(KeyRing keyRing, string recordKind, string recordId, ReadOnlySpan<byte> plaintext)
    {
        ArgumentNullException.ThrowIfNull(keyRing);
        ArgumentException.ThrowIfNullOrEmpty(recordKind);
        ArgumentException.ThrowIfNullOrEmpty(recordId);

        var envelope = new byte[PlaintextHeaderSizeBytes + plaintext.Length];
        envelope[0] = PlaintextFormatVersion2;
        plaintext.CopyTo(envelope.AsSpan(PlaintextHeaderSizeBytes));
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

        if (envelope.Length < PlaintextHeaderSizeBytes)
        {
            throw new EnvelopeIntegrityException(
                $"Envelope is {envelope.Length} bytes, shorter than the {PlaintextHeaderSizeBytes}-byte header.");
        }

        var formatVersion = envelope[0];
        if (formatVersion == PlaintextFormatVersion2)
        {
            return envelope[PlaintextHeaderSizeBytes..].ToArray();
        }

        if (formatVersion != SealedFormatVersion1)
        {
            throw new EnvelopeIntegrityException($"Unsupported envelope format version {formatVersion}.");
        }

        if (envelope.Length < SealedHeaderSizeBytes)
        {
            throw new EnvelopeIntegrityException(
                $"Envelope is {envelope.Length} bytes, shorter than the {SealedHeaderSizeBytes}-byte header.");
        }

        var keyVersion = BinaryPrimitives.ReadUInt32BigEndian(envelope.Slice(1, 4));
        var nonce = envelope.Slice(5, NonceSizeBytes);
        var tag = envelope.Slice(5 + NonceSizeBytes, TagSizeBytes);
        var ciphertext = envelope[SealedHeaderSizeBytes..];

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
