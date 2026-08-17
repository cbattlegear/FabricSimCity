using System.Text;
using SqlSimCity.Storage.Crypto;

namespace SqlSimCity.Storage.Tests;

using SqlSimCity.Storage;

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
    public void SealProducesEnvelopeWithoutPlaintextSubstring()
    {
        using var keyRing = SingleKeyRing();
        var secret = "unmistakable-plaintext-marker-9f31";
        var plaintext = Encoding.UTF8.GetBytes(secret);

        var envelope = EnvelopeCodec.Seal(keyRing, "kind", "id", plaintext);

        Assert.DoesNotContain(secret, Encoding.Latin1.GetString(envelope), StringComparison.Ordinal);
    }

    [Fact]
    public void EachSealUsesADistinctRandomNonce()
    {
        using var keyRing = SingleKeyRing();
        var plaintext = Encoding.UTF8.GetBytes("same-plaintext");

        var envelopeA = EnvelopeCodec.Seal(keyRing, "kind", "id", plaintext);
        var envelopeB = EnvelopeCodec.Seal(keyRing, "kind", "id", plaintext);

        // Header layout: [version:1][keyVersion:4][nonce:12][tag:16][ciphertext...]
        var nonceA = envelopeA.AsSpan(5, 12).ToArray();
        var nonceB = envelopeB.AsSpan(5, 12).ToArray();
        Assert.NotEqual(nonceA, nonceB);
        // GCM with distinct nonces over identical plaintext must not produce identical ciphertext/tag.
        Assert.NotEqual(envelopeA, envelopeB);
    }

    [Fact]
    public void OpenRejectsTamperedNonce()
    {
        using var keyRing = SingleKeyRing();
        var envelope = EnvelopeCodec.Seal(keyRing, "kind", "id", Encoding.UTF8.GetBytes("payload"));
        envelope[5] ^= 0xFF; // first nonce byte

        Assert.Throws<EnvelopeIntegrityException>(() => EnvelopeCodec.Open(keyRing, "kind", "id", envelope));
    }

    [Fact]
    public void OpenRejectsTamperedTag()
    {
        using var keyRing = SingleKeyRing();
        var envelope = EnvelopeCodec.Seal(keyRing, "kind", "id", Encoding.UTF8.GetBytes("payload"));
        envelope[17] ^= 0xFF; // first tag byte

        Assert.Throws<EnvelopeIntegrityException>(() => EnvelopeCodec.Open(keyRing, "kind", "id", envelope));
    }

    [Fact]
    public void OpenRejectsTamperedCiphertext()
    {
        using var keyRing = SingleKeyRing();
        var envelope = EnvelopeCodec.Seal(keyRing, "kind", "id", Encoding.UTF8.GetBytes("payload-bytes"));
        envelope[^1] ^= 0xFF; // last ciphertext byte

        Assert.Throws<EnvelopeIntegrityException>(() => EnvelopeCodec.Open(keyRing, "kind", "id", envelope));
    }

    [Fact]
    public void OpenRejectsMismatchedRecordKind()
    {
        using var keyRing = SingleKeyRing();
        var envelope = EnvelopeCodec.Seal(keyRing, "kind-a", "id", Encoding.UTF8.GetBytes("payload"));

        Assert.Throws<EnvelopeIntegrityException>(() => EnvelopeCodec.Open(keyRing, "kind-b", "id", envelope));
    }

    [Fact]
    public void OpenRejectsCrossRecordSwap()
    {
        using var keyRing = SingleKeyRing();
        var envelopeForRecordA = EnvelopeCodec.Seal(keyRing, "kind", "record-a", Encoding.UTF8.GetBytes("payload"));

        // Simulate an attacker (or bug) copying record A's ciphertext onto record B's row.
        Assert.Throws<EnvelopeIntegrityException>(
            () => EnvelopeCodec.Open(keyRing, "kind", "record-b", envelopeForRecordA));
    }

    [Fact]
    public void OpenRejectsUnsupportedFormatVersion()
    {
        using var keyRing = SingleKeyRing();
        var envelope = EnvelopeCodec.Seal(keyRing, "kind", "id", Encoding.UTF8.GetBytes("payload"));
        envelope[0] = 99;

        Assert.Throws<EnvelopeIntegrityException>(() => EnvelopeCodec.Open(keyRing, "kind", "id", envelope));
    }

    [Fact]
    public void OpenRejectsTruncatedEnvelope()
    {
        using var keyRing = SingleKeyRing();
        var envelope = new byte[10];

        Assert.Throws<EnvelopeIntegrityException>(() => EnvelopeCodec.Open(keyRing, "kind", "id", envelope));
    }

    [Fact]
    public void OpenRejectsMissingKeyVersion()
    {
        using var keyRing = SingleKeyRing(version: 1);
        var envelope = EnvelopeCodec.Seal(keyRing, "kind", "id", Encoding.UTF8.GetBytes("payload"));
        using var otherRing = new KeyRing(2, new Dictionary<uint, byte[]> { [2] = KeyRingTestHelpers.NewKeyBytes() });

        Assert.Throws<KeyRingConfigurationException>(() => EnvelopeCodec.Open(otherRing, "kind", "id", envelope));
    }

    [Fact]
    public void OpenWithWrongKeyOfSameVersionFailsAuthentication()
    {
        using var keyRingA = SingleKeyRing(version: 1);
        using var keyRingB = SingleKeyRing(version: 1);
        var envelope = EnvelopeCodec.Seal(keyRingA, "kind", "id", Encoding.UTF8.GetBytes("payload"));

        Assert.Throws<EnvelopeIntegrityException>(() => EnvelopeCodec.Open(keyRingB, "kind", "id", envelope));
    }

    [Fact]
    public void SealsWithActiveKeyVersionAndEmbedsItInHeader()
    {
        using var keyRing = new KeyRing(
            activeKeyVersion: 3,
            keysByVersion: new Dictionary<uint, byte[]>
            {
                [1] = KeyRingTestHelpers.NewKeyBytes(),
                [3] = KeyRingTestHelpers.NewKeyBytes(),
            });

        var envelope = EnvelopeCodec.Seal(keyRing, "kind", "id", Encoding.UTF8.GetBytes("payload"));
        var embeddedKeyVersion = System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(envelope.AsSpan(1, 4));

        Assert.Equal(3u, embeddedKeyVersion);
    }
}
