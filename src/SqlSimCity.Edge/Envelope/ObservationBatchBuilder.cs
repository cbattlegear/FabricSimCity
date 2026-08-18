using System.IO.Compression;
using System.Text;

namespace SqlSimCity.Edge.Envelope;

/// <summary>
/// Builds ordered, content-addressed <see cref="ObservationEnvelopeV1"/> chunks and assembles them
/// into a signed-ready <see cref="ObservationBatchV1"/>. Splitting only ever happens at the
/// predefined <see cref="MaxChunkPayloadBytes"/> boundary, so a central 413 response can be honored
/// by re-sending fewer whole chunks rather than by re-cutting a section mid-record.
/// </summary>
public sealed class ObservationBatchBuilder
{
    /// <summary>Hard ceiling on a single chunk's encoded payload, in bytes.</summary>
    public const int MaxChunkPayloadBytes = 256 * 1024;

    /// <summary>Payloads at or above this size are gzip-compressed before chunking.</summary>
    public const int CompressionThresholdBytes = 4 * 1024;

    private readonly string _connectorId;
    private readonly string _targetId;
    private readonly string _epochId;
    private readonly string _bootId;
    private readonly List<ObservationEnvelopeV1> _envelopes = new();

    public ObservationBatchBuilder(string connectorId, string targetId, string epochId, string bootId)
    {
        _connectorId = Require(connectorId, nameof(connectorId));
        _targetId = Require(targetId, nameof(targetId));
        _epochId = Require(epochId, nameof(epochId));
        _bootId = Require(bootId, nameof(bootId));
    }

    /// <summary>Whether any section has been added yet.</summary>
    public bool IsEmpty => _envelopes.Count == 0;

    /// <summary>
    /// Adds one evidence section, encoding and splitting it into ordered chunks. The section is
    /// serialized with the canonical serializer, gzip-compressed when large, and split at
    /// <see cref="MaxChunkPayloadBytes"/>.
    /// </summary>
    public void AddSection<T>(
        ObservationSection section,
        long sequence,
        DateTimeOffset capturedAt,
        ObservationFreshnessV1 freshness,
        T payload)
    {
        ArgumentNullException.ThrowIfNull(freshness);
        var raw = EdgeJson.SerializeToUtf8Bytes(payload);
        var (bytes, compression) = MaybeCompress(raw);
        var chunkGroupId = $"{section}:{sequence}:{_epochId}";
        var chunks = SplitIntoChunks(bytes, MaxChunkPayloadBytes);

        for (var index = 0; index < chunks.Count; index++)
        {
            var chunk = chunks[index];
            _envelopes.Add(new ObservationEnvelopeV1(
                SchemaVersion: "1.0",
                ConnectorId: _connectorId,
                TargetId: _targetId,
                Sequence: sequence,
                EpochId: _epochId,
                BootId: _bootId,
                CapturedAt: capturedAt,
                Section: section,
                ChunkGroupId: chunkGroupId,
                ChunkIndex: index,
                ChunkCount: chunks.Count,
                Compression: compression,
                ContentDigest: EdgeJson.Sha256Hex(chunk),
                Freshness: freshness,
                Payload: Convert.ToBase64String(chunk)));
        }
    }

    /// <summary>Assembles the accumulated chunks into an immutable batch with a derived idempotency key.</summary>
    public ObservationBatchV1 Build(string batchId, DateTimeOffset createdAt, DateTimeOffset publishedAt)
    {
        Require(batchId, nameof(batchId));
        if (_envelopes.Count == 0)
            throw new InvalidOperationException("A batch must contain at least one observation chunk.");

        var envelopes = _envelopes.ToArray();
        return new ObservationBatchV1(
            SchemaVersion: "1.0",
            ConnectorId: _connectorId,
            BatchId: batchId,
            IdempotencyKey: DeriveIdempotencyKey(_connectorId, envelopes),
            CreatedAt: createdAt,
            PublishedAt: publishedAt,
            Envelopes: envelopes);
    }

    /// <summary>
    /// Derives a stable idempotency key from the connector id and each chunk's identity and digest,
    /// so an identical batch re-sent after a delivery timeout resolves to the same key while any
    /// change to content, order, or sequence produces a different one.
    /// </summary>
    public static string DeriveIdempotencyKey(string connectorId, IReadOnlyList<ObservationEnvelopeV1> envelopes)
    {
        var canonical = new StringBuilder();
        canonical.Append(connectorId).Append('\n');
        foreach (var envelope in envelopes)
        {
            canonical.Append(envelope.TargetId).Append('|')
                .Append(envelope.Sequence).Append('|')
                .Append(envelope.Section).Append('|')
                .Append(envelope.ChunkGroupId).Append('|')
                .Append(envelope.ChunkIndex).Append('/')
                .Append(envelope.ChunkCount).Append('|')
                .Append(envelope.ContentDigest).Append('\n');
        }

        return EdgeJson.Sha256Hex(canonical.ToString());
    }

    private static (byte[] Bytes, ObservationCompression Compression) MaybeCompress(byte[] raw)
    {
        if (raw.Length < CompressionThresholdBytes)
            return (raw, ObservationCompression.None);

        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.Optimal, leaveOpen: true))
        {
            gzip.Write(raw, 0, raw.Length);
        }

        var compressed = output.ToArray();
        // Never let "compression" grow the payload.
        return compressed.Length < raw.Length
            ? (compressed, ObservationCompression.Gzip)
            : (raw, ObservationCompression.None);
    }

    private static List<byte[]> SplitIntoChunks(byte[] bytes, int maxChunkSize)
    {
        if (bytes.Length == 0)
            return new List<byte[]> { Array.Empty<byte>() };

        var chunks = new List<byte[]>();
        for (var offset = 0; offset < bytes.Length; offset += maxChunkSize)
        {
            var length = Math.Min(maxChunkSize, bytes.Length - offset);
            var chunk = new byte[length];
            Array.Copy(bytes, offset, chunk, 0, length);
            chunks.Add(chunk);
        }

        return chunks;
    }

    private static string Require(string value, string name)
        => string.IsNullOrWhiteSpace(value)
            ? throw new ArgumentException($"{name} must be a non-empty value.", name)
            : value;
}
