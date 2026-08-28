using Microsoft.Extensions.Configuration;
using SqlSimCity.Collection.QueryStore;

namespace SqlSimCity.Api.Tests;

/// <summary>
/// How much history a deployment keeps is now an operator setting rather than a constant, and the
/// defaults describe a live traffic picture -- a day of history, a three-hour backfill walked an
/// hour per cycle -- rather than a ninety-day archive. The traps pinned here are the ones that fail
/// at startup rather than in a cycle: a shipped default that silently outranks a lowered retention,
/// an explicit lookback that reaches past it, and a retired key whose unit changed underneath it.
/// </summary>
public sealed class QueryStoreRetentionConfigurationTests
{
    private static IConfiguration Build(params (string Key, string? Value)[] values)
    {
        var settings = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        foreach (var (key, value) in values)
            settings[key] = value;
        return new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
    }

    [Fact]
    public void ConfiguringNothingKeepsADayOfHistoryRatherThanAQuarterOfAYear()
    {
        var retention = QueryStoreHistoryConfiguration.BuildRetentionOptions(Build());

        Assert.Equal(TimeSpan.FromDays(1), retention.EffectiveHistory);
        // Detail matches history on purpose: a narrow window reads per-interval detail, so keeping
        // less of it than of the aggregate would leave the city unable to grade its own horizon.
        Assert.Equal(TimeSpan.FromDays(1), retention.EffectiveDetail);
    }

    /// <summary>
    /// The backfill is on without being configured, and reaches three hours an hour at a time. A
    /// fresh volume therefore has a past to grade traffic against within a few cycles instead of
    /// publishing nothing until an unbounded cold start finishes.
    /// </summary>
    [Fact]
    public void ConfiguringNothingWalksThreeHoursBackAnHourPerCycle()
    {
        var options = QueryStoreHistoryConfiguration.BuildCollectionOptions(Build());

        Assert.True(options.BackfillEnabled);
        Assert.Equal(TimeSpan.FromHours(1), options.EffectiveBackfillIncrement);
        Assert.Equal(TimeSpan.FromHours(3), options.EffectiveBackfillHorizon);
        Assert.Equal(TimeSpan.FromMinutes(65), options.EffectiveInitialLookback);
    }

    [Fact]
    public void RetentionHoursIsReadIntoTheHorizonTheSinkPrunesAt()
    {
        var retention = QueryStoreHistoryConfiguration.BuildRetentionOptions(
            Build(("QueryStoreHistory:RetentionHours", "6"),
                  ("QueryStoreHistory:DetailRetentionHours", "2")));

        Assert.Equal(TimeSpan.FromHours(6), retention.EffectiveHistory);
        Assert.Equal(TimeSpan.FromHours(2), retention.EffectiveDetail);
    }

    [Fact]
    public void BackfillIncrementIsReadInMinutesRatherThanHours()
    {
        var options = QueryStoreHistoryConfiguration.BuildCollectionOptions(
            Build(("QueryStoreHistory:BackfillIncrementMinutes", "15")));

        Assert.Equal(TimeSpan.FromMinutes(15), options.EffectiveBackfillIncrement);
    }

    /// <summary>
    /// Lowering retention alone must be enough. The lookback and backfill horizon narrow with the
    /// configured retention rather than staying pinned above it, so an operator who sets one
    /// setting does not get a startup failure from two defaults they never touched.
    /// </summary>
    [Fact]
    public void LoweringRetentionAloneLowersTheDerivedHorizonsInsteadOfFailingValidation()
    {
        var options = QueryStoreHistoryConfiguration.BuildCollectionOptions(
            Build(("QueryStoreHistory:RetentionHours", "2")));

        Assert.Equal(TimeSpan.FromHours(2), options.EffectiveBackfillHorizon);
        Assert.Equal(TimeSpan.FromHours(2), options.EffectiveRetention.EffectiveHistory);
        Assert.True(options.EffectiveInitialLookback <= TimeSpan.FromHours(2));
    }

