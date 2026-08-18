using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SqlSimCity.Edge.Envelope;

/// <summary>
/// Shared JSON configuration and content-addressing helpers for the edge observation transport.
/// A single canonical serializer is used on both the connector and central sides so a content
/// digest computed by the producer verifies byte-for-byte on the consumer.
/// </summary>
public static class EdgeJson
{
    /// <summary>The one serializer both sides use for envelopes, batches, and section payloads.</summary>
    public static readonly JsonSerializerOptions Options = CreateOptions();

    private static JsonSerializerOptions CreateOptions()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            // Deterministic, compact, culture-invariant output. No indentation so the digest is
            // stable regardless of the producing platform.
            WriteIndented = false,
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        };
        options.Converters.Add(new JsonStringEnumConverter());
        return options;
    }

    /// <summary>Serializes <paramref name="value"/> to UTF-8 JSON bytes using the canonical options.</summary>
    public static byte[] SerializeToUtf8Bytes<T>(T value)
        => JsonSerializer.SerializeToUtf8Bytes(value, Options);

    /// <summary>Computes the lowercase hex SHA-256 of <paramref name="bytes"/>.</summary>
    public static string Sha256Hex(ReadOnlySpan<byte> bytes)
        => Convert.ToHexStringLower(SHA256.HashData(bytes));

    /// <summary>Computes the lowercase hex SHA-256 of a UTF-8 string.</summary>
    public static string Sha256Hex(string value)
        => Sha256Hex(Encoding.UTF8.GetBytes(value));
}
