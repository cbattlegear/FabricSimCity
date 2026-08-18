using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using SqlSimCity.Storage.Crypto;

namespace SqlSimCity.Storage.Tests;

using SqlSimCity.Storage;

/// <summary>
/// The envelope now writes payloads in the clear, because SQL SimCity exists to show captured
/// plans and workload evidence rather than to hide them. The AES-256-GCM read path is retained so
/// a store written before that change keeps opening, and these tests cover both halves: new
/// envelopes are readable, and legacy sealed envelopes still authenticate or fail closed.
/// </summary>
public sealed class EnvelopeCodecTests
{
    private static KeyRing SingleKeyRing(uint version = 1) =>
        new(version, new Dictionary<uint, byte[]> { [version] = KeyRingTestHelpers.NewKeyBytes() });

    [Fact]
    public void SealThenOpenRoundTripsPlaintext()
    {
        using var keyRing = SingleKeyRing();
        var plaintext = Encoding.UTF8.GetBytes("query-store-sample-payload");

        var envelope = EnvelopeCodec.Seal(keyRing, "query-store-sample", "record-1", plaintext);
        var opened = EnvelopeCodec.Open(keyRing, "query-store-sample", "record-1", envelope);

        Assert.Equal(plaintext, opened);
    }

    [Fact]
    public void SealWritesThePayloadInTheClear()
    {
        using var keyRing = SingleKeyRing();
        const string marker = "SELECT * FROM dbo.Customer WHERE Email = @p0";

        var envelope = EnvelopeCodec.Seal(keyRing, "kind", "id", Encoding.UTF8.GetBytes(marker));

        Assert.Contains(marker, Encoding.Latin1.GetString(envelope), StringComparison.Ordinal);
    }

    [Fact]
    public void SealMarksTheEnvelopeWithThePlaintextFormatVersionAndNoKeyMaterial()
    {
        using var keyRing = SingleKeyRing(version: 3);
        var plaintext = Encoding.UTF8.GetBytes("payload");

        var envelope = EnvelopeCodec.Seal(keyRing, "kind", "id", plaintext);

        Assert.Equal(2, envelope[0]);
        // No key version, nonce, or tag: the header is exactly the one format byte.
        Assert.Equal(plaintext.Length + 1, envelope.Length);
        Assert.Equal(plaintext, envelope[1..]);
    }

    [Fact]
    public void SealIsDeterministicBecauseNoNonceIsInvolved()
    {
        using var keyRing = SingleKeyRing();
        var plaintext = Encoding.UTF8.GetBytes("same-plaintext");

        Assert.Equal(
            EnvelopeCodec.Seal(keyRing, "kind", "id", plaintext),
            EnvelopeCodec.Seal(keyRing, "kind", "id", plaintext));
    }

    [Fact]
    public void OpenRoundTripsAnEmptyPayload()
    {
        using var keyRing = SingleKeyRing();

        var envelope = EnvelopeCodec.Seal(keyRing, "kind", "id", ReadOnlySpan<byte>.Empty);

        Assert.Empty(EnvelopeCodec.Open(keyRing, "kind", "id", envelope));
    }

    [Fact]
    public void OpenReadsLegacySealedEnvelopesSoAnExistingStoreKeepsWorking()
    {
        using var keyRing = SingleKeyRing();
        var plaintext = Encoding.UTF8.GetBytes("payload-sealed-before-the-change");
        var envelope = LegacyEnvelope.Seal(keyRing, 1, "kind", "id", plaintext);

        Assert.Equal(plaintext, EnvelopeCodec.Open(keyRing, "kind", "id", envelope));
    }

    [Fact]
    public void OpenRejectsTamperedLegacyNonce()
    {
        using var keyRing = SingleKeyRing();
        var envelope = LegacyEnvelope.Seal(keyRing, 1, "kind", "id", "payload"u8);
        envelope[5] ^= 0xFF; // first nonce byte

        Assert.Throws<EnvelopeIntegrityException>(() => EnvelopeCodec.Open(keyRing, "kind", "id", envelope));
    }

    [Fact]
    public void OpenRejectsTamperedLegacyTag()
    {
        using var keyRing = SingleKeyRing();
        var envelope = LegacyEnvelope.Seal(keyRing, 1, "kind", "id", "payload"u8);
        envelope[17] ^= 0xFF; // first tag byte

        Assert.Throws<EnvelopeIntegrityException>(() => EnvelopeCodec.Open(keyRing, "kind", "id", envelope));
    }

    [Fact]
    public void OpenRejectsTamperedLegacyCiphertext()
    {
        using var keyRing = SingleKeyRing();
        var envelope = LegacyEnvelope.Seal(keyRing, 1, "kind", "id", "payload-bytes"u8);
        envelope[^1] ^= 0xFF; // last ciphertext byte

        Assert.Throws<EnvelopeIntegrityException>(() => EnvelopeCodec.Open(keyRing, "kind", "id", envelope));
    }

