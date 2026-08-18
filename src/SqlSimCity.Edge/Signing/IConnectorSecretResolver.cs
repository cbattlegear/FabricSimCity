namespace SqlSimCity.Edge.Signing;

/// <summary>
/// Resolves the shared HMAC secret for an allowlisted connector and key id. Implementations load
/// secret bytes only from a file or Docker secret, never from environment plaintext, and never fall
/// back to a default when a connector or key id is unknown. An unknown connector id is an allowlist
/// rejection; multiple key ids per connector exist only to make rotation overlap possible.
/// </summary>
public interface IConnectorSecretResolver
{
    /// <summary>Whether <paramref name="connectorId"/> is on the central allowlist at all.</summary>
    bool IsAllowed(string connectorId);

    /// <summary>
    /// Copies the secret bytes for (<paramref name="connectorId"/>, <paramref name="keyId"/>) into a
    /// caller-owned buffer. The caller must zero the returned buffer after use. Returns <c>false</c>
    /// (never a fallback secret) when the connector is not allowlisted or the key id is unknown.
    /// </summary>
    bool TryResolveSecret(string connectorId, string keyId, out byte[] secret);
}
