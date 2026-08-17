using System.Reflection;
using System.Text.Json;

namespace SqlSimCity.Collection.Probes;

/// <summary>
/// A deterministic <see cref="IProbeExecutor"/> backed by the repository's existing
/// <c>fixtures/v1/target-capabilities.json</c> (platform/compatibility/capability matrix) and
/// <c>fixtures/v1/database-query-store.json</c> (Query Store state-machine cases), embedded into
/// this assembly. This lets <see cref="Negotiation.CapabilityNegotiator"/> -- and therefore the
/// API and frontend -- produce real <c>TargetCapabilityProfileV1</c> data before any live SQL
/// Server connection exists, using exactly the same negotiation algorithm a
/// <see cref="SqlClientProbeExecutor"/> drives. Where the negotiator's own platform-policy gating
/// (for example Optional Parameter Plan Optimization's documented exclusion of Azure SQL Managed
/// Instance) disagrees with a fixture's own recorded capability string, the negotiator's
/// independently-derived result is authoritative -- the fixture is a source of realistic probe
/// answers, not a pre-approved expected output.
/// </summary>
public sealed class FixtureProbeExecutor : IProbeExecutor
{
    private readonly TargetCapabilityFixtureRow _target;
    private readonly IReadOnlyList<QueryStoreFixtureRecord> _queryStoreRecords;

    public FixtureProbeExecutor(string targetId, Assembly? assembly = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(targetId);
        assembly ??= typeof(FixtureProbeExecutor).Assembly;

        var targets = LoadTargetCapabilities(assembly);
        _target = targets.FirstOrDefault(t => string.Equals(t.TargetId, targetId, StringComparison.Ordinal))
            ?? throw new ArgumentException($"Unknown fixture targetId '{targetId}'.", nameof(targetId));
        _queryStoreRecords = LoadQueryStoreRecords(assembly);
    }

    /// <summary>
    /// Every <c>targetId</c> declared in the embedded <c>fixtures/v1/target-capabilities.json</c>,
    /// in file order. Lets a caller (for example the <c>/api/v1/capabilities</c> endpoint) drive
    /// one negotiation per known fixture target without parsing the fixture itself.
    /// </summary>
    public static IReadOnlyList<string> GetKnownTargetIds(Assembly? assembly = null) =>
        LoadTargetCapabilities(assembly ?? typeof(FixtureProbeExecutor).Assembly)
            .Select(t => t.TargetId)
            .ToList();

    public Task<ServerIdentityResult> GetServerIdentityAsync(CancellationToken cancellationToken)
    {
        var engineEdition = _target.Platform switch
        {
            "SQL Server" => 2,
            "Azure SQL Database" => 5,
            "Azure SQL Managed Instance" => 8,
            _ => 0,
        };

        return Task.FromResult(new ServerIdentityResult(
            ServerName: _target.TargetId,
            ProductVersion: _target.Release,
            ProductLevel: "RTM",
            Edition: _target.Platform,
            EngineEdition: engineEdition,
            IsHadrEnabled: false,
            CpuCount: 4,
            SchedulerCount: 4,
            PhysicalMemoryMb: null,
            SqlServerStartTime: null));
    }

    public Task<IReadOnlyList<DatabaseDiscoveryRow>> GetDatabaseDiscoveryAsync(CancellationToken cancellationToken)
    {
        var rows = _queryStoreRecords
            .Select((record, index) => new DatabaseDiscoveryRow(
                DatabaseId: index + 1,
                DatabaseName: record.DatabaseId,
                StateDesc: "ONLINE",
                CompatibilityLevel: _target.CompatibilityLevel,
                IsQueryStoreOn: record.Availability == "available" && record.ActualState == "READ_WRITE"))
            .ToList();

        return Task.FromResult<IReadOnlyList<DatabaseDiscoveryRow>>(rows);
    }

    public Task<QueryStoreOptionsRow?> GetQueryStoreOptionsAsync(string databaseName, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databaseName);
        var record = _queryStoreRecords.FirstOrDefault(r => string.Equals(r.DatabaseId, databaseName, StringComparison.Ordinal));
        if (record is null)
        {
            return Task.FromResult<QueryStoreOptionsRow?>(null);
        }

        if (record.Availability == "permission-denied")
        {
            throw new ProbePermissionDeniedException(
                $"Fixture record '{record.RecordId}' models a permission-denied Query Store probe.", null, null);
        }

        if (record.Availability == "unsupported")
        {
            throw new ProbeObjectUnavailableException(
                $"Fixture record '{record.RecordId}' models Query Store being unsupported on this target.", null, null);
        }

