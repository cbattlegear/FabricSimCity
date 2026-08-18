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
    public const int DefaultMaxRecordKindLength = 128;
    public const int MaximumRecordKindLength = 1_024;
    public const int DefaultMaxPayloadBytes = 1_048_576;
    public const int MaximumPayloadBytes = 16 * 1_024 * 1_024;

    public bool Enabled { get; set; }

    /// <summary>Directory holding the SQLite database file, e.g. <c>/data</c>.</summary>
    public string? DataDirectory { get; set; }

    public string DatabaseFileName { get; set; } = "protected-storage.db";

    /// <summary>Maximum characters permitted in plaintext record-kind metadata.</summary>
    public int MaxRecordKindLength { get; set; } = DefaultMaxRecordKindLength;

    /// <summary>Maximum plaintext payload bytes accepted for one encrypted record.</summary>
    public int MaxPayloadBytes { get; set; } = DefaultMaxPayloadBytes;

    /// <summary>
    /// Path to the key ring file, e.g. a Docker/Compose secret mounted at
    /// <c>/run/secrets/sqlsimcity-storage-key</c>. See SECURITY.md for the
    /// required JSON format.
    /// </summary>
    public string? KeyFilePath { get; set; }

    public RetentionOptions Retention { get; set; } = new();

    internal void ValidateForEnabledStorage(string sectionName)
    {
        if (!IsSimpleDatabaseFileName(DatabaseFileName))
        {
            throw new KeyRingConfigurationException(
                $"{sectionName}:{nameof(DatabaseFileName)} must be a simple database file name without path separators or traversal.");
        }

        if (Retention.DetailRetention <= TimeSpan.Zero)
        {
            throw new KeyRingConfigurationException(
                $"{sectionName}:Retention:{nameof(RetentionOptions.DetailRetention)} must be positive.");
        }

        if (Retention.HourlyRollupRetention < Retention.DetailRetention)
        {
            throw new KeyRingConfigurationException(
                $"{sectionName}:Retention:{nameof(RetentionOptions.HourlyRollupRetention)} must be at least the detail retention.");
        }

        if (Retention.PruneBatchSize is < 1 or > RetentionOptions.MaximumPruneBatchSize)
        {
            throw new KeyRingConfigurationException(
                $"{sectionName}:Retention:{nameof(RetentionOptions.PruneBatchSize)} must be between 1 and {RetentionOptions.MaximumPruneBatchSize}.");
        }

        if (MaxRecordKindLength is < 1 or > MaximumRecordKindLength)
        {
            throw new KeyRingConfigurationException(
                $"{sectionName}:{nameof(MaxRecordKindLength)} must be between 1 and {MaximumRecordKindLength}.");
        }

        if (MaxPayloadBytes is < 1 or > MaximumPayloadBytes)
        {
            throw new KeyRingConfigurationException(
                $"{sectionName}:{nameof(MaxPayloadBytes)} must be between 1 and {MaximumPayloadBytes}.");
        }
    }

    private static bool IsSimpleDatabaseFileName(string? value) =>
        !string.IsNullOrWhiteSpace(value)
        && !Path.IsPathRooted(value)
        && value is not "." and not ".."
        && !value.Contains(Path.DirectorySeparatorChar)
        && !value.Contains(Path.AltDirectorySeparatorChar)
        && !value.Contains('/')
        && !value.Contains('\\')
        && !value.Contains(':');
}
