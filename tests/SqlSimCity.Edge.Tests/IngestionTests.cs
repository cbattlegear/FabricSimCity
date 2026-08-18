using System.IO.Compression;
using System.Text;
using SqlSimCity.Edge.Envelope;
using SqlSimCity.Edge.Ingestion;

namespace SqlSimCity.Edge.Tests;

public sealed class IngestionTests
{
    private static readonly IngestionLimits Limits = new();
    private static ObservationFreshnessV1 Fresh => new(DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, null);

    private static ObservationEnvelopeV1 Chunk(
        byte[] content,
        ObservationCompression compression = ObservationCompression.None,
        string connectorId = "c",
        string targetId = "t",
        long sequence = 1,
        string epoch = "e1",
        string groupId = "g1",
        int index = 0,
        int count = 1,
        ObservationSection section = ObservationSection.Atlas)
        => new(
            "1.0", connectorId, targetId, sequence, epoch, "boot", DateTimeOffset.UnixEpoch,
            section, groupId, index, count, compression, EdgeJson.Sha256Hex(content), Fresh,
            Convert.ToBase64String(content));

    private static ObservationBatchV1 Batch(string connectorId, string batchId, params ObservationEnvelopeV1[] envelopes)
        => new("1.0", connectorId, batchId, ObservationBatchBuilder.DeriveIdempotencyKey(connectorId, envelopes),
            DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, envelopes);

    private static byte[] Json(string s) => Encoding.UTF8.GetBytes(s);

