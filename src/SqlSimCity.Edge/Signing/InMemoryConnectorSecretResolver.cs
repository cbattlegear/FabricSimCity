using System.Security.Cryptography;

namespace SqlSimCity.Edge.Signing;

/// <summary>
/// An in-memory allowlist of connector secrets keyed by connector id and key id. Callers build it
/// from a file-backed catalog; it clones every secret in and out so no external buffer is aliased,
/// and zeroes its own copies on <see cref="Dispose"/>. Key-id fan-out per connector is what makes a
/// rotation window (old key still accepted while the new key is deployed) possible.
/// </summary>
public sealed class InMemoryConnectorSecretResolver : IConnectorSecretResolver, IDisposable
{
    private const int MinimumSecretBytes = 32;
    private readonly Dictionary<string, Dictionary<string, byte[]>> _byConnector;
    private bool _disposed;

    public InMemoryConnectorSecretResolver(
        IReadOnlyDictionary<string, IReadOnlyDictionary<string, byte[]>> secretsByConnector)
    {
        ArgumentNullException.ThrowIfNull(secretsByConnector);
        _byConnector = new Dictionary<string, Dictionary<string, byte[]>>(StringComparer.Ordinal);
        foreach (var (connectorId, keys) in secretsByConnector)
        {
            if (string.IsNullOrWhiteSpace(connectorId))
                throw new ArgumentException("Connector id must be non-empty.", nameof(secretsByConnector));
            if (keys is null || keys.Count == 0)
                throw new ArgumentException($"Connector '{connectorId}' must declare at least one key.", nameof(secretsByConnector));

            var keyMap = new Dictionary<string, byte[]>(StringComparer.Ordinal);
            foreach (var (keyId, secret) in keys)
            {
                if (string.IsNullOrWhiteSpace(keyId))
                    throw new ArgumentException($"Connector '{connectorId}' has an empty key id.", nameof(secretsByConnector));
                if (secret is null || secret.Length < MinimumSecretBytes)
                    throw new ArgumentException(
                        $"Connector '{connectorId}' key '{keyId}' secret must be at least {MinimumSecretBytes} bytes.",
                        nameof(secretsByConnector));
                keyMap[keyId] = (byte[])secret.Clone();
            }

            _byConnector[connectorId] = keyMap;
        }
    }

    public bool IsAllowed(string connectorId)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        return !string.IsNullOrEmpty(connectorId) && _byConnector.ContainsKey(connectorId);
    }

    public bool TryResolveSecret(string connectorId, string keyId, out byte[] secret)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        secret = Array.Empty<byte>();
        if (string.IsNullOrEmpty(connectorId) || string.IsNullOrEmpty(keyId))
            return false;
        if (!_byConnector.TryGetValue(connectorId, out var keys))
            return false;
        if (!keys.TryGetValue(keyId, out var stored))
            return false;

        secret = (byte[])stored.Clone();
        return true;
    }

    public void Dispose()
    {
        if (_disposed)
            return;
        foreach (var keys in _byConnector.Values)
        {
            foreach (var secret in keys.Values)
                CryptographicOperations.ZeroMemory(secret);
            keys.Clear();
        }

        _byConnector.Clear();
        _disposed = true;
    }
}
