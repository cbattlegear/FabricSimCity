namespace SqlSimCity.Edge.Signing;

/// <summary>
/// Records accepted request nonces so a captured, correctly signed request cannot be replayed within
/// its validity window. Registration is atomic: the first caller to present a nonce wins and every
/// later presentation of the same (connector, nonce) is rejected. Implementations persist state so a
/// central restart does not reopen the replay window.
/// </summary>
public interface INonceReplayStore
{
    /// <summary>
    /// Atomically registers (<paramref name="connectorId"/>, <paramref name="nonce"/>) if unseen.
    /// Returns <c>true</c> on first sight and <c>false</c> if it was already registered and not yet
    /// expired. <paramref name="expiresAt"/> bounds how long the nonce must be remembered.
    /// </summary>
    bool TryRegister(string connectorId, string nonce, DateTimeOffset expiresAt);
}
