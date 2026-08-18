using System.Security.Cryptography;
using SqlSimCity.Edge.Envelope;

namespace SqlSimCity.Edge.Signing;

/// <summary>
/// The material a connector attaches to an outbound request so the central server can authenticate
/// it. Carries no secret; only the derived signature and the public canonicalization inputs.
/// </summary>
public sealed record SignedRequestHeaders(
    string ConnectorId,
    string KeyId,
    long UnixTimeSeconds,
    string Nonce,
    string BodySha256Hex,
    string Signature)
{
    /// <summary>Materializes these values as the wire header name/value pairs.</summary>
    public IReadOnlyDictionary<string, string> ToHeaderMap() => new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [EdgeSignatureHeaders.Connector] = ConnectorId,
        [EdgeSignatureHeaders.KeyId] = KeyId,
        [EdgeSignatureHeaders.Timestamp] = UnixTimeSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture),
        [EdgeSignatureHeaders.Nonce] = Nonce,
        [EdgeSignatureHeaders.ContentSha256] = BodySha256Hex,
        [EdgeSignatureHeaders.Signature] = Signature,
    };
}

/// <summary>
/// Signs an outbound request body with a connector's shared secret using HMAC-SHA-256 over the
/// <see cref="CanonicalSignedRequest"/>. The signer generates a fresh random nonce per request and
/// never logs or returns the secret. Key material is zeroed after use is the caller's responsibility
/// (the secret is passed in per call and not retained here).
/// </summary>
public sealed class HmacRequestSigner
{
    private readonly TimeProvider _timeProvider;

    public HmacRequestSigner(TimeProvider? timeProvider = null)
        => _timeProvider = timeProvider ?? TimeProvider.System;

    /// <summary>
    /// Computes signature headers for <paramref name="body"/> bound to <paramref name="method"/> and
    /// <paramref name="path"/>. The secret is used only to key the HMAC and is never copied out.
    /// </summary>
    public SignedRequestHeaders Sign(
        string method,
        string path,
        string connectorId,
        string keyId,
        ReadOnlySpan<byte> secret,
        ReadOnlySpan<byte> body)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(method);
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        ArgumentException.ThrowIfNullOrWhiteSpace(connectorId);
        ArgumentException.ThrowIfNullOrWhiteSpace(keyId);

        var nonce = GenerateNonce();
        var timestamp = _timeProvider.GetUtcNow().ToUnixTimeSeconds();
        var bodyDigest = EdgeJson.Sha256Hex(body);

        var canonical = new CanonicalSignedRequest(method, path, timestamp, nonce, connectorId, keyId, bodyDigest);
        var signature = ComputeSignature(secret, canonical);

        return new SignedRequestHeaders(connectorId, keyId, timestamp, nonce, bodyDigest, signature);
    }

    internal static string ComputeSignature(ReadOnlySpan<byte> secret, CanonicalSignedRequest canonical)
    {
        Span<byte> mac = stackalloc byte[32];
        var written = HMACSHA256.HashData(secret, canonical.ToCanonicalBytes(), mac);
        return Convert.ToBase64String(mac[..written]);
    }

    private static string GenerateNonce()
    {
        Span<byte> nonce = stackalloc byte[16];
        RandomNumberGenerator.Fill(nonce);
        return Convert.ToHexStringLower(nonce);
    }
}
