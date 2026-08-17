namespace SqlSimCity.Storage;

/// <summary>
/// Configuration for the encrypted protected storage seam, normally bound from
/// the <c>ProtectedStorage</c> configuration section. See SECURITY.md for the
/// key file contract. When <see cref="Enabled"/> is <c>false</c> (the default),
/// no store is registered and nothing is written to disk; fixture-only
/// development never needs a key. Once enabled, <see cref="DataDirectory"/> and
/// <see cref="KeyFilePath"/> are mandatory and misconfiguration fails startup
/// rather than silently falling back to an unencrypted store.
/// </summary>
public sealed class ProtectedStorageOptions
{
    public const string SectionName = "ProtectedStorage";

    public bool Enabled { get; set; }

    /// <summary>Directory holding the SQLite database file, e.g. <c>/data</c>.</summary>
    public string? DataDirectory { get; set; }

    public string DatabaseFileName { get; set; } = "protected-storage.db";

    /// <summary>
    /// Path to the key ring file, e.g. a Docker/Compose secret mounted at
    /// <c>/run/secrets/sqlsimcity-storage-key</c>. See SECURITY.md for the
    /// required JSON format.
    /// </summary>
    public string? KeyFilePath { get; set; }

    public RetentionOptions Retention { get; set; } = new();
}
