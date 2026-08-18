using System.Security.Cryptography;
using SqlSimCity.Storage;

namespace SqlSimCity.Storage.Crypto;

/// <summary>
/// A validated, in-memory set of AES-256 keys keyed by version, with one
/// designated active version used for new encryptions. Older versions remain
/// available for decryption only, so a rotation can retire an active key
/// without breaking reads of records sealed under it. Key bytes are zeroed on
/// <see cref="Dispose"/>.
/// </summary>
public sealed class KeyRing : IDisposable
{
    private readonly Dictionary<uint, byte[]> _keysByVersion;
    private bool _disposed;

    internal KeyRing(uint activeKeyVersion, IReadOnlyDictionary<uint, byte[]> keysByVersion)
    {
        ActiveKeyVersion = activeKeyVersion;
        // Clone every key so this ring owns independent storage: disposal must
        // not zero out a byte[] the caller (or another ring) still references.
        _keysByVersion = new Dictionary<uint, byte[]>(keysByVersion.Count);
        try
        {
            foreach (var (version, key) in keysByVersion)
            {
                _keysByVersion[version] = (byte[])key.Clone();
            }
        }
        catch
        {
            foreach (var key in _keysByVersion.Values)
            {
                CryptographicOperations.ZeroMemory(key);
            }

            _keysByVersion.Clear();
            throw;
        }
    }

    public uint ActiveKeyVersion { get; }

    /// <summary>Returns the raw key bytes for <paramref name="version"/>.</summary>
    /// <exception cref="KeyRingConfigurationException">The version is not present in the ring.</exception>
    internal byte[] GetKey(uint version)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_keysByVersion.TryGetValue(version, out var key))
        {
            return key;
        }

        throw new KeyRingConfigurationException(
            $"Key version {version} is not present in the configured key ring.");
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        foreach (var key in _keysByVersion.Values)
        {
            CryptographicOperations.ZeroMemory(key);
        }

        _keysByVersion.Clear();
        _disposed = true;
    }
}
