using System.Security.Cryptography;

namespace SqlSimCity.Edge.Connector;

/// <summary>
/// Reads the per-connector HMAC signing secret from a file or Docker secret. The secret is validated
/// once at startup (fail-closed if missing, not base64, or shorter than 32 bytes) and re-read on each
/// signing call so a rotated file is picked up without a restart. The bytes are returned as a fresh
/// copy the caller zeroes after signing; they are never cached, logged, or placed in configuration.
/// </summary>
public sealed class FileSigningSecret
{
    private const int MinimumBytes = 32;
    private readonly string _path;

    private FileSigningSecret(string path) => _path = path;

    public static FileSigningSecret Load(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
            throw new ConnectorConfigurationException("A signing secret file path must be configured.");
        if (!File.Exists(path))
            throw new ConnectorConfigurationException("The configured signing secret file was not found.");

        var secret = new FileSigningSecret(path);
        var probe = secret.Read();
        try
        {
            if (probe.Length < MinimumBytes)
                throw new ConnectorConfigurationException($"The signing secret must be at least {MinimumBytes} bytes.");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(probe);
        }

        return secret;
    }

    /// <summary>Returns a fresh copy of the current secret bytes. The caller must zero it after use.</summary>
    public byte[] Read()
    {
        string text;
        try
        {
            text = File.ReadAllText(_path).Trim();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new ConnectorConfigurationException("The configured signing secret file could not be read.");
        }

        try
        {
            return Convert.FromBase64String(text);
        }
        catch (FormatException)
        {
            throw new ConnectorConfigurationException("The signing secret file is not valid base64.");
        }
    }
}
