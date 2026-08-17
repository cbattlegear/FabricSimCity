using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Tests.LiveIncidents;

/// <summary>
/// Exercises <see cref="LiveIncidentCollector"/> against <see cref="FakeLiveIncidentProbeExecutor"/>:
/// disappearing requests across cycles, per-subsystem degradation on permission/timeout errors,
/// Azure-scope file-I/O/scheduler variant selection, and the memory-grant waiting state
/// (requirements 2, 5, 6).
/// </summary>
public class LiveIncidentCollectorTests
{
    private static readonly DateTimeOffset EngineStart = new(2024, 1, 1, 0, 0, 0, TimeSpan.Zero);

    private static ActiveRequestRow Request(int sessionId, int requestId = 1) => new(
        sessionId, "app_user", "app-host", "MyApp", "running",
        null, null, requestId, "running", "SELECT", null, null, null, null,
        DateTimeOffset.UnixEpoch, 10, 5, 100, 50, 200, 0, 5, "AppDb", "SELECT 1", "SELECT 1");

    [Fact]
    public async Task RequestPresentInPreviousCycleButMissingNowIsReportedAsDisappearedNotDropped()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        probes.ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>([Request(51)]);
        var first = await collector.CollectAsync(1, CancellationToken.None);
        Assert.Single(first.Requests, r => r.RequestId == "req:51:1" && r.Availability == SampleAvailability.Available);

        probes.ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>([]);
        var second = await collector.CollectAsync(2, CancellationToken.None);

        var disappeared = Assert.Single(second.Requests);
        Assert.Equal("req:51:1", disappeared.RequestId);
        Assert.Equal(SampleAvailability.Disappeared, disappeared.Availability);
        Assert.NotNull(disappeared.AvailabilityReason);
    }

    [Fact]
    public async Task PermissionDeniedOnOneSubsystemDegradesOnlyThatSubsystem()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
            ActiveRequests = _ => Task.FromResult<IReadOnlyList<ActiveRequestRow>>([Request(10)]),
            MemoryGrants = _ => throw new ProbePermissionDeniedException(
                "The login lacks VIEW SERVER STATE permission required for memory grant visibility.", 300, 14),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        Assert.Equal(DataStatus.Available, snapshot.Status); // requests still succeeded overall
        Assert.Single(snapshot.Requests);
        var unavailable = Assert.Single(snapshot.Diagnostics.UnavailableFields);
        Assert.Equal("memoryGrants", unavailable.Field);
        Assert.Equal(DataStatus.PermissionDenied, unavailable.Status);
        Assert.Empty(snapshot.MemoryGrants);
    }

    [Fact]
    public async Task TimeoutOnEverySubsystemYieldsDisconnectedOverallStatusNotAnEmptySilentSnapshot()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => throw new ProbeTimeoutException("The server identity probe timed out.", null, null),
            ActiveRequests = _ => throw new ProbeTimeoutException("The active-requests probe timed out.", null, null),
            WaitingTasks = _ => throw new ProbeTimeoutException("The waiting-tasks probe timed out.", null, null),
            BlockingInputs = _ => throw new ProbeTimeoutException("The blocking-inputs probe timed out.", null, null),
            MemoryGrants = _ => throw new ProbeTimeoutException("The memory-grants probe timed out.", null, null),
            TempdbUsage = _ => throw new ProbeTimeoutException("The tempdb probe timed out.", null, null),
            FileIoStats = (_, _) => throw new ProbeTimeoutException("The file I/O probe timed out.", null, null),
            SchedulerPressure = (_, _) => throw new ProbeTimeoutException("The scheduler probe timed out.", null, null),
            LogSpaceUsage = _ => throw new ProbeTimeoutException("The log space probe timed out.", null, null),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        Assert.Equal(DataStatus.Disconnected, snapshot.Status);
        Assert.NotEmpty(snapshot.Diagnostics.UnavailableFields);
        Assert.All(snapshot.Diagnostics.UnavailableFields, f => Assert.Equal(DataStatus.Disconnected, f.Status));
    }

    [Theory]
    [InlineData(5, true)]  // Azure SQL Database: always request the DB-scoped, Azure-safe variant
    [InlineData(2, false)] // on-prem SQL Server 2016 (major version parsed from ProductVersion below)
    public async Task FileIoProbeReceivesAzureScopedFlagMatchingNegotiatedPlatform(int engineEdition, bool expectedAzureScoped)
    {
        bool? observedAzureScoped = null;
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart, engineEdition)),
            FileIoStats = (azureScoped, _) =>
            {
                observedAzureScoped = azureScoped;
                return Task.FromResult<IReadOnlyList<FileIoRow>>([]);
            },
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        await collector.CollectAsync(1, CancellationToken.None);

        Assert.Equal(expectedAzureScoped, observedAzureScoped);
    }

    [Fact]
    public async Task SchedulerProbeRequestsIdealWorkersLimitOnSqlServer2019OrNewerNotOnOlderVersions()
    {
        bool? observedFlag = null;
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(new ServerIdentityResult(
                "srv", "15.0.2000.5", "RTM", "Enterprise Edition", 3, false, 8, 8, 32_768, EngineStart)),
            SchedulerPressure = (includeIdeal, _) =>
            {
                observedFlag = includeIdeal;
                return Task.FromResult<IReadOnlyList<SchedulerRow>>([]);
            },
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        await collector.CollectAsync(1, CancellationToken.None);

        Assert.True(observedFlag); // SQL Server 2019 is major version 15
    }

    [Fact]
    public async Task MemoryGrantWithNullGrantTimeIsReportedAsWaitingForGrant()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart)),
            MemoryGrants = _ => Task.FromResult<IReadOnlyList<MemoryGrantRow>>([
                new MemoryGrantRow(77, 1, 0, 1, DateTimeOffset.UnixEpoch, null, 51200, null, 40000, null, null, null, 12.5m, 30, 1500, null, null, "SELECT big_table"),
                new MemoryGrantRow(78, 1, 0, 1, DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, 51200, 51200, 40000, 10000, 12000, 45000, 8.0m, 30, null, null, null, "SELECT other_table"),
            ]),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Test Server", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        var waiting = Assert.Single(snapshot.MemoryGrants, g => g.SessionId == 77);
        Assert.True(waiting.IsWaitingForGrant);
        Assert.Null(waiting.GrantTime);

        var granted = Assert.Single(snapshot.MemoryGrants, g => g.SessionId == 78);
        Assert.False(granted.IsWaitingForGrant);
    }

    [Fact]
    public async Task AzureSqlDatabaseIsAlwaysDatabaseScopedWithUnavailableServerWideReasonNotZero()
    {
        var probes = new FakeLiveIncidentProbeExecutor
        {
            ServerIdentity = _ => Task.FromResult(FakeLiveIncidentProbeExecutor.DefaultIdentity(EngineStart, engineEdition: 5)),
        };
        var collector = new LiveIncidentCollector(probes, "target-1", "Azure SQL DB Test", TimeProvider.System);

        var snapshot = await collector.CollectAsync(1, CancellationToken.None);

        Assert.Equal("DatabaseScoped", snapshot.Target.VisibilityScope);
        Assert.NotNull(snapshot.Target.UnavailableServerWideEvidenceReason);
    }
}
