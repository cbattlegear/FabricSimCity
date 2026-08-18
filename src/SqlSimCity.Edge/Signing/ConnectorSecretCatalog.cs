using System.Text.Json;

namespace SqlSimCity.Edge.Signing;

/// <summary>Raised when the central connector-secret catalog is missing, malformed, or references an invalid secret.</summary>
public sealed class ConnectorSecretCatalogException : Exception
{
    public ConnectorSecretCatalogException(string message) : base(message) { }
    public ConnectorSecretCatalogException(string message, Exception inner) : base(message, inner) { }
}

/// <summary>
/// Loads the central allowlist of connector signing secrets from a JSON catalog plus a secrets
/// directory. The catalog is the only place a connector id becomes trusted; a connector absent from
/// it is rejected at verification time. Secret bytes live only in files (or Docker secrets) named by
/// simple, validated file names under the secrets directory — never inline in the catalog and never
/// in environment plaintext. Every failure is fail-closed and never echoes key or secret bytes.
/// <code>
/// {
///   "formatVersion": 1,
///   "connectors": [
///     { "connectorId": "edge-a", "keys": [ { "keyId": "2026-08", "secretFile": "edge-a.key" } ] }
///   ]
/// }
/// </code>
/// </summary>
public static class ConnectorSecretCatalog
{
    private const int MinimumSecretBytes = 32;

    private sealed record CatalogDto(int FormatVersion, List<ConnectorDto>? Connectors);
    private sealed record ConnectorDto(string? ConnectorId, List<KeyDto>? Keys);
    private sealed record KeyDto(string? KeyId, string? SecretFile);

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
    };

    public static InMemoryConnectorSecretResolver Load(string catalogFilePath, string secretsDirectory)
    {
        if (string.IsNullOrWhiteSpace(catalogFilePath))
            throw new ConnectorSecretCatalogException("A connector secret catalog file must be configured.");
        if (string.IsNullOrWhiteSpace(secretsDirectory))
            throw new ConnectorSecretCatalogException("A connector secrets directory must be configured.");
        if (!File.Exists(catalogFilePath))
            throw new ConnectorSecretCatalogException($"The connector secret catalog was not found at '{catalogFilePath}'.");

        CatalogDto? dto;
        try
        {
            dto = JsonSerializer.Deserialize<CatalogDto>(File.ReadAllText(catalogFilePath), JsonOptions);
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            throw new ConnectorSecretCatalogException("The connector secret catalog could not be read or parsed.", ex);
        }

        if (dto is null || dto.FormatVersion != 1)
            throw new ConnectorSecretCatalogException("Unsupported or empty connector secret catalog.");
        if (dto.Connectors is null || dto.Connectors.Count == 0)
            throw new ConnectorSecretCatalogException("The connector secret catalog must declare at least one connector.");

        var resolvedRoot = Path.GetFullPath(secretsDirectory);
        var secretsByConnector = new Dictionary<string, IReadOnlyDictionary<string, byte[]>>(StringComparer.Ordinal);

        foreach (var connector in dto.Connectors)
        {
            if (string.IsNullOrWhiteSpace(connector.ConnectorId))
                throw new ConnectorSecretCatalogException("A catalog connector entry is missing connectorId.");
            if (secretsByConnector.ContainsKey(connector.ConnectorId))
                throw new ConnectorSecretCatalogException($"Duplicate connectorId '{connector.ConnectorId}' in catalog.");
            if (connector.Keys is null || connector.Keys.Count == 0)
                throw new ConnectorSecretCatalogException($"Connector '{connector.ConnectorId}' declares no keys.");

            var keyMap = new Dictionary<string, byte[]>(StringComparer.Ordinal);
            foreach (var key in connector.Keys)
            {
                if (string.IsNullOrWhiteSpace(key.KeyId))
                    throw new ConnectorSecretCatalogException($"Connector '{connector.ConnectorId}' has a key without a keyId.");
                if (string.IsNullOrWhiteSpace(key.SecretFile))
                    throw new ConnectorSecretCatalogException($"Key '{key.KeyId}' has no secretFile.");

                keyMap[key.KeyId] = ReadSecret(resolvedRoot, key.SecretFile, connector.ConnectorId, key.KeyId);
            }

            secretsByConnector[connector.ConnectorId] = keyMap;
        }

        return new InMemoryConnectorSecretResolver(secretsByConnector);
    }

    private static byte[] ReadSecret(string secretsRoot, string secretFile, string connectorId, string keyId)
    {
        // Only a simple file name is permitted, resolved strictly under the secrets directory.
        if (secretFile.Contains('/') || secretFile.Contains('\\') || secretFile.Contains("..") ||
            Path.IsPathRooted(secretFile) || secretFile != Path.GetFileName(secretFile))
        {
            throw new ConnectorSecretCatalogException(
                $"Connector '{connectorId}' key '{keyId}' secretFile must be a simple file name.");
        }

        var path = Path.GetFullPath(Path.Combine(secretsRoot, secretFile));
        if (!path.StartsWith(secretsRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal) &&
            !string.Equals(path, secretsRoot, StringComparison.Ordinal))
        {
            throw new ConnectorSecretCatalogException(
                $"Connector '{connectorId}' key '{keyId}' secretFile escapes the secrets directory.");
        }

        if (!File.Exists(path))
            throw new ConnectorSecretCatalogException($"Secret file for connector '{connectorId}' key '{keyId}' was not found.");

        byte[] secret;
        try
        {
            secret = Convert.FromBase64String(File.ReadAllText(path).Trim());
        }
        catch (Exception ex) when (ex is FormatException or IOException or UnauthorizedAccessException)
        {
            throw new ConnectorSecretCatalogException(
                $"Secret file for connector '{connectorId}' key '{keyId}' is unreadable or not valid base64.", ex);
        }

        if (secret.Length < MinimumSecretBytes)
            throw new ConnectorSecretCatalogException(
                $"Secret for connector '{connectorId}' key '{keyId}' must be at least {MinimumSecretBytes} bytes.");

        return secret;
    }
}
