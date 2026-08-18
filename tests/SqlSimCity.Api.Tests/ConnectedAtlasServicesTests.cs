using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using SqlSimCity.Collection.Atlas;
using SqlSimCity.Collection.Negotiation;
using SqlSimCity.Contracts.V1;
using SqlSimCity.SqlServer;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.Api.Tests;

public sealed class ConnectedAtlasServicesTests
{
    [Fact]
    public async Task NotificationFailureDegradesStatusWithoutLosingSnapshot()
    {
        using var coordinator = Coordinator(new FakeExecutor());
        var service = Service(coordinator);

        await service.RunCycleAsync(CancellationToken.None);

        Assert.Single(coordinator.GetCurrent().Databases);
        Assert.Equal(AtlasCollectorState.Degraded, coordinator.GetStatus().State);
        Assert.Equal(1, coordinator.GetStatus().FailureCount);
        Assert.Contains("notification failed", coordinator.GetStatus().Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task UnexpectedCycleFailureIsRecordedWithoutEscaping()
    {
        using var coordinator = Coordinator(new FakeExecutor { Failure = new InvalidOperationException("internal detail") });
        var service = Service(coordinator);

        await service.RunCycleAsync(CancellationToken.None);

        var status = coordinator.GetStatus();
        Assert.Equal(AtlasCollectorState.BackingOff, status.State);
        Assert.Equal(1, status.FailureCount);
        Assert.Equal(1, status.ConsecutiveFailures);
        Assert.DoesNotContain("internal detail", status.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void BackoffDelayUsesInjectedTimeProvider()
    {
        var now = new DateTimeOffset(2026, 8, 17, 12, 0, 0, TimeSpan.Zero);
        var clock = new FixedTimeProvider(now);
        var status = EmptyStatus() with { NextAttemptAt = now.AddSeconds(17) };

        Assert.Equal(
            TimeSpan.FromSeconds(17),
            AtlasRefreshBackgroundService.CalculateDelay(status, TimeSpan.FromMinutes(1), clock));
    }

    [Fact]
    public async Task BackgroundServiceStopsPromptlyWhileWaitingForCadence()
    {
        using var coordinator = Coordinator(new FakeExecutor());
        var service = Service(coordinator);
        await service.StartAsync(CancellationToken.None);
        await WaitForSequenceAsync(coordinator);

        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        await service.StopAsync(timeout.Token);

        Assert.True(coordinator.GetStatus().Sequence > 0);
    }

    [Fact]
    public void InvalidConnectedProfileFailsWithoutSecretValue()
    {
        const string secretReference = "do-not-leak";
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(
        [
            new("Atlas:Connection:Host", "sql.example.test"),
            new("Atlas:Connection:Port", "70000"),
            new("Atlas:Connection:Authentication:Mode", "SqlLogin"),
            new("Atlas:Connection:Authentication:Username", "reader"),
            new("Atlas:Connection:Authentication:PasswordSecret", secretReference),
        ]).Build();

        var exception = Assert.ThrowsAny<Exception>(() => AtlasConfiguration.BuildProfile(configuration));

        Assert.DoesNotContain(secretReference, exception.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task HostOwnedConnectionFactoryIsDisposedWithServices()
    {
        var services = new ServiceCollection();
        services.AddSingleton(new FileSecretFileProvider(new SecretFileProviderOptions()));
        services.AddSingleton<ISqlConnectionFactory>(provider =>
            new SqlConnectionFactory(provider.GetRequiredService<FileSecretFileProvider>()));
        var provider = services.BuildServiceProvider();
        var factory = provider.GetRequiredService<ISqlConnectionFactory>();

        await provider.DisposeAsync();

        await Assert.ThrowsAsync<ObjectDisposedException>(() =>
            factory.OpenAsync(new ConnectionProfile(
                new ConnectionProfileId("lifecycle"),
                new ServerAddress("localhost", port: 1433),
                "master",
                new ConnectionTimeouts(5, 10),
                new PoolBounds(0, 5),
                EncryptionPolicy.Mandatory,
                new KerberosAuthenticationStrategy()), CancellationToken.None));
    }

    private static AtlasRefreshBackgroundService Service(AtlasRefreshCoordinator coordinator) =>
        new(
            coordinator,
            new AtlasCollectionOptions(),
            new ThrowingHubContext(),
            TimeProvider.System,
            NullLogger<AtlasRefreshBackgroundService>.Instance);

    private static AtlasRefreshCoordinator Coordinator(IAtlasProbeExecutor executor)
    {
        var options = new AtlasCollectionOptions();
        return new AtlasRefreshCoordinator(
            new AtlasCollector(executor, new NotProbedLiveAtlasActivitySource(), options),
            options,
            new ExponentialReconnectBackoff(TimeSpan.FromSeconds(5), TimeSpan.FromMinutes(1), new FixedJitter()));
    }

    private static AtlasCollectorStatusV1 EmptyStatus() => new(
        AtlasCollectorMode.Connected, AtlasCollectorState.Disconnected, 0,
        null, null, null, false, 0, 0, 0, 0, 0, null, "Pending.");

    private static async Task WaitForSequenceAsync(AtlasRefreshCoordinator coordinator)
    {
        for (var attempt = 0; attempt < 100 && coordinator.GetStatus().Sequence == 0; attempt++)
            await Task.Delay(10);
        Assert.True(coordinator.GetStatus().Sequence > 0);
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class FixedJitter : IReconnectJitter
    {
        public double NextUnit() => 0.5;
    }

    private sealed class FakeExecutor : IAtlasProbeExecutor
    {
        public Exception? Failure { get; init; }

        public Task<AtlasTargetIdentity> GetTargetIdentityAsync(CancellationToken cancellationToken) =>
            Failure is null
                ? Task.FromResult(new AtlasTargetIdentity(
                    EnginePlatform.SqlServerOnPremises,
                    "16.0.1000.1",
                    "Developer",
                    "sqlserver-local:2026-08-17T12:00:00",
                    DateTimeOffset.UtcNow))
                : Task.FromException<AtlasTargetIdentity>(Failure);

        public Task<IReadOnlyList<AtlasDatabaseIdentity>> DiscoverDatabasesAsync(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<AtlasDatabaseIdentity>>(
                [new AtlasDatabaseIdentity("db", "ONLINE", 160, true)]);

        public Task<AtlasDatabaseProbeResult> CollectDatabaseAsync(
            string databaseName,
            AtlasProbeSelection selection,
            DateTimeOffset queryStoreWindowStart,
            DateTimeOffset queryStoreWindowEnd,
            CancellationToken cancellationToken) =>
            Task.FromResult(new AtlasDatabaseProbeResult(
                new AtlasDatabaseIdentity(databaseName, "ONLINE", 160, true),
                AtlasComponentOutcome.Success(new AtlasSpaceResult("100", "50", "20", "10"), 1, "Available."),
                AtlasComponentOutcome.Success(new AtlasQueryStoreOptionsResult("ON", 0), 1, "Available."),
                AtlasComponentOutcome.Success(
                    new AtlasQueryStoreWorkloadResult("1", "10", "5", "2", queryStoreWindowStart, queryStoreWindowEnd),
                    1,
                    "Available."),
                AtlasComponentOutcome.Success<IReadOnlyList<AtlasFileIoCounter>>(
                    [new AtlasFileIoCounter(1, "1", "2", 1000)],
                    1,
                    "Available."),
                DateTimeOffset.UtcNow,
                1));
    }

    private sealed class ThrowingHubContext : IHubContext<CurrentSnapshotHub>
    {
        public IHubClients Clients { get; } = new ThrowingHubClients();
        public IGroupManager Groups { get; } = new NoOpGroupManager();
    }

    private sealed class ThrowingHubClients : IHubClients
    {
        private static IClientProxy Proxy { get; } = new ThrowingClientProxy();
        public IClientProxy All => Proxy;
        public IClientProxy AllExcept(IReadOnlyList<string> excludedConnectionIds) => Proxy;
        public IClientProxy Client(string connectionId) => Proxy;
        public IClientProxy Clients(IReadOnlyList<string> connectionIds) => Proxy;
        public IClientProxy Group(string groupName) => Proxy;
        public IClientProxy GroupExcept(string groupName, IReadOnlyList<string> excludedConnectionIds) => Proxy;
        public IClientProxy Groups(IReadOnlyList<string> groupNames) => Proxy;
        public IClientProxy User(string userId) => Proxy;
        public IClientProxy Users(IReadOnlyList<string> userIds) => Proxy;
    }

    private sealed class ThrowingClientProxy : IClientProxy
    {
        public Task SendCoreAsync(string method, object?[] args, CancellationToken cancellationToken = default) =>
            Task.FromException(new InvalidOperationException("SignalR unavailable."));
    }

    private sealed class NoOpGroupManager : IGroupManager
    {
        public Task AddToGroupAsync(string connectionId, string groupName, CancellationToken cancellationToken = default) =>
            Task.CompletedTask;
        public Task RemoveFromGroupAsync(string connectionId, string groupName, CancellationToken cancellationToken = default) =>
            Task.CompletedTask;
    }
}
