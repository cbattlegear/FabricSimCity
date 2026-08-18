namespace SqlSimCity.Storage.Crypto;

/// <summary>
/// Deserialization shape for the key ring file. See SECURITY.md for the
/// documented, strict JSON format. Property names are case-sensitive camelCase
/// on disk; <see cref="System.Text.Json"/> is configured accordingly by
/// <see cref="KeyRingLoader"/>.
/// </summary>
internal sealed class KeyRingFileDto
{
    public int FormatVersion { get; set; }

    public int ActiveKeyVersion { get; set; }

    public List<KeyEntryDto>? Keys { get; set; }
}

internal sealed class KeyEntryDto
{
    public int Version { get; set; }

    /// <summary>Base64-encoded 32-byte AES-256 key.</summary>
    public string? Key { get; set; }
}
