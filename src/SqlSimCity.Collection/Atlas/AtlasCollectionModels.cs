using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Atlas;

public sealed record AtlasCollectionOptions
{
    public const int MaximumDatabases = 100;
    public const int MaximumConcurrency = 16;

    public string TargetId { get; init; } = "primary";
    public string DisplayName { get; init; } = "SQL Server";
    public IReadOnlyList<string> KnownDatabases { get; init; } = [];
    public int DatabaseConcurrency { get; init; } = 4;
    public TimeSpan QueryStoreWindow { get; init; } = TimeSpan.FromHours(24);
    public TimeSpan RefreshInterval { get; init; } = TimeSpan.FromMinutes(1);
    public TimeSpan StaleAfter { get; init; } = TimeSpan.FromMinutes(3);

    public void Validate()
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(TargetId);
        ArgumentException.ThrowIfNullOrWhiteSpace(DisplayName);
        if (TargetId.Length > 128 || TargetId.Any(character =>
                !(char.IsAsciiLetterOrDigit(character) || character is '-' or '_' or '.' or ':')))
            throw new ArgumentException("TargetId must be 128 characters or fewer and use only ASCII letters, digits, '-', '_', '.', or ':'.",
                nameof(TargetId));
        if (DisplayName.Length > 256 || DisplayName.Any(char.IsControl))
            throw new ArgumentException("DisplayName must be 256 characters or fewer and contain no control characters.",
                nameof(DisplayName));
        if (DatabaseConcurrency is < 1 or > MaximumConcurrency)
            throw new ArgumentOutOfRangeException(nameof(DatabaseConcurrency));
        if (KnownDatabases.Count > MaximumDatabases)
            throw new ArgumentOutOfRangeException(nameof(KnownDatabases));
        if (KnownDatabases.Any(name => string.IsNullOrWhiteSpace(name) || name.Length > 128 || name.Any(char.IsControl)) ||
            KnownDatabases.Distinct(StringComparer.OrdinalIgnoreCase).Count() != KnownDatabases.Count)
            throw new ArgumentException("Known database names must be non-empty and unique.", nameof(KnownDatabases));
        if (QueryStoreWindow < TimeSpan.FromMinutes(1) || QueryStoreWindow > TimeSpan.FromDays(31))
            throw new ArgumentOutOfRangeException(nameof(QueryStoreWindow));
        if (RefreshInterval < TimeSpan.FromSeconds(10) || RefreshInterval > TimeSpan.FromHours(1))
            throw new ArgumentOutOfRangeException(nameof(RefreshInterval));
        if (StaleAfter < RefreshInterval || StaleAfter > TimeSpan.FromDays(1))
            throw new ArgumentOutOfRangeException(nameof(StaleAfter));
    }
}

public sealed record AtlasTargetIdentity(
    EnginePlatform Platform,
    string ProductVersion,
    string Edition,
    DateTimeOffset? SqlServerStartTime,
    DateTimeOffset SourceTimestamp);

public sealed record AtlasDatabaseIdentity(
    string Name,
    string State,
    int CompatibilityLevel,
    bool IsQueryStoreOn,
    string? ResourceIdentity = null);

public sealed record AtlasProbeSelection(
    string QueryStoreOptionsProbeId,
    string QueryStoreRuntimeProbeId,
    string FileIoProbeId);

public sealed record AtlasSpaceResult(
    string DataAllocatedBytes,
    string DataUsedBytes,
    string LogAllocatedBytes,
    string LogUsedBytes);

public sealed record AtlasQueryStoreResult(
    string ActualState,
    int ReadOnlyReason,
    string? ExecutionCount,
    string? TotalDurationMicroseconds,
    string? TotalCpuMicroseconds,
    string? LogicalReads8KiBPages,
    DateTimeOffset? WindowStart,
    DateTimeOffset? WindowEnd)
{
    public string? DesiredState { get; init; }
    public string? CaptureMode { get; init; }
    public string? CurrentStorageBytes { get; init; }
    public string? MaxStorageBytes { get; init; }
}

public sealed record AtlasFileIoCounter(
    int FileId,
    string BytesRead,
    string BytesWritten,
    long SampleMilliseconds);

public sealed record AtlasDatabaseProbeResult(
    AtlasDatabaseIdentity Identity,
    AtlasSpaceResult Space,
    AtlasQueryStoreResult QueryStore,
    IReadOnlyList<AtlasFileIoCounter> FileIo,
    DateTimeOffset SourceTimestamp,
    int RowCount);

public sealed record AtlasCollectionResult(
    AtlasSnapshotV1 Snapshot,
    AtlasCollectorStatusV1 Status,
    bool ConnectionFailure);
