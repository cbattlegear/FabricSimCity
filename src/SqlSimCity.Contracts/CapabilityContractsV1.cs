namespace SqlSimCity.Contracts.V1;

/// <summary>
/// Canonical state for every capability-negotiation fact. Every field this profile reports is
/// paired with one of these explicit states; a value that could not be determined is always
/// <see cref="NotProbed"/>, <see cref="Unavailable"/>, or <see cref="PermissionDenied"/> -- never a
/// false Boolean or a numeric zero standing in for "unknown".
/// </summary>
public enum CapabilityState { Supported, Unsupported, PermissionDenied, Unavailable, NotProbed, Preview }

/// <summary>
/// The engine platform family a target was identified as, from
/// <c>SERVERPROPERTY('EngineEdition')</c> (see <c>server.identity</c> in <c>sql/manifest.json</c>).
/// </summary>
public enum EnginePlatform { SqlServerOnPremises, AzureSqlDatabase, AzureSqlManagedInstance, Unsupported }

/// <summary>Whether database enumeration reflects the whole logical server or only the connected database.</summary>
public enum VisibilityScope { Server, DatabaseScoped, Unknown }

/// <summary>A coarse read of Query Store's <c>actual_state_desc</c> for the states this negotiator classifies explicitly.</summary>
public enum QueryStoreOperationalState { On, Off, ReadOnly, Error, Unknown }

/// <summary>
/// Non-secret diagnostic context for one capability determination. <see cref="SqlErrorNumber"/>
/// and <see cref="SqlErrorClass"/> are preserved from a classified <c>SqlException</c> when one
/// occurred; <see cref="Reason"/> is always a fixed, curated sentence -- never a raw exception
/// message, server name, or query text, which can appear inside <c>SqlException.Message</c>.
/// </summary>
public sealed record CapabilityEvidenceV1(
    CapabilityState State,
    string Reason,
    DateTimeOffset? SourceTimestamp,
    int? SqlErrorNumber,
    byte? SqlErrorClass);

public sealed record EnginePlatformV1(
    EnginePlatform Platform,
    string? ProductVersion,
    string? Edition,
    int? EngineEdition,
    CapabilityEvidenceV1 Evidence);

public sealed record DatabaseCompatibilityV1(
    string DatabaseId,
    string DatabaseName,
    int? CompatibilityLevel,
    CapabilityEvidenceV1 Evidence);

public sealed record VisibilityV1(VisibilityScope Scope, string Reason, CapabilityEvidenceV1 Evidence);

/// <summary>A single yes/no-with-reason feature determination (waits, live sessions, PSP, OPPO, ...).</summary>
public sealed record FeatureCapabilityV1(CapabilityState State, string Reason, CapabilityEvidenceV1 Evidence);

public sealed record QueryStoreStateV1(
    string? DesiredState,
    string? ActualState,
    QueryStoreOperationalState OperationalState,
    string? ReadOnlyReason,
    string? CaptureMode,
    long? CurrentStorageBytes,
    long? MaxStorageBytes,
    CapabilityState Availability,
    CapabilityEvidenceV1 Evidence);

public sealed record AzureResourceMetricsV1(
    double? CpuLimitCores,
    long? ProcessMemoryLimitMb,
    CapabilityEvidenceV1 Evidence);

/// <summary>
/// The canonical, source-neutral capability profile for one SQL Server / Azure SQL target.
/// Produced identically by a fixture-backed and a live <c>Microsoft.Data.SqlClient</c> source
/// (see <c>ICapabilityNegotiator</c> in <c>SqlSimCity.Collection</c>).
/// </summary>
public sealed record TargetCapabilityProfileV1(
    string SchemaVersion,
    string TargetId,
    EnginePlatformV1 Platform,
    IReadOnlyList<DatabaseCompatibilityV1> Databases,
    VisibilityV1 ServerVisibility,
    FeatureCapabilityV1 Waits,
    FeatureCapabilityV1 LiveSessions,
    FeatureCapabilityV1 PlansAndText,
    FeatureCapabilityV1 ParameterSensitivePlan,
    FeatureCapabilityV1 OptionalParameterPlanOptimization,
    FeatureCapabilityV1 ReadableSecondaryQueryStore,
    IReadOnlyDictionary<string, QueryStoreStateV1> QueryStoreByDatabase,
    AzureResourceMetricsV1 AzureResourceMetrics,
    DateTimeOffset SourceTimestamp);

/// <summary>
/// The <c>/api/v1/capabilities</c> response shape: one negotiated
/// <see cref="TargetCapabilityProfileV1"/> per known target, alongside its own generation
/// timestamp. This is deliberately read-only -- SqlSimCity never exposes a corresponding mutation
/// endpoint for capability profiles.
/// </summary>
public sealed record CapabilitiesSnapshotV1(
    string SchemaVersion,
    DateTimeOffset GeneratedAt,
    IReadOnlyList<TargetCapabilityProfileV1> Targets);