    [Fact]
    public void AnExplicitLookbackBeyondALoweredRetentionIsRejected()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            QueryStoreHistoryConfiguration.BuildCollectionOptions(
                Build(("QueryStoreHistory:RetentionHours", "2"),
                      ("QueryStoreHistory:InitialLookbackMinutes", "300"))));
    }

    /// <summary>
    /// A lookback wider than the three-hour default horizon is honoured and boots: the derived
    /// horizon follows it up rather than rejecting a contradiction the operator never wrote.
    /// </summary>
    [Fact]
    public void AnExplicitLookbackWiderThanTheDefaultHorizonStillStarts()
    {
        var options = QueryStoreHistoryConfiguration.BuildCollectionOptions(
            Build(("QueryStoreHistory:RetentionHours", "12"),
                  ("QueryStoreHistory:InitialLookbackMinutes", "480")));

        Assert.Equal(TimeSpan.FromHours(8), options.EffectiveInitialLookback);
        Assert.Equal(TimeSpan.FromHours(8), options.EffectiveBackfillHorizon);
    }

    [Fact]
    public void AnIncoherentRetentionPairFailsAtStartupRatherThanInACycle()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            QueryStoreHistoryConfiguration.BuildRetentionOptions(
                Build(("QueryStoreHistory:RetentionHours", "2"),
                      ("QueryStoreHistory:DetailRetentionHours", "30"))));
    }

    /// <summary>
    /// A retired key is refused by name rather than ignored. This is the one rename that cannot
    /// fail loudly on its own: the unit changed, so <c>BackfillHorizonDays: 3</c> read as hours
    /// would quietly shrink the horizon by a factor of 24 and nothing would say so.
    /// </summary>
    [Theory]
    [InlineData("RetentionDays", "RetentionHours")]
    [InlineData("DetailRetentionDays", "DetailRetentionHours")]
    [InlineData("InitialLookbackDays", "InitialLookbackMinutes")]
    [InlineData("BackfillIncrementHours", "BackfillIncrementMinutes")]
    [InlineData("BackfillHorizonDays", "BackfillHorizonHours")]
    public void ARetiredSettingIsRefusedByNameRatherThanSilentlyIgnored(
        string retired, string replacement)
    {
        var error = Assert.Throws<InvalidOperationException>(() =>
            QueryStoreHistoryConfiguration.BuildCollectionOptions(
                Build(($"QueryStoreHistory:{retired}", "3"))));

        Assert.Contains(retired, error.Message, StringComparison.Ordinal);
        Assert.Contains(replacement, error.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// The shipped appsettings.json is the other half of the trap above: pinning
    /// InitialLookbackMinutes or BackfillHorizonHours there would outrank a lowered RetentionHours
    /// and take the container down on boot. Reading the real file is the only way to see that,
    /// since every other test here builds configuration in memory and would never load it.
    /// </summary>
    [Fact]
    public void TheShippedDefaultsDoNotOutrankALoweredRetention()
    {
        var settings = LocateAppSettings();
        var configuration = new ConfigurationBuilder()
            .AddJsonFile(settings, optional: false)
            .AddInMemoryCollection(new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
            {
                ["QueryStoreHistory:RetentionHours"] = "2",
            })
            .Build();

        var options = QueryStoreHistoryConfiguration.BuildCollectionOptions(configuration);

        Assert.Equal(TimeSpan.FromHours(2), options.EffectiveRetention.EffectiveHistory);
        Assert.Equal(TimeSpan.FromHours(2), options.EffectiveBackfillHorizon);
        Assert.True(options.EffectiveInitialLookback <= TimeSpan.FromHours(2));
    }

    /// <summary>
    /// And the shipped file itself must carry no retired key, which the guard above would only
    /// catch for configuration built in memory.
    /// </summary>
    [Fact]
    public void TheShippedSettingsCarryNoRetiredKey()
    {
        var configuration = new ConfigurationBuilder()
            .AddJsonFile(LocateAppSettings(), optional: false)
            .Build();

        var options = QueryStoreHistoryConfiguration.BuildCollectionOptions(configuration);

        Assert.Equal(TimeSpan.FromDays(1), options.EffectiveRetention.EffectiveHistory);
    }

    private static string LocateAppSettings()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(
                directory.FullName, "src", "SqlSimCity.Api", "appsettings.json");
            if (File.Exists(candidate)) return candidate;
            directory = directory.Parent;
        }

        // Failing loudly beats skipping: a test that cannot find its input must not pass.
        throw new FileNotFoundException(
            "Could not locate src/SqlSimCity.Api/appsettings.json above " + AppContext.BaseDirectory);
    }
}
