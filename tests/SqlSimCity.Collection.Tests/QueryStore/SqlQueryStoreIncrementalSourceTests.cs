using Azure.Identity;
using SqlSimCity.Collection.Catalog;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.SqlServer;
using SqlSimCity.SqlServer.Auth;

namespace SqlSimCity.Collection.Tests.QueryStore;

public sealed class SqlQueryStoreIncrementalSourceTests
{
    [Fact]
    public async Task MasterDiscoveryFallsBackOnlyForExpectedScopeFailures()
    {
        foreach (var failure in new ProbeExecutionException[]
                 {
                     new ProbePermissionDeniedException("permission", 229, 14),
                     new ProbeObjectUnavailableException("object", 208, 16),
                     new ProbeDatabaseUnavailableException("database", 4060, 11),
                 })
        {
            var factory = new ThrowingConnectionFactory(failure, new StopAfterCaptureException());
            using var source = NewSource(factory);

            await Assert.ThrowsAsync<StopAfterCaptureException>(
                () => source.DiscoverDatabasesAsync(default));

            Assert.Equal(["master", "contained"], factory.Profiles.Select(item => item.InitialDatabase));
        }

        foreach (var failure in new ProbeExecutionException[]
                 {
                     new ProbeAuthenticationException("authentication", 18456, 14),
                     new ProbeTimeoutException("timeout", -2, 11),
                     new ProbeTransientConnectionException("network", 10054, 20),
                     new ProbeUnknownException("unknown", 1, 16),
                 })
        {
            var factory = new ThrowingConnectionFactory(failure, new StopAfterCaptureException());
            using var source = NewSource(factory);

            var actual = await Assert.ThrowsAsync(failure.GetType(),
                () => source.DiscoverDatabasesAsync(default));

            Assert.Same(failure, actual);
            Assert.Equal(["master"], factory.Profiles.Select(item => item.InitialDatabase));
        }

        var cancellationFactory = new ThrowingConnectionFactory(new OperationCanceledException());
        using var cancelledSource = NewSource(cancellationFactory);
        await Assert.ThrowsAsync<OperationCanceledException>(
            () => cancelledSource.DiscoverDatabasesAsync(default));
        Assert.Equal(["master"], cancellationFactory.Profiles.Select(item => item.InitialDatabase));
    }

    [Fact]
    public async Task EntraCredentialFailuresAreCuratedWithoutFallbackOrDiagnostics()
    {
        const string sensitive = @"C:\secret\tenant-client-provider";
        foreach (var failure in new Exception[]
                 {
                     new CredentialUnavailableException(sensitive),
                     new AuthenticationFailedException(sensitive),
                 })
        {
            var factory = new ThrowingConnectionFactory(failure);
            using var source = NewSource(factory);

            var actual = await Assert.ThrowsAsync<ProbeAuthenticationException>(
                () => source.DiscoverDatabasesAsync(default));

            Assert.DoesNotContain(sensitive, actual.Reason, StringComparison.Ordinal);
            Assert.DoesNotContain("tenant", actual.Reason, StringComparison.OrdinalIgnoreCase);
            Assert.Equal(["master"], factory.Profiles.Select(item => item.InitialDatabase));
        }
    }

    [Fact]
    public async Task CapabilityDiscoveryStartsWithLowPrivilegeCurrentDatabaseIdentity()
    {
        var factory = new ThrowingConnectionFactory(new StopAfterCaptureException());
        using var source = NewSource(factory);

        await Assert.ThrowsAsync<StopAfterCaptureException>(
            () => source.GetStateAsync("contained", default));

        Assert.Equal(["contained"], factory.Profiles.Select(item => item.InitialDatabase));
    }

    private static SqlQueryStoreIncrementalSource NewSource(ISqlConnectionFactory factory) =>
        new(factory, Profile(), ProbeCatalog.Load(), TimeProvider.System);

    private static ConnectionProfile Profile() => new(
        new ConnectionProfileId("query-store-source-test"),
        new ServerAddress("localhost", port: 1433),
        "contained",
        new ConnectionTimeouts(5, 10),
        new PoolBounds(0, 5),
        EncryptionPolicy.Mandatory,
        new KerberosAuthenticationStrategy());

    private sealed class StopAfterCaptureException : Exception;

    private sealed class ThrowingConnectionFactory(params Exception[] failures) : ISqlConnectionFactory
    {
        private readonly Queue<Exception> _failures = new(failures);
        public List<ConnectionProfile> Profiles { get; } = [];

        public Task<SqlConnectionOpenResult> OpenAsync(
            ConnectionProfile profile,
            CancellationToken cancellationToken)
        {
            Profiles.Add(profile);
            throw _failures.Dequeue();
        }

        public Task InvalidateSqlLoginProfileAsync(
            ConnectionProfile profile, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateEntraProfileAsync(
            ConnectionProfile profile, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task RetryPendingCleanupAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public void Dispose() { }
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
