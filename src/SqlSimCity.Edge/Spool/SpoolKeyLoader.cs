using System.Security.Cryptography;
using System.Text.Json;

namespace SqlSimCity.Edge.Spool;

/// <summary>Raised when the spool key file is missing, malformed, or the wrong length. Never contains key bytes.</summary>
public sealed class SpoolKeyConfigurationException : Exception
{
    public SpoolKeyConfigurationException(string message) : base(message) { }
    public SpoolKeyConfigurationException(string message, Exception inner) : base(message, inner) { }
}

/// <summary>
/// Loads the connector spool's AES-256 key from a file or Docker secret that is deliberately
/// separate from the central signing secret. The file is a small JSON document:
/// <code>{ "formatVersion": 1, "keyVersion": 1, "key": "&lt;base64 of exactly 32 bytes&gt;" }</code>
/// A missing, malformed, or wrong-length key fails closed; the key is never read from environment
/// plaintext and never logged.
/// </summary>
public static class SpoolKeyLoader
{
    private const int RequiredKeyBytes = 32;

    private static readonly JsonSerializerOptions KeyFileJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private sealed record SpoolKeyFileDto(int FormatVersion, uint KeyVersion, string? Key);

    public static SpoolKey Load(string keyFilePath)
    {
        if (string.IsNullOrWhiteSpace(keyFilePath))
            throw new SpoolKeyConfigurationException("A spool key file path must be configured when the spool is enabled.");
        if (!File.Exists(keyFilePath))
            throw new SpoolKeyConfigurationException($"The configured spool key file was not found at '{keyFilePath}'.");

        string json;
        try
        {
            json = File.ReadAllText(keyFilePath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new SpoolKeyConfigurationException($"The spool key file at '{keyFilePath}' could not be read.", ex);
        }

        SpoolKeyFileDto? dto;
        try
        {
            dto = JsonSerializer.Deserialize<SpoolKeyFileDto>(json, KeyFileJsonOptions);
        }
        catch (JsonException ex)
        {
            throw new SpoolKeyConfigurationException("The spool key file is not valid JSON.", ex);
        }

        if (dto is null)
            throw new SpoolKeyConfigurationException("The spool key file is empty or invalid.");
        if (dto.FormatVersion != 1)
            throw new SpoolKeyConfigurationException($"Unsupported spool key formatVersion {dto.FormatVersion}; expected 1.");
        if (dto.KeyVersion == 0)
            throw new SpoolKeyConfigurationException("The spool key file must declare a positive keyVersion.");
        if (string.IsNullOrWhiteSpace(dto.Key))
            throw new SpoolKeyConfigurationException("The spool key file must declare a non-empty base64 key.");

        byte[] keyBytes;
        try
        {
            keyBytes = Convert.FromBase64String(dto.Key);
        }
        catch (FormatException ex)
        {
            throw new SpoolKeyConfigurationException("The spool key is not valid base64.", ex);
        }

        if (keyBytes.Length != RequiredKeyBytes)
        {
            CryptographicOperations.ZeroMemory(keyBytes);
            throw new SpoolKeyConfigurationException($"The spool key must decode to exactly {RequiredKeyBytes} bytes.");
        }

        return new SpoolKey(dto.KeyVersion, keyBytes);
    }
}

/// <summary>An in-memory AES-256 spool key with its version. Bytes are zeroed on <see cref="Dispose"/>.</summary>
public sealed class SpoolKey : IDisposable
{
    private readonly byte[] _key;
    private bool _disposed;

    internal SpoolKey(uint version, byte[] key)
    {
        Version = version;
        _key = key;
    }

    public uint Version { get; }

    internal ReadOnlySpan<byte> Bytes
    {
        get
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            return _key;
        }
    }

    public void Dispose()
    {
        if (_disposed)
            return;
        CryptographicOperations.ZeroMemory(_key);
        _disposed = true;
    }
}
