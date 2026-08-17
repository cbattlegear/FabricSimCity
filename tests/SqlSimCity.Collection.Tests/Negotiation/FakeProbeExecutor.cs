using SqlSimCity.Collection.Probes;

namespace SqlSimCity.Collection.Tests.Negotiation;

/// <summary>
/// A fully overridable <see cref="IProbeExecutor"/> test double. Every method defaults to a
/// small, plausible success value; tests override only the delegate(s) relevant to the scenario
/// under test (for example throwing a specific <see cref="ProbeExecutionException"/> subclass, or
/// an arbitrary unclassified exception to prove the negotiator's documented error boundary).
/// </summary>
public sealed class FakeProbeExecutor : IProbeExecutor
{
    public Func<CancellationToken, Task<ServerIdentityResult>> ServerIdentity { get; set; } =
        _ => Task.FromResult(new ServerIdentityResult("FAKE-SERVER", "16.0.1000.6", "RTM", "Enterprise Edition", 3, false, 4, 4, 8192, null));

    public Func<CancellationToken, Task<IReadOnlyList<DatabaseDiscoveryRow>>> DatabaseDiscovery { get; set; } =
        _ => Task.FromResult<IReadOnlyList<DatabaseDiscoveryRow>>([new DatabaseDiscoveryRow(2, "fixture_db", "ONLINE", 160, true)]);

    public Func<string, CancellationToken, Task<QueryStoreOptionsRow?>> QueryStoreOptions { get; set; } =
        (_, _) => Task.FromResult<QueryStoreOptionsRow?>(new QueryStoreOptionsRow("READ_WRITE", "READ_WRITE", 0, 10, 1000, "AUTO"));

    public Func<string, CancellationToken, Task<QueryStorePlanMetadataResult>> QueryStorePlanMetadata { get; set; } =
        (_, _) => Task.FromResult(new QueryStorePlanMetadataResult(true, true, true, true));

    public Func<string, CancellationToken, Task<bool?>> ServerPermission { get; set; } = (_, _) => Task.FromResult<bool?>(true);

    public Func<string, string, CancellationToken, Task<bool?>> DatabasePermission { get; set; } = (_, _, _) => Task.FromResult<bool?>(true);

    public Func<string, CancellationToken, Task<AzureResourceGovernanceRow?>> AzureResourceGovernance { get; set; } =
        (_, _) => Task.FromResult<AzureResourceGovernanceRow?>(null);

    public Task<ServerIdentityResult> GetServerIdentityAsync(CancellationToken cancellationToken) => ServerIdentity(cancellationToken);

    public Task<IReadOnlyList<DatabaseDiscoveryRow>> GetDatabaseDiscoveryAsync(CancellationToken cancellationToken) => DatabaseDiscovery(cancellationToken);

    public Task<QueryStoreOptionsRow?> GetQueryStoreOptionsAsync(string databaseName, CancellationToken cancellationToken) =>
        QueryStoreOptions(databaseName, cancellationToken);

    public Task<QueryStorePlanMetadataResult> GetQueryStorePlanMetadataAsync(string databaseName, CancellationToken cancellationToken) =>
        QueryStorePlanMetadata(databaseName, cancellationToken);

    public Task<bool?> CheckServerPermissionAsync(string permission, CancellationToken cancellationToken) =>
        ServerPermission(permission, cancellationToken);

    public Task<bool?> CheckDatabasePermissionAsync(string databaseName, string permission, CancellationToken cancellationToken) =>
        DatabasePermission(databaseName, permission, cancellationToken);

    public Task<AzureResourceGovernanceRow?> GetAzureResourceGovernanceAsync(string databaseName, CancellationToken cancellationToken) =>
        AzureResourceGovernance(databaseName, cancellationToken);
}