    [Fact]
    public void OpenZerosUnauthenticatedLegacyPlaintextBuffer()
    {
        using var keyRing = SingleKeyRing();
        var envelope = LegacyEnvelope.Seal(keyRing, 1, "kind", "id", "payload"u8);
        envelope[^1] ^= 0xFF;
        byte[]? failedPlaintext = null;

        Assert.Throws<EnvelopeIntegrityException>(
            () => EnvelopeCodec.Open(keyRing, "kind", "id", envelope, bytes => failedPlaintext = bytes.ToArray()));

        Assert.NotNull(failedPlaintext);
        Assert.All(failedPlaintext!, value => Assert.Equal(0, value));
    }

    [Fact]
    public void OpenRejectsMismatchedRecordKindOnLegacyEnvelopes()
    {
        using var keyRing = SingleKeyRing();
        var envelope = LegacyEnvelope.Seal(keyRing, 1, "kind-a", "id", "payload"u8);

        Assert.Throws<EnvelopeIntegrityException>(() => EnvelopeCodec.Open(keyRing, "kind-b", "id", envelope));
    }

    [Fact]
    public void OpenRejectsLegacyCrossRecordSwap()
    {
        using var keyRing = SingleKeyRing();
        var envelopeForRecordA = LegacyEnvelope.Seal(keyRing, 1, "kind", "record-a", "payload"u8);

        // Simulate a bug copying record A's ciphertext onto record B's row.
        Assert.Throws<EnvelopeIntegrityException>(
            () => EnvelopeCodec.Open(keyRing, "kind", "record-b", envelopeForRecordA));
    }

    [Fact]
    public void OpenRejectsUnsupportedFormatVersion()
    {
        using var keyRing = SingleKeyRing();
        var envelope = EnvelopeCodec.Seal(keyRing, "kind", "id", "payload"u8);
        envelope[0] = 99;

        Assert.Throws<EnvelopeIntegrityException>(() => EnvelopeCodec.Open(keyRing, "kind", "id", envelope));
    }

    [Fact]
    public void OpenRejectsAnEmptyEnvelope()
    {
        using var keyRing = SingleKeyRing();

        Assert.Throws<EnvelopeIntegrityException>(() => EnvelopeCodec.Open(keyRing, "kind", "id", []));
    }

    [Fact]
    public void OpenRejectsATruncatedLegacyEnvelope()
    {
        using var keyRing = SingleKeyRing();
        var truncated = new byte[10];
        truncated[0] = 1;

        Assert.Throws<EnvelopeIntegrityException>(() => EnvelopeCodec.Open(keyRing, "kind", "id", truncated));
    }

    [Fact]
    public void OpenRejectsMissingKeyVersionOnLegacyEnvelopes()
    {
        using var keyRing = SingleKeyRing(version: 1);
        var envelope = LegacyEnvelope.Seal(keyRing, 1, "kind", "id", "payload"u8);
        using var otherRing = new KeyRing(2, new Dictionary<uint, byte[]> { [2] = KeyRingTestHelpers.NewKeyBytes() });

        Assert.Throws<KeyRingConfigurationException>(() => EnvelopeCodec.Open(otherRing, "kind", "id", envelope));
    }

    [Fact]
    public void OpenLegacyEnvelopeWithWrongKeyOfSameVersionFailsAuthentication()
    {
        using var keyRingA = SingleKeyRing(version: 1);
        using var keyRingB = SingleKeyRing(version: 1);
        var envelope = LegacyEnvelope.Seal(keyRingA, 1, "kind", "id", "payload"u8);

        Assert.Throws<EnvelopeIntegrityException>(() => EnvelopeCodec.Open(keyRingB, "kind", "id", envelope));
    }
}

/// <summary>
/// Builds the retired AES-256-GCM envelope so the compatibility read path stays covered.
/// Production code no longer writes this format, which is why the writer lives in the test project.
/// </summary>
internal static class LegacyEnvelope
{
    public static byte[] Seal(
        KeyRing keyRing,
        uint keyVersion,
        string recordKind,
        string recordId,
        ReadOnlySpan<byte> plaintext)
    {
        var key = keyRing.GetKey(keyVersion);
        Span<byte> nonce = stackalloc byte[12];
        RandomNumberGenerator.Fill(nonce);
        Span<byte> tag = stackalloc byte[16];
        var ciphertext = new byte[plaintext.Length];
        var aad = AssociatedData(recordKind, recordId, keyVersion);

        using (var aesGcm = new AesGcm(key, 16))
            aesGcm.Encrypt(nonce, plaintext, ciphertext, tag, aad);

        var envelope = new byte[33 + ciphertext.Length];
        var span = envelope.AsSpan();
        span[0] = 1;
        BinaryPrimitives.WriteUInt32BigEndian(span.Slice(1, 4), keyVersion);
        nonce.CopyTo(span.Slice(5, 12));
        tag.CopyTo(span.Slice(17, 16));
        ciphertext.CopyTo(span[33..]);
        return envelope;
    }

    private static byte[] AssociatedData(string recordKind, string recordId, uint keyVersion)
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
