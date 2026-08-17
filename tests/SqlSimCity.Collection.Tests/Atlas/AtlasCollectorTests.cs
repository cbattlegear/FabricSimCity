using SqlSimCity.Collection.Atlas;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using System.Globalization;
using System.Numerics;

namespace SqlSimCity.Collection.Tests.Atlas;

public sealed class AtlasCollectorTests
{
    [Fact]
    public void RejectsDatabaseAndConcurrencyLimitsAboveHardMaximum()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new AtlasCollectionOptions
        {
            KnownDatabases = Enumerable.Range(0, 101).Select(index => $"db-{index}").ToArray(),
        }.Validate());
        Assert.Throws<ArgumentOutOfRangeException>(() => new AtlasCollectionOptions
        {
            DatabaseConcurrency = 17,
        }.Validate());
    }

    [Fact]
    public async Task CollectsOneHundredWithBoundedConcurrencyAndPartialFailure()
    {
        var executor = new FakeExecutor
        {
            Databases = Enumerable.Range(1, 100)
                .Select(index => new AtlasDatabaseIdentity($"db-{index}", "ONLINE", 160, true))
                .ToArray(),
            Result = name => name switch
            {
                "db-42" => throw new ProbePermissionDeniedException("Database permission denied.", 229, 14),
                "db-43" => throw new ProbeTimeoutException("Database probe timed out.", -2, 11),
                _ => DatabaseResult(name),
            },
            Delay = TimeSpan.FromMilliseconds(5),
        };
        var collector = Collector(executor, new AtlasCollectionOptions { DatabaseConcurrency = 5 });

        var result = await collector.CollectAsync(1, CancellationToken.None);

        Assert.Equal(100, result.Snapshot.Databases.Count);
        Assert.Equal(2, result.Status.FailureCount);
        Assert.Equal(AtlasCollectorState.Degraded, result.Status.State);
        Assert.True(result.Status.RowCount > 0);
        Assert.InRange(executor.MaximumActive, 2, 5);
        Assert.Equal(DataStatus.PermissionDenied,
            result.Snapshot.Databases.Single(database => database.Name == "db-42").Allocated.Evidence.Status);
        var exact = result.Snapshot.Databases.Single(database => database.Name == "db-1");
        Assert.Equal("9007199254740993", exact.Allocated.Bytes);
        Assert.Equal("27021597764222979", exact.QueryStore.TotalDurationMicroseconds);
        Assert.Equal("9007199254740993", exact.QueryStore.ExecutionCount);
        Assert.All(executor.Selections, selection =>
            Assert.Equal("querystore.runtime_stats_summary_2022", selection.QueryStoreRuntimeProbeId));
        Assert.All(executor.Selections, selection =>
            Assert.Equal("io.file_io_stats", selection.FileIoProbeId));
    }

    [Fact]
    public async Task AzureUsesOnlyConfiguredKnownDatabaseListAndCurrentDatabaseIo()
    {
        var executor = new FakeExecutor
        {
            Target = Target(EnginePlatform.AzureSqlDatabase),
            Result = DatabaseResult,
        };
        var options = new AtlasCollectionOptions
        {
            KnownDatabases = ["sales", "warehouse"],
            DatabaseConcurrency = 2,
        };

        var result = await Collector(executor, options).CollectAsync(1, CancellationToken.None);

        Assert.Equal(["sales", "warehouse"], result.Snapshot.Databases.Select(database => database.Name));
        Assert.Equal(0, executor.DiscoveryCalls);
        Assert.All(executor.Selections, selection =>
            Assert.Equal("io.file_io_stats_current_db", selection.FileIoProbeId));
        Assert.All(result.Snapshot.Databases, database =>
            Assert.StartsWith("primary/database/", database.DatabaseId, StringComparison.Ordinal));
    }

    [Fact]
    public async Task IoRatesRequireComparableSecondSampleAndResetEpoch()
    {
        var bytes = 100L;
        var sample = 1_000L;
        var executor = new FakeExecutor
        {
            Databases = [new AtlasDatabaseIdentity("db", "ONLINE", 160, true)],
            Result = name => DatabaseResult(name) with
            {
                FileIo = [new AtlasFileIoCounter(1, bytes.ToString(CultureInfo.InvariantCulture), (bytes * 2).ToString(CultureInfo.InvariantCulture), sample)],
            },
        };
        var collector = Collector(executor);

        var first = await collector.CollectAsync(1, CancellationToken.None);
        bytes = 1_100;
        sample = 2_000;
        var second = await collector.CollectAsync(2, CancellationToken.None);
        executor.Target = executor.Target with { SqlServerStartTime = executor.Target.SqlServerStartTime!.Value.AddMinutes(1) };
        bytes = 2_100;
        sample = 3_000;
        var reset = await collector.CollectAsync(3, CancellationToken.None);

        Assert.Null(first.Snapshot.Databases[0].FileIo!.ReadBytesPerSecond);
        Assert.Equal("1000", second.Snapshot.Databases[0].FileIo!.ReadBytesPerSecond);
        Assert.Null(reset.Snapshot.Databases[0].FileIo!.ReadBytesPerSecond);
        Assert.Contains("reset", reset.Snapshot.Databases[0].FileIo!.Evidence.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("OFF", QueryStoreCapability.Disabled, QueryStoreHealth.Unavailable)]
    [InlineData("READ_ONLY", QueryStoreCapability.Available, QueryStoreHealth.ReadOnly)]
    [InlineData("ERROR", QueryStoreCapability.Available, QueryStoreHealth.Error)]
    public async Task ProjectsQueryStoreOperationalReason(
        string state,
        QueryStoreCapability capability,
        QueryStoreHealth health)
    {
        var executor = new FakeExecutor
        {
            Databases = [new AtlasDatabaseIdentity("db", "ONLINE", 160, true)],
            Result = name => DatabaseResult(name) with
            {
                QueryStore = DatabaseResult(name).QueryStore with { ActualState = state, ReadOnlyReason = 65536 },
            },
        };

        var result = await Collector(executor).CollectAsync(1, CancellationToken.None);

        Assert.Equal(capability, result.Snapshot.Databases[0].QueryStore.Capability);
        Assert.Equal(health, result.Snapshot.Databases[0].QueryStore.Health);
        if (state == "READ_ONLY")
            Assert.Contains("max_storage_size_mb", result.Snapshot.Databases[0].QueryStore.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RefreshPreventsOverlapSupportsPauseAndBacksOff()
    {
        var executor = new FakeExecutor
        {
            IdentityFailure = new ProbeTransientConnectionException("Target unavailable.", 40613, 20),
        };
        var options = new AtlasCollectionOptions();
        var coordinator = new AtlasRefreshCoordinator(
            Collector(executor, options), options,
            new ExponentialReconnectBackoff(TimeSpan.FromSeconds(5), TimeSpan.FromMinutes(1), new FixedJitter()),
            TimeProvider.System);

        var first = await coordinator.TryRefreshAsync(CancellationToken.None);
        var status = coordinator.GetStatus();
        coordinator.Pause();
        var paused = await coordinator.TryRefreshAsync(CancellationToken.None);
        coordinator.Resume();

        Assert.True(first);
        Assert.False(paused);
        Assert.Equal(AtlasCollectorState.BackingOff, status.State);
        Assert.Equal(1, status.ConsecutiveFailures);
        Assert.NotNull(status.NextAttemptAt);
    }

    [Fact]
    public async Task RefreshRejectsOverlappingCycle()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var executor = new FakeExecutor
        {
            Databases = [new AtlasDatabaseIdentity("db", "ONLINE", 160, true)],
            Block = release.Task,
            Entered = entered,
        };
        var options = new AtlasCollectionOptions();
        using var coordinator = new AtlasRefreshCoordinator(
            Collector(executor, options), options,
            new ExponentialReconnectBackoff(TimeSpan.FromSeconds(5), TimeSpan.FromMinutes(1), new FixedJitter()));

        var first = coordinator.TryRefreshAsync(CancellationToken.None);
        await entered.Task;
        var overlapping = await coordinator.TryRefreshAsync(CancellationToken.None);
        release.SetResult();

        Assert.False(overlapping);
        Assert.True(await first);
    }

    [Theory]
    [InlineData("13.0.1", "querystore.options_2016", "querystore.runtime_stats_summary_2016")]
    [InlineData("15.0.1", "querystore.options_2019", "querystore.runtime_stats_summary_2016")]
    [InlineData("16.0.1", "querystore.options_2019", "querystore.runtime_stats_summary_2022")]
    public void ProbeVariantsFollowNegotiatedMajorVersion(string version, string options, string runtime)
    {
        var selection = AtlasCollector.SelectProbes(Target() with { ProductVersion = version });

        Assert.Equal(options, selection.QueryStoreOptionsProbeId);
        Assert.Equal(runtime, selection.QueryStoreRuntimeProbeId);
    }

    [Fact]
    public async Task RefreshStatusBecomesStaleFromInjectedClock()
    {
        var clock = new ManualTimeProvider(ParseDate("2026-08-17T13:00:00Z"));
        var executor = new FakeExecutor
        {
            Databases = [new AtlasDatabaseIdentity("db", "ONLINE", 160, true)],
        };
        var options = new AtlasCollectionOptions
        {
            RefreshInterval = TimeSpan.FromSeconds(10),
            StaleAfter = TimeSpan.FromSeconds(20),
        };
        using var coordinator = new AtlasRefreshCoordinator(
            Collector(executor, options, clock), options,
            new ExponentialReconnectBackoff(TimeSpan.FromSeconds(5), TimeSpan.FromMinutes(1), new FixedJitter()),
            clock);

        await coordinator.TryRefreshAsync(CancellationToken.None);
        Assert.False(coordinator.GetStatus().IsStale);
        clock.Advance(TimeSpan.FromSeconds(21));

        Assert.True(coordinator.GetStatus().IsStale);
        Assert.True(coordinator.GetCurrent().Collection!.IsStale);
    }

    [Fact]
    public async Task ActivitySeamSeparatesFixtureValuesFromConnectedNotProbed()
    {
        var fixtureValue = new LiveActivityV1(4, 2, 1, 10,
            new EvidenceV1(EvidenceSource.Fixture, DataStatus.Available, null, null, "fixture"));
        var fixture = new FixtureLiveAtlasActivitySource(
            new Dictionary<string, LiveActivityV1> { ["target/database/db"] = fixtureValue });
        var connected = new NotProbedLiveAtlasActivitySource();

        var fromFixture = await fixture.GetActivityAsync(
            "target/database/db", "db", DateTimeOffset.UnixEpoch, CancellationToken.None);
        var fromConnected = await connected.GetActivityAsync(
            "target/database/db", "db", DateTimeOffset.UnixEpoch, CancellationToken.None);

        Assert.Equal(4, fromFixture.ActiveSessions);
        Assert.Equal(EvidenceSource.Fixture, fromFixture.Evidence.Source);
        Assert.Null(fromConnected.ActiveSessions);
        Assert.Equal(EvidenceSource.NotProbed, fromConnected.Evidence.Source);
    }

    [Fact]
    public void AggregatesExactDataAndLogBytesAcrossFiles()
    {
        var result = SqlClientAtlasProbeExecutor.AggregateSpace(
            [
                new DatabaseFileSpaceValue("ROWS", BigInteger.Parse("9007199254740993", CultureInfo.InvariantCulture), new BigInteger(10)),
                new DatabaseFileSpaceValue("ROWS", new BigInteger(7), new BigInteger(5)),
                new DatabaseFileSpaceValue("LOG", new BigInteger(99), null),
            ],
            new BigInteger(99),
            new BigInteger(44));

        Assert.Equal("9007199254741000", result.DataAllocatedBytes);
        Assert.Equal("15", result.DataUsedBytes);
        Assert.Equal("99", result.LogAllocatedBytes);
        Assert.Equal("44", result.LogUsedBytes);
    }

    private static AtlasCollector Collector(
        FakeExecutor executor,
        AtlasCollectionOptions? options = null,
        TimeProvider? timeProvider = null) =>
        new(executor, new NotProbedLiveAtlasActivitySource(), options ?? new AtlasCollectionOptions(), timeProvider);

    private static AtlasTargetIdentity Target(EnginePlatform platform = EnginePlatform.SqlServerOnPremises) =>
        new(platform, "16.0.1000.1", "Developer", ParseDate("2026-08-17T12:00:00Z"),
            ParseDate("2026-08-17T13:00:00Z"));

    private static AtlasDatabaseProbeResult DatabaseResult(string name) => new(
        new AtlasDatabaseIdentity(name, "ONLINE", 160, true),
        new AtlasSpaceResult("9007199254740993", "4503599627370496", "1048576", "524288"),
        new AtlasQueryStoreResult(
            "ON", 0, "9007199254740993", "27021597764222979", "18014398509481986",
            "72057594037927944", ParseDate("2026-08-16T13:00:00Z"),
            ParseDate("2026-08-17T13:00:00Z")),
        [new AtlasFileIoCounter(1, "100", "200", 1000)],
        ParseDate("2026-08-17T13:00:00Z"),
        5);

    private static DateTimeOffset ParseDate(string value) =>
        DateTimeOffset.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);

    private sealed class FixedJitter : IReconnectJitter
    {
        public double NextUnit() => 0.5;
    }

    private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;
        private long _timestamp;
        public override DateTimeOffset GetUtcNow() => _now;
        public override long GetTimestamp() => _timestamp;
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
        public void Advance(TimeSpan value)
        {
            _now += value;
            _timestamp += value.Ticks;
        }
    }

    private sealed class FakeExecutor : IAtlasProbeExecutor
    {
        private int _active;
        public AtlasTargetIdentity Target { get; set; } = AtlasCollectorTests.Target();
        public IReadOnlyList<AtlasDatabaseIdentity> Databases { get; set; } = [];
        public Func<string, AtlasDatabaseProbeResult> Result { get; set; } = DatabaseResult;
        public TimeSpan Delay { get; set; }
        public ProbeExecutionException? IdentityFailure { get; set; }
        public Task? Block { get; set; }
        public TaskCompletionSource? Entered { get; set; }
        public int DiscoveryCalls { get; private set; }
        public int MaximumActive { get; private set; }
        public List<AtlasProbeSelection> Selections { get; } = [];

        public Task<AtlasTargetIdentity> GetTargetIdentityAsync(CancellationToken cancellationToken) =>
            IdentityFailure is null
                ? Task.FromResult(Target)
                : Task.FromException<AtlasTargetIdentity>(IdentityFailure);

        public Task<IReadOnlyList<AtlasDatabaseIdentity>> DiscoverDatabasesAsync(CancellationToken cancellationToken)
        {
            DiscoveryCalls++;
            return Task.FromResult(Databases);
        }

        public async Task<AtlasDatabaseProbeResult> CollectDatabaseAsync(
            string databaseName,
            AtlasProbeSelection selection,
            DateTimeOffset queryStoreWindowStart,
            DateTimeOffset queryStoreWindowEnd,
            CancellationToken cancellationToken)
        {
            lock (Selections) Selections.Add(selection);
            var active = Interlocked.Increment(ref _active);
            MaximumActive = Math.Max(MaximumActive, active);
            try
            {
                Entered?.SetResult();
                if (Block is not null) await Block.WaitAsync(cancellationToken);
                if (Delay > TimeSpan.Zero) await Task.Delay(Delay, cancellationToken);
                return Result(databaseName);
            }
            finally
            {
                Interlocked.Decrement(ref _active);
            }
        }
    }
}
