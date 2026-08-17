using System.Security.Cryptography;
using System.Text.Json;
using SqlSimCity.Storage;

namespace SqlSimCity.Storage.Crypto;

/// <summary>
/// Loads and strictly validates a key ring file. The documented format (see
/// SECURITY.md):
/// <code>
/// {
///   "formatVersion": 1,
///   "activeKeyVersion": 2,
///   "keys": [
///     { "version": 1, "key": "&lt;base64, decodes to exactly 32 bytes&gt;" },
///     { "version": 2, "key": "&lt;base64, decodes to exactly 32 bytes&gt;" }
///   ]
/// }
/// </code>
/// Every failure raises <see cref="KeyRingConfigurationException"/> with a
/// structural message; raw key or file-content bytes are never included.
/// </summary>
public static class KeyRingLoader
{
    private const int SupportedFormatVersion = 1;
    private const int RequiredKeyLengthBytes = 32;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
    };

    public static KeyRing Load(string keyFilePath)
    {
        if (string.IsNullOrWhiteSpace(keyFilePath))
        {
            throw new KeyRingConfigurationException(
                "A key file path must be configured when protected storage is enabled.");
        }

        if (!File.Exists(keyFilePath))
        {
            throw new KeyRingConfigurationException(
                $"The configured key file was not found at '{keyFilePath}'.");
        }

        string json;
        try
        {
            json = File.ReadAllText(keyFilePath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new KeyRingConfigurationException(
                $"The configured key file at '{keyFilePath}' could not be read.", ex);
        }

        KeyRingFileDto? dto;
        try
        {
            dto = JsonSerializer.Deserialize<KeyRingFileDto>(json, JsonOptions);
        }
        catch (JsonException ex)
        {
            throw new KeyRingConfigurationException(
                "The configured key file is not valid JSON.", ex);
        }

        if (dto is null)
        {
            throw new KeyRingConfigurationException("The configured key file is empty or invalid.");
        }

        if (dto.FormatVersion != SupportedFormatVersion)
        {
            throw new KeyRingConfigurationException(
                $"Unsupported key file formatVersion {dto.FormatVersion}; expected {SupportedFormatVersion}.");
        }

        if (dto.Keys is null || dto.Keys.Count == 0)
        {
            throw new KeyRingConfigurationException("The configured key file must declare at least one key.");
        }

        var keysByVersion = new Dictionary<uint, byte[]>();
        foreach (var entry in dto.Keys)
        {
            if (entry.Version <= 0)
            {
                throw new KeyRingConfigurationException(
                    "Each key entry must declare a positive integer version.");
            }

            var version = (uint)entry.Version;
            if (keysByVersion.ContainsKey(version))
            {
                throw new KeyRingConfigurationException($"Duplicate key version {version} in key file.");
            }

            if (string.IsNullOrWhiteSpace(entry.Key))
            {
                throw new KeyRingConfigurationException(
                    $"Key version {version} must declare a non-empty base64 key.");
            }

            byte[] keyBytes;
            try
            {
                keyBytes = Convert.FromBase64String(entry.Key);
            }
            catch (FormatException ex)
            {
                throw new KeyRingConfigurationException(
                    $"Key version {version} is not valid base64.", ex);
            }

            if (keyBytes.Length != RequiredKeyLengthBytes)
            {
                CryptographicOperations.ZeroMemory(keyBytes);
                throw new KeyRingConfigurationException(
                    $"Key version {version} must decode to exactly {RequiredKeyLengthBytes} bytes.");
            }

            keysByVersion[version] = keyBytes;
        }

        if (dto.ActiveKeyVersion <= 0)
        {
            throw new KeyRingConfigurationException(
                "The key file must declare a positive activeKeyVersion.");
        }

        var activeVersion = (uint)dto.ActiveKeyVersion;
        if (!keysByVersion.ContainsKey(activeVersion))
        {
            throw new KeyRingConfigurationException(
                $"activeKeyVersion {activeVersion} is not present among the declared keys.");
        }

        return new KeyRing(activeVersion, keysByVersion);
    }
}
