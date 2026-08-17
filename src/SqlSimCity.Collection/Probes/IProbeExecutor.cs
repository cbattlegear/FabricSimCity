namespace SqlSimCity.Collection.Probes;

/// <summary>
/// Source-neutral access to the small set of identity/discovery/metadata/permission probes the
/// capability negotiator needs. Implemented by <c>SqlClientProbeExecutor</c> (a real
/// <c>Microsoft.Data.SqlClient</c> connection) and by <c>FixtureProbeExecutor</c> (deterministic
/// JSON fixtures), so <c>CapabilityNegotiator</c> and its tests never depend on which one is in
/// use. This interface intentionally excludes bulk telemetry (session/wait/plan text rows); it is
/// scoped to what feature negotiation needs, not the full atlas collector.
/// </summary>
public interface IProbeExecutor
{
    Task<ServerIdentityResult> GetServerIdentityAsync(CancellationToken cancellationToken);

    Task<IReadOnlyList<DatabaseDiscoveryRow>> GetDatabaseDiscoveryAsync(CancellationToken cancellationToken);

    /// <summary>Query Store options for whichever database this executor is currently connected to.</summary>
    Task<QueryStoreOptionsRow?> GetQueryStoreOptionsAsync(string databaseName, CancellationToken cancellationToken);

    Task<QueryStorePlanMetadataResult> GetQueryStorePlanMetadataAsync(string databaseName, CancellationToken cancellationToken);

    Task<bool?> CheckServerPermissionAsync(string permission, CancellationToken cancellationToken);

    Task<bool?> CheckDatabasePermissionAsync(string databaseName, string permission, CancellationToken cancellationToken);

    /// <summary>Only meaningful on Azure SQL Database; returns null on every other platform.</summary>
    Task<AzureResourceGovernanceRow?> GetAzureResourceGovernanceAsync(string databaseName, CancellationToken cancellationToken);
}
