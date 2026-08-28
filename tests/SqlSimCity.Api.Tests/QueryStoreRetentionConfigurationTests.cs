using Microsoft.Extensions.Configuration;
using SqlSimCity.Collection.QueryStore;

namespace SqlSimCity.Api.Tests;

/// <summary>
/// How much history a deployment keeps is now an operator setting rather than a constant. The
/// traps pinned here are the two that fail at startup rather than in a cycle: a shipped default
/// that silently outranks a lowered retention, and an explicit lookback that reaches past it.
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
    public void ConfiguringNothingKeepsTheHorizonsThatShipped()
    {
        var retention = QueryStoreHistoryConfiguration.BuildRetentionOptions(Build());

        Assert.Equal(TimeSpan.FromDays(90), retention.EffectiveHistory);
        Assert.Equal(TimeSpan.FromDays(7), retention.EffectiveDetail);
    }

    [Fact]
    public void RetentionDaysIsReadIntoTheHorizonTheSinkPrunesAt()
    {
        var retention = QueryStoreHistoryConfiguration.BuildRetentionOptions(
            Build(("QueryStoreHistory:RetentionDays", "7"),
                  ("QueryStoreHistory:DetailRetentionDays", "2")));

        Assert.Equal(TimeSpan.FromDays(7), retention.EffectiveHistory);
        Assert.Equal(TimeSpan.FromDays(2), retention.EffectiveDetail);
    }

    /// <summary>
    /// Lowering retention alone must be enough. The lookback and backfill horizon default to the
    /// configured retention rather than to a pinned 90, so an operator who sets one setting does
    /// not get an startup failure from two defaults they never touched.
    /// </summary>
    [Fact]
    public void LoweringRetentionAloneLowersTheLookbackInsteadOfFailingValidation()
    {
        var options = QueryStoreHistoryConfiguration.BuildCollectionOptions(
            Build(("QueryStoreHistory:RetentionDays", "7")));

        Assert.Equal(TimeSpan.FromDays(7), options.EffectiveInitialLookback);
        Assert.Equal(TimeSpan.FromDays(7), options.EffectiveBackfillHorizon);
        Assert.Equal(TimeSpan.FromDays(7), options.EffectiveRetention.EffectiveHistory);
    }

    [Fact]
    public void AnExplicitLookbackBeyondALoweredRetentionIsRejected()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            QueryStoreHistoryConfiguration.BuildCollectionOptions(
                Build(("QueryStoreHistory:RetentionDays", "7"),
                      ("QueryStoreHistory:InitialLookbackDays", "30"))));
    }

    [Fact]
    public void AnExplicitLookbackWithinRetentionIsStillHonoured()
    {
        var options = QueryStoreHistoryConfiguration.BuildCollectionOptions(
            Build(("QueryStoreHistory:RetentionDays", "30"),
                  ("QueryStoreHistory:InitialLookbackDays", "2")));

        Assert.Equal(TimeSpan.FromDays(2), options.EffectiveInitialLookback);
        Assert.Equal(TimeSpan.FromDays(30), options.EffectiveBackfillHorizon);
    }

    [Fact]
    public void AnIncoherentRetentionPairFailsAtStartupRatherThanInACycle()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            QueryStoreHistoryConfiguration.BuildRetentionOptions(
                Build(("QueryStoreHistory:RetentionDays", "2"),
                      ("QueryStoreHistory:DetailRetentionDays", "30"))));
    }

    /// <summary>
    /// The shipped appsettings.json is the other half of the trap above: pinning
    /// InitialLookbackDays or BackfillHorizonDays there would outrank a lowered RetentionDays and
    /// take the container down on boot. Reading the real file is the only way to see that, since
    /// every other test here builds configuration in memory and would never load it.
    /// </summary>
    [Fact]
    public void TheShippedDefaultsDoNotOutrankALoweredRetention()
    {
        var settings = LocateAppSettings();
        var configuration = new ConfigurationBuilder()
            .AddJsonFile(settings, optional: false)
            .AddInMemoryCollection(new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
            {
                ["QueryStoreHistory:RetentionDays"] = "7",
            })
            .Build();

        var options = QueryStoreHistoryConfiguration.BuildCollectionOptions(configuration);

        Assert.Equal(TimeSpan.FromDays(7), options.EffectiveInitialLookback);
        Assert.Equal(TimeSpan.FromDays(7), options.EffectiveBackfillHorizon);
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