    private static byte[] Gzip(byte[] raw)
    {
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.Optimal, leaveOpen: true))
            gzip.Write(raw, 0, raw.Length);
        return output.ToArray();
    }

    [Fact]
    public void Valid_batch_is_accepted_and_section_published()
    {
        var store = new EdgeObservationStore();
        var batch = Batch("c", "b1", Chunk(Json("{\"v\":1}")));

        Assert.True(EdgeBatchValidator.TryValidate(batch, Limits, out var chunks, out _));
        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(batch, chunks).Outcome);

        var section = store.GetSection("t", ObservationSection.Atlas);
        Assert.NotNull(section);
        Assert.Equal("{\"v\":1}", Encoding.UTF8.GetString(section!.Content));
    }

    [Fact]
    public void Digest_mismatch_is_rejected()
    {
        var tampered = Chunk(Json("{\"v\":1}")) with { ContentDigest = new string('0', 64) };
        var batch = Batch("c", "b1", tampered);
        Assert.False(EdgeBatchValidator.TryValidate(batch, Limits, out _, out var result));
        Assert.Equal(IngestionOutcome.Rejected, result.Outcome);
    }

    [Fact]
    public void Oversized_chunk_is_rejected()
    {
        var limits = new IngestionLimits { MaxChunkPayloadBytes = 16 };
        var batch = Batch("c", "b1", Chunk(Json("{\"v\":\"aaaaaaaaaaaaaaaaaaaaaaaa\"}")));
        Assert.False(EdgeBatchValidator.TryValidate(batch, limits, out _, out var result));
        Assert.Equal(IngestionOutcome.Rejected, result.Outcome);
    }

    [Fact]
    public void Compression_bomb_is_rejected()
    {
        var raw = new byte[2_000_000]; // 2 MB of zeros compresses tiny
        var compressed = Gzip(raw);
        var limits = new IngestionLimits { MaxDecompressedChunkBytes = 64 * 1024, MaxDecompressionRatio = 1000 };
        var batch = Batch("c", "b1", Chunk(compressed, ObservationCompression.Gzip));

        Assert.False(EdgeBatchValidator.TryValidate(batch, limits, out _, out var result));
        Assert.Equal(IngestionOutcome.Rejected, result.Outcome);
    }

    [Fact]
    public void Duplicate_batch_is_idempotent()
    {
        var store = new EdgeObservationStore();
        var batch = Batch("c", "b1", Chunk(Json("{\"v\":1}")));
        EdgeBatchValidator.TryValidate(batch, Limits, out var chunks, out _);

        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(batch, chunks).Outcome);
        Assert.Equal(IngestionOutcome.DuplicateAccepted, store.Ingest(batch, chunks).Outcome);
    }

    [Fact]
    public void Batch_id_reuse_with_different_content_conflicts()
    {
        var store = new EdgeObservationStore();
        var first = Batch("c", "reused", Chunk(Json("{\"v\":1}"), sequence: 1));
        var second = Batch("c", "reused", Chunk(Json("{\"v\":2}"), sequence: 2));
        EdgeBatchValidator.TryValidate(first, Limits, out var c1, out _);
        EdgeBatchValidator.TryValidate(second, Limits, out var c2, out _);

        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(first, c1).Outcome);
        Assert.Equal(IngestionOutcome.Conflict, store.Ingest(second, c2).Outcome);
    }

    [Fact]
    public void Sequence_rollback_conflicts()
    {
        var store = new EdgeObservationStore();
        var higher = Batch("c", "b2", Chunk(Json("{\"v\":2}"), sequence: 5));
        var lower = Batch("c", "b1", Chunk(Json("{\"v\":1}"), sequence: 3));
        EdgeBatchValidator.TryValidate(higher, Limits, out var ch, out _);
        EdgeBatchValidator.TryValidate(lower, Limits, out var cl, out _);

        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(higher, ch).Outcome);
        Assert.Equal(IngestionOutcome.Conflict, store.Ingest(lower, cl).Outcome);
    }

    [Fact]
    public void New_epoch_resets_sequence_baseline()
    {
        var store = new EdgeObservationStore();
        var high = Batch("c", "b1", Chunk(Json("{\"v\":9}"), sequence: 9, epoch: "e1"));
        var newEpoch = Batch("c", "b2", Chunk(Json("{\"v\":0}"), sequence: 0, epoch: "e2"));
        EdgeBatchValidator.TryValidate(high, Limits, out var c1, out _);
        EdgeBatchValidator.TryValidate(newEpoch, Limits, out var c2, out _);

        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(high, c1).Outcome);
        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(newEpoch, c2).Outcome);
        Assert.Equal("e2", store.GetSection("t", ObservationSection.Atlas)!.EpochId);
    }

    [Fact]
    public void Retired_epoch_replay_conflicts()
    {
        var store = new EdgeObservationStore();
        var e1 = Batch("c", "b1", Chunk(Json("{\"v\":1}"), sequence: 1, epoch: "e1"));
        var e2 = Batch("c", "b2", Chunk(Json("{\"v\":2}"), sequence: 1, epoch: "e2"));
        var replayE1 = Batch("c", "b3", Chunk(Json("{\"v\":3}"), sequence: 2, epoch: "e1"));
        EdgeBatchValidator.TryValidate(e1, Limits, out var c1, out _);
        EdgeBatchValidator.TryValidate(e2, Limits, out var c2, out _);
        EdgeBatchValidator.TryValidate(replayE1, Limits, out var c3, out _);

        store.Ingest(e1, c1);
        store.Ingest(e2, c2);
        Assert.Equal(IngestionOutcome.Conflict, store.Ingest(replayE1, c3).Outcome);
    }

    [Fact]
    public void Target_owned_by_another_connector_conflicts()
    {
        var store = new EdgeObservationStore();
        var a = Batch("connector-a", "b1", Chunk(Json("{\"v\":1}"), connectorId: "connector-a", targetId: "shared"));
        var b = Batch("connector-b", "b2", Chunk(Json("{\"v\":2}"), connectorId: "connector-b", targetId: "shared", sequence: 2));
        EdgeBatchValidator.TryValidate(a, Limits, out var ca, out _);
        EdgeBatchValidator.TryValidate(b, Limits, out var cb, out _);

        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(a, ca).Outcome);
        Assert.Equal(IngestionOutcome.Conflict, store.Ingest(b, cb).Outcome);
    }

    [Fact]
    public void Group_published_only_when_all_chunks_arrive_across_batches()
    {
        var store = new EdgeObservationStore();
        var part0 = Chunk(Json("HELLO"), groupId: "g", index: 0, count: 2, sequence: 1);
        var part1 = Chunk(Json("WORLD"), groupId: "g", index: 1, count: 2, sequence: 1);
        var b1 = Batch("c", "b1", part0);
        var b2 = Batch("c", "b2", part1);

        EdgeBatchValidator.TryValidate(b1, Limits, out var c1, out _);
        EdgeBatchValidator.TryValidate(b2, Limits, out var c2, out _);

        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(b1, c1).Outcome);
        Assert.Null(store.GetSection("t", ObservationSection.Atlas)); // not yet complete

        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(b2, c2).Outcome);
        var section = store.GetSection("t", ObservationSection.Atlas);
        Assert.NotNull(section);
        Assert.Equal("HELLOWORLD", Encoding.UTF8.GetString(section!.Content));
    }

    [Fact]
    public void Chunk_count_above_group_limit_is_rejected()
    {
        var limits = new IngestionLimits { MaxChunksPerGroup = 1 };
        var batch = Batch("c", "b1", Chunk(Json("{\"v\":1}"), index: 0, count: 2));
        Assert.False(EdgeBatchValidator.TryValidate(batch, limits, out _, out var result));
        Assert.Equal(IngestionOutcome.Rejected, result.Outcome);
    }

    [Fact]
    public void Section_exceeding_max_reassembled_size_is_rejected()
    {
        var store = new EdgeObservationStore(maxSectionBytes: 8);
        var batch = Batch("c", "b1", Chunk(Json("{\"value\":\"way too long\"}")));
        Assert.True(EdgeBatchValidator.TryValidate(batch, Limits, out var chunks, out _));
        Assert.Equal(IngestionOutcome.Rejected, store.Ingest(batch, chunks).Outcome);
        Assert.Null(store.GetSection("t", ObservationSection.Atlas));
    }

    [Fact]
    public void Multiple_targets_do_not_mix()
    {
        var store = new EdgeObservationStore();
        var t1 = Batch("c", "b1", Chunk(Json("{\"t\":1}"), targetId: "t1"));
        var t2 = Batch("c", "b2", Chunk(Json("{\"t\":2}"), targetId: "t2"));
        EdgeBatchValidator.TryValidate(t1, Limits, out var c1, out _);
        EdgeBatchValidator.TryValidate(t2, Limits, out var c2, out _);
        store.Ingest(t1, c1);
        store.Ingest(t2, c2);

        Assert.Equal("{\"t\":1}", Encoding.UTF8.GetString(store.GetSection("t1", ObservationSection.Atlas)!.Content));
        Assert.Equal("{\"t\":2}", Encoding.UTF8.GetString(store.GetSection("t2", ObservationSection.Atlas)!.Content));
        Assert.Equal(2, store.GetTargets().Count);
    }
}
