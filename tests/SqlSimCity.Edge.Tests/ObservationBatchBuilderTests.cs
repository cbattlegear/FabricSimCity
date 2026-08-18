using System.Text;
using SqlSimCity.Edge.Envelope;

namespace SqlSimCity.Edge.Tests;

public sealed class ObservationBatchBuilderTests
{
    private static ObservationFreshnessV1 Fresh => new(DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, null);

    [Fact]
    public void Small_payload_is_uncompressed_single_chunk()
    {
        var builder = new ObservationBatchBuilder("c", "t", "e", "b");
        builder.AddSection(ObservationSection.Atlas, 1, DateTimeOffset.UnixEpoch, Fresh, new { a = 1 });
        var batch = builder.Build("batch1", DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch);

        Assert.Single(batch.Envelopes);
        Assert.Equal(ObservationCompression.None, batch.Envelopes[0].Compression);
        Assert.Equal(1, batch.Envelopes[0].ChunkCount);
    }

    [Fact]
    public void Large_payload_is_gzip_compressed()
    {
        var builder = new ObservationBatchBuilder("c", "t", "e", "b");
        var big = new string('x', 50_000);
        builder.AddSection(ObservationSection.QueryStore, 1, DateTimeOffset.UnixEpoch, Fresh, new { blob = big });
        var batch = builder.Build("batch1", DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch);

        Assert.Equal(ObservationCompression.Gzip, batch.Envelopes[0].Compression);
    }

    [Fact]
    public void Content_digest_matches_payload()
    {
        var builder = new ObservationBatchBuilder("c", "t", "e", "b");
        builder.AddSection(ObservationSection.Atlas, 1, DateTimeOffset.UnixEpoch, Fresh, new { a = 1 });
        var envelope = builder.Build("batch1", DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch).Envelopes[0];

        var payloadBytes = Convert.FromBase64String(envelope.Payload);
        Assert.Equal(EdgeJson.Sha256Hex(payloadBytes), envelope.ContentDigest);
    }

    [Fact]
    public void Idempotency_key_is_stable_for_identical_content()
    {
        var a = Build(1);
        var b = Build(1);
        Assert.Equal(a.IdempotencyKey, b.IdempotencyKey);
    }

    [Fact]
    public void Idempotency_key_changes_with_sequence()
    {
        Assert.NotEqual(Build(1).IdempotencyKey, Build(2).IdempotencyKey);
    }

    private static ObservationBatchV1 Build(long sequence)
    {
        var builder = new ObservationBatchBuilder("c", "t", "e", "b");
        builder.AddSection(ObservationSection.Atlas, sequence, DateTimeOffset.UnixEpoch, Fresh, new { a = sequence });
        return builder.Build("batch-fixed-id", DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch);
    }
}
