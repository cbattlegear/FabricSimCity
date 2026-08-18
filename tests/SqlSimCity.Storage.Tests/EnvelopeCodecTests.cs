using System.Text;
using SqlSimCity.Storage;
using SqlSimCity.Storage.Crypto;

namespace SqlSimCity.Storage.Tests;

/// <summary>
/// The envelope carries a version byte and the payload, nothing else. These tests hold it to
/// that: the payload must be recoverable byte for byte, must be readable in the file, and a
/// record written by the encrypting builds must be reported by name rather than mistaken for
/// payload bytes.
/// </summary>
public class EnvelopeCodecTests
{
    private const string Kind = "query-family";
    private const string Id = "family/0x1A";

    private static byte[] Payload(string text) => Encoding.UTF8.GetBytes(text);

    [Fact]
    public void WrapThenUnwrapRoundTripsThePayload()
    {
        var payload = Payload("SELECT TOP (10) * FROM dbo.Orders;");

        var envelope = EnvelopeCodec.Wrap(Kind, Id, payload);
        var recovered = EnvelopeCodec.Unwrap(Kind, Id, envelope);

        Assert.Equal(payload, recovered);
    }

    [Fact]
    public void WrapWritesThePayloadInTheClear()
    {
        var payload = Payload("SELECT dbo.Orders.CustomerId FROM dbo.Orders;");

        var envelope = EnvelopeCodec.Wrap(Kind, Id, payload);

        // The whole point of the format: an operator can read what was collected.
        Assert.Contains("FROM dbo.Orders", Encoding.UTF8.GetString(envelope), StringComparison.Ordinal);
        Assert.Equal(payload, envelope[1..]);
    }

    [Fact]
    public void WrapMarksTheEnvelopeWithThePlaintextFormatVersionAndAddsNothingElse()
    {
        var payload = Payload("plan xml");

        var envelope = EnvelopeCodec.Wrap(Kind, Id, payload);

        Assert.Equal(2, envelope[0]);
        // One header byte and not a byte more: no nonce, no tag, no key version.
        Assert.Equal(payload.Length + 1, envelope.Length);
    }

    [Fact]
    public void WrapIsDeterministic()
    {
        var payload = Payload("same input");

        Assert.Equal(
            EnvelopeCodec.Wrap(Kind, Id, payload),
            EnvelopeCodec.Wrap(Kind, Id, payload));
    }

    [Fact]
    public void UnwrapRoundTripsAnEmptyPayload()
    {
        var envelope = EnvelopeCodec.Wrap(Kind, Id, []);

        Assert.Empty(EnvelopeCodec.Unwrap(Kind, Id, envelope));
    }

    [Fact]
    public void RecordKindAndIdDoNotChangeTheBytesBecauseNothingIsAuthenticated()
    {
        var payload = Payload("unbound payload");

        var written = EnvelopeCodec.Wrap(Kind, Id, payload);

        // Stated so the removal of authenticated associated data is deliberate and visible:
        // a record read under a different kind or id still returns its payload.
        Assert.Equal(payload, EnvelopeCodec.Unwrap("other-kind", "other-id", written));
    }

    [Fact]
    public void UnwrapReportsAnEncryptedRecordFromAnEarlierBuildByName()
    {
        // A version-1 envelope as the encrypting builds wrote it: version, key version, nonce,
        // tag, ciphertext. Nothing here can open it, so it must say so rather than hand back
        // the header and ciphertext as if they were a payload.
        var legacy = new byte[1 + 4 + 12 + 16 + 8];
        legacy[0] = 1;

        var error = Assert.Throws<EnvelopeIntegrityException>(
            () => EnvelopeCodec.Unwrap(Kind, Id, legacy));

        Assert.Contains("encrypted protected storage", error.Message, StringComparison.Ordinal);
        Assert.Contains("Delete the store directory", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void UnwrapRejectsUnsupportedFormatVersion()
    {
        var envelope = new byte[] { 9, 1, 2, 3 };

        var error = Assert.Throws<EnvelopeIntegrityException>(
            () => EnvelopeCodec.Unwrap(Kind, Id, envelope));

        Assert.Contains("format version 9", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void UnwrapRejectsAnEmptyEnvelope()
    {
        var error = Assert.Throws<EnvelopeIntegrityException>(
            () => EnvelopeCodec.Unwrap(Kind, Id, []));

        Assert.Contains("shorter than", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("", "id")]
    [InlineData("kind", "")]
    public void WrapRejectsEmptyRecordIdentity(string recordKind, string recordId)
    {
        Assert.Throws<ArgumentException>(
            () => EnvelopeCodec.Wrap(recordKind, recordId, Payload("x")));
    }

    [Theory]
    [InlineData("", "id")]
    [InlineData("kind", "")]
    public void UnwrapRejectsEmptyRecordIdentity(string recordKind, string recordId)
    {
        var envelope = EnvelopeCodec.Wrap(Kind, Id, Payload("x"));

        Assert.Throws<ArgumentException>(
            () => EnvelopeCodec.Unwrap(recordKind, recordId, envelope));
    }
}
