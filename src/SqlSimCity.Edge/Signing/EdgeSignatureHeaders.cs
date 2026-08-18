namespace SqlSimCity.Edge.Signing;

/// <summary>
/// The HTTP header names used to carry the per-request HMAC signature material. None of these
/// carry the secret itself; the shared secret never leaves the connector or the central key file.
/// </summary>
public static class EdgeSignatureHeaders
{
    public const string Connector = "X-SqlSimCity-Connector";
    public const string KeyId = "X-SqlSimCity-Key-Id";
    public const string Timestamp = "X-SqlSimCity-Timestamp";
    public const string Nonce = "X-SqlSimCity-Nonce";
    public const string ContentSha256 = "X-SqlSimCity-Content-Sha256";
    public const string Signature = "X-SqlSimCity-Signature";
}
