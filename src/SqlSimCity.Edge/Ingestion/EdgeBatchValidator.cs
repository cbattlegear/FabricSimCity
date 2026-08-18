using System.IO.Compression;
using SqlSimCity.Edge.Envelope;

namespace SqlSimCity.Edge.Ingestion;

/// <summary>A single chunk that passed structural, size, digest, and safe-decompression validation.</summary>
public sealed record ValidatedChunk(
    string TargetId,
    ObservationSection Section,
    long Sequence,
    string EpochId,
    string BootId,
    DateTimeOffset CapturedAt,
    ObservationFreshnessV1 Freshness,
    string ChunkGroupId,
    int ChunkIndex,
    int ChunkCount,
    byte[] Content);

/// <summary>
/// Validates a decoded <see cref="ObservationBatchV1"/> chunk by chunk before any state is mutated.
/// It enforces schema versions, connector-id consistency, per-chunk size and digest integrity, and
/// safe gzip decompression with an absolute size and ratio cap (compression-bomb guard). Group
/// completeness is deliberately <em>not</em> required here: a large section may be paged across
/// several batches (or a 413 response may split one batch), so the store reassembles groups across
/// batches and only publishes a section once every chunk of its group has arrived.
/// </summary>
public static class EdgeBatchValidator
{
    private const string SupportedSchema = "1.0";

    public static bool TryValidate(
        ObservationBatchV1 batch,
        IngestionLimits limits,
        out IReadOnlyList<ValidatedChunk> chunks,
        out IngestionResult result)
    {
        chunks = Array.Empty<ValidatedChunk>();
        ArgumentNullException.ThrowIfNull(batch);
        ArgumentNullException.ThrowIfNull(limits);

        if (batch.SchemaVersion != SupportedSchema)
        {
            result = IngestionResult.Rejected("Unsupported batch schema version.");
            return false;
        }

        if (string.IsNullOrWhiteSpace(batch.ConnectorId) || string.IsNullOrWhiteSpace(batch.BatchId) ||
            string.IsNullOrWhiteSpace(batch.IdempotencyKey))
        {
            result = IngestionResult.Rejected("Batch is missing required identifiers.");
            return false;
        }

        if (batch.Envelopes is null || batch.Envelopes.Count == 0)
        {
            result = IngestionResult.Rejected("Batch contains no observation chunks.");
            return false;
        }

        if (batch.Envelopes.Count > limits.MaxEnvelopesPerBatch)
        {
            result = IngestionResult.Rejected("Batch exceeds the maximum chunk count.");
            return false;
        }

        var validated = new List<ValidatedChunk>(batch.Envelopes.Count);
        var seenWithinBatch = new HashSet<string>(StringComparer.Ordinal);

        foreach (var envelope in batch.Envelopes)
        {
            if (envelope.SchemaVersion != SupportedSchema)
            {
                result = IngestionResult.Rejected("Unsupported chunk schema version.");
                return false;
            }

            if (!string.Equals(envelope.ConnectorId, batch.ConnectorId, StringComparison.Ordinal))
            {
                result = IngestionResult.Rejected("Chunk connector id does not match the batch.");
                return false;
            }

            if (string.IsNullOrWhiteSpace(envelope.TargetId) || string.IsNullOrWhiteSpace(envelope.EpochId) ||
                string.IsNullOrWhiteSpace(envelope.ChunkGroupId) || string.IsNullOrWhiteSpace(envelope.BootId))
            {
                result = IngestionResult.Rejected("Chunk is missing required identifiers.");
                return false;
            }

            if (envelope.Sequence < 0 || envelope.ChunkCount < 1 ||
                envelope.ChunkIndex < 0 || envelope.ChunkIndex >= envelope.ChunkCount)
            {
                result = IngestionResult.Rejected("Chunk index or count is out of range.");
                return false;
            }

            if (envelope.ChunkCount > limits.MaxChunksPerGroup)
            {
                result = IngestionResult.Rejected("Chunk group declares too many chunks.");
                return false;
            }

            if (envelope.Freshness is null)
            {
                result = IngestionResult.Rejected("Chunk is missing source freshness.");
                return false;
            }

            if (!seenWithinBatch.Add($"{envelope.ChunkGroupId}#{envelope.ChunkIndex}"))
            {
                result = IngestionResult.Rejected("Duplicate chunk index within the batch.");
                return false;
            }

            byte[] encoded;
            try
            {
                encoded = Convert.FromBase64String(envelope.Payload);
            }
            catch (FormatException)
            {
                result = IngestionResult.Rejected("Chunk payload is not valid base64.");
                return false;
            }

            if (encoded.Length > limits.MaxChunkPayloadBytes)
            {
                result = IngestionResult.Rejected("Chunk payload exceeds the maximum size.");
                return false;
            }

            if (!string.Equals(EdgeJson.Sha256Hex(encoded), envelope.ContentDigest, StringComparison.OrdinalIgnoreCase))
            {
                result = IngestionResult.Rejected("Chunk content digest does not match its payload.");
                return false;
            }

            if (!TryDecode(encoded, envelope.Compression, limits, out var decoded))
            {
                result = IngestionResult.Rejected("Chunk failed safe decompression bounds.");
                return false;
            }

            validated.Add(new ValidatedChunk(
                envelope.TargetId, envelope.Section, envelope.Sequence, envelope.EpochId, envelope.BootId,
                envelope.CapturedAt, envelope.Freshness, envelope.ChunkGroupId, envelope.ChunkIndex,
                envelope.ChunkCount, decoded));
        }

        chunks = validated;
        result = IngestionResult.Accepted;
        return true;
    }

    private static bool TryDecode(byte[] encoded, ObservationCompression compression, IngestionLimits limits, out byte[] decoded)
    {
        decoded = Array.Empty<byte>();
        if (compression == ObservationCompression.None)
        {
            decoded = encoded;
            return true;
        }

        var cap = Math.Min(
            limits.MaxDecompressedChunkBytes,
            (long)encoded.Length * limits.MaxDecompressionRatio);

        using var input = new MemoryStream(encoded, writable: false);
        using var gzip = new GZipStream(input, CompressionMode.Decompress);
        using var output = new MemoryStream();
        var buffer = new byte[81920];
        long total = 0;
        int read;
        while ((read = gzip.Read(buffer, 0, buffer.Length)) > 0)
        {
            total += read;
            if (total > cap)
                return false;
            output.Write(buffer, 0, read);
        }

        decoded = output.ToArray();
        return true;
    }
}