        return Task.FromResult<QueryStoreOptionsRow?>(new QueryStoreOptionsRow(
            DesiredStateDesc: record.DesiredState ?? "OFF",
            ActualStateDesc: record.ActualState ?? "OFF",
            ReadonlyReason: record.ReasonCode is JsonElement { ValueKind: JsonValueKind.Number } reasonElement ? reasonElement.GetInt32() : 0,
            CurrentStorageSizeMb: (record.CurrentStorageBytes ?? 0) / (1024 * 1024),
            MaxStorageSizeMb: (record.MaxStorageBytes ?? 0) / (1024 * 1024),
            QueryCaptureModeDesc: record.CaptureMode ?? "NONE"));
    }

    public Task<QueryStorePlanMetadataResult> GetQueryStorePlanMetadataAsync(string databaseName, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databaseName);

        // The plan_type_desc and replica_group_id columns were both added in the SQL Server 2022
        // engine, the same release that introduced database compatibility level 160; every
        // fixture target at or above that level models an engine build that carries them.
        var hasModernColumns = _target.CompatibilityLevel >= 160;
        return Task.FromResult(new QueryStorePlanMetadataResult(
            HasPlanTypeDesc: hasModernColumns,
            HasIsOptimizedPlanForcingDisabled: hasModernColumns,
            HasCompileReplayScript: hasModernColumns,
            HasReplicaGroupId: hasModernColumns));
    }

    public Task<bool?> CheckServerPermissionAsync(string permission, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(permission);
        return Task.FromResult(MapCapabilityToPermission(_target.Capabilities.GetValueOrDefault("liveRequests", "not-probed")));
    }

    public Task<bool?> CheckDatabasePermissionAsync(string databaseName, string permission, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databaseName);
        ArgumentException.ThrowIfNullOrWhiteSpace(permission);
        return Task.FromResult(MapCapabilityToPermission(_target.Capabilities.GetValueOrDefault("liveRequests", "not-probed")));
    }

    public Task<AzureResourceGovernanceRow?> GetAzureResourceGovernanceAsync(string databaseName, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databaseName);
        if (_target.Platform != "Azure SQL Database")
        {
            return Task.FromResult<AzureResourceGovernanceRow?>(null);
        }

        return Task.FromResult<AzureResourceGovernanceRow?>(new AzureResourceGovernanceRow(CpuLimit: 2.0, ProcessMemoryLimitMb: 7168));
    }

    private static bool? MapCapabilityToPermission(string capability) => capability switch
    {
        "supported" => true,
        "permission-denied" => false,
        "unsupported" => false,
        _ => null,
    };

    private static List<TargetCapabilityFixtureRow> LoadTargetCapabilities(Assembly assembly)
    {
        using var stream = OpenFixtureResource(assembly, "target-capabilities.json");
        using var document = JsonDocument.Parse(stream);
        var targets = document.RootElement.GetProperty("targets");
        var results = new List<TargetCapabilityFixtureRow>();
        foreach (var element in targets.EnumerateArray())
        {
            var capabilities = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var capability in element.GetProperty("capabilities").EnumerateObject())
            {
                capabilities[capability.Name] = capability.Value.GetString() ?? "not-probed";
            }

            results.Add(new TargetCapabilityFixtureRow(
                element.GetProperty("targetId").GetString()!,
                element.GetProperty("platform").GetString()!,
                element.GetProperty("release").GetString()!,
                element.GetProperty("compatibilityLevel").GetInt32(),
                capabilities));
        }

        return results;
    }

    private static List<QueryStoreFixtureRecord> LoadQueryStoreRecords(Assembly assembly)
    {
        using var stream = OpenFixtureResource(assembly, "database-query-store.json");
        using var document = JsonDocument.Parse(stream);
        var records = document.RootElement.GetProperty("records");
        var results = new List<QueryStoreFixtureRecord>();
        foreach (var element in records.EnumerateArray())
        {
            results.Add(new QueryStoreFixtureRecord(
                element.GetProperty("recordId").GetString()!,
                element.GetProperty("databaseId").GetString()!,
                element.GetProperty("availability").GetString()!,
                GetNullableString(element, "desiredState"),
                GetNullableString(element, "actualState"),
                GetNullableString(element, "captureMode"),
                GetNullableInt64(element, "currentStorageBytes"),
                GetNullableInt64(element, "maxStorageBytes"),
                element.TryGetProperty("reasonCode", out var reasonCode) ? reasonCode.Clone() : (JsonElement?)null));
        }

        return results;
    }

    private static string? GetNullableString(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static long? GetNullableInt64(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.Number ? value.GetInt64() : null;

    private static Stream OpenFixtureResource(Assembly assembly, string fileName)
    {
        var logicalName = "fixtures/v1/" + fileName;
        var resourceName = assembly.GetManifestResourceNames().FirstOrDefault(n => n.Replace('\\', '/') == logicalName)
            ?? throw new InvalidOperationException($"Embedded fixture resource '{logicalName}' was not found.");
        return assembly.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"Embedded fixture resource '{logicalName}' could not be opened.");
    }

    private sealed record TargetCapabilityFixtureRow(
        string TargetId,
        string Platform,
        string Release,
        int CompatibilityLevel,
        IReadOnlyDictionary<string, string> Capabilities);

    private sealed record QueryStoreFixtureRecord(
        string RecordId,
        string DatabaseId,
        string Availability,
        string? DesiredState,
        string? ActualState,
        string? CaptureMode,
        long? CurrentStorageBytes,
        long? MaxStorageBytes,
        JsonElement? ReasonCode);
}
