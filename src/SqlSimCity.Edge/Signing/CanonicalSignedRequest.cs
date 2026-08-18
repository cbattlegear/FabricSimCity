using System.Text;

namespace SqlSimCity.Edge.Signing;

/// <summary>
/// The canonical byte string an HMAC-SHA-256 signature is computed over. Every field that a central
/// verifier re-derives independently (method, path, timestamp, nonce, connector, key id, and the
/// body's content digest) is length-unambiguously joined with a newline so no two distinct requests
/// can canonicalize to the same bytes. The request body is bound only through its SHA-256 digest, so
/// signing never buffers or logs the body itself.
/// </summary>
public sealed record CanonicalSignedRequest(
    string Method,
    string Path,
    long UnixTimeSeconds,
    string Nonce,
    string ConnectorId,
    string KeyId,
    string BodySha256Hex)
{
    /// <summary>Produces the exact canonical bytes both signer and verifier feed into HMAC-SHA-256.</summary>
    public byte[] ToCanonicalBytes()
    {
        var canonical = new StringBuilder()
            .Append(Method.ToUpperInvariant()).Append('\n')
            .Append(Path).Append('\n')
            .Append(UnixTimeSeconds).Append('\n')
            .Append(Nonce).Append('\n')
            .Append(ConnectorId).Append('\n')
            .Append(KeyId).Append('\n')
            .Append(BodySha256Hex);
        return Encoding.UTF8.GetBytes(canonical.ToString());
    }
}
