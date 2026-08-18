using SqlSimCity.Edge.Envelope;

namespace SqlSimCity.Edge.Ingestion;

/// <summary>How the central server classified an ingested batch after validation.</summary>
public enum IngestionOutcome
{
    /// <summary>The batch validated and was published as a new generation.</summary>
    Accepted,

    /// <summary>An identical batch (same idempotency key and content) was already accepted; idempotent no-op.</summary>
    DuplicateAccepted,

    /// <summary>The batch conflicts with prior state (sequence rollback, reused id with different content, target collision).</summary>
    Conflict,

    /// <summary>The batch failed structural, size, digest, or schema validation.</summary>
    Rejected,
}

/// <summary>An ingestion decision plus a fixed, non-secret reason. Never echoes payloads or headers.</summary>
public sealed record IngestionResult(IngestionOutcome Outcome, string Reason)
{
    public static IngestionResult Accepted { get; } = new(IngestionOutcome.Accepted, "Accepted.");
    public static IngestionResult Duplicate { get; } = new(IngestionOutcome.DuplicateAccepted, "Duplicate batch accepted idempotently.");

    public static IngestionResult Conflict(string reason) => new(IngestionOutcome.Conflict, reason);
    public static IngestionResult Rejected(string reason) => new(IngestionOutcome.Rejected, reason);
}

/// <summary>Bounds applied to a decoded batch to resist oversized, deeply nested, or bomb payloads.</summary>
public sealed record IngestionLimits
{
    /// <summary>Maximum number of chunks in one batch.</summary>
    public int MaxEnvelopesPerBatch { get; init; } = 512;

    /// <summary>Maximum encoded (on-wire) payload bytes for one chunk.</summary>
    public int MaxChunkPayloadBytes { get; init; } = ObservationBatchBuilder.MaxChunkPayloadBytes;

    /// <summary>Maximum decompressed bytes a single chunk may expand to (compression-bomb guard).</summary>
    public int MaxDecompressedChunkBytes { get; init; } = 8 * 1024 * 1024;

    /// <summary>Maximum decompression expansion ratio permitted for one chunk.</summary>
    public int MaxDecompressionRatio { get; init; } = 100;

    /// <summary>Maximum number of chunks one section group may declare (bounds cross-batch buffering).</summary>
    public int MaxChunksPerGroup { get; init; } = 1024;

    /// <summary>Maximum reassembled bytes for one section across all its chunks.</summary>
    public int MaxSectionBytes { get; init; } = 32 * 1024 * 1024;
}
