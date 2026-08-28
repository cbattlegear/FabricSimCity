using SqlSimCity.Collection.QueryStore;

namespace SqlSimCity.Collection.Tests.QueryStore;

/// <summary>
/// Retention used to be a pair of constants, so a deployment that wanted less history than 90 days
/// had no way to ask for it and paid the full cold-start and publish cost regardless. These pin the
/// configurable horizon, and the invariant that made it a constant in the first place: what the
/// collector reads and what the sink keeps are held to one figure and cannot drift apart.
/// </summary>
public sealed class QueryStoreRetentionOptionsTests
{
    [Fact]
    public void ConfiguringNothingKeepsTheHorizonsThatShipped()
    {
        Assert.Equal(TimeSpan.FromDays(90), QueryStoreRetentionOptions.Default.EffectiveHistory);
        Assert.Equal(TimeSpan.FromDays(7), QueryStoreRetentionOptions.Default.EffectiveDetail);
    }

    /// <summary>
    /// The cap is the whole reason retention and lookback were one constant. Expressing it against
    /// the configured horizon is what stops a lowered retention from leaving the collector reading
    /// 90 days of evidence the first prune would discard.
    /// </summary>
    [Fact]
    public void TheInitialLookbackFollowsConfiguredRetentionRatherThanTheDefault()
    {
        var options = new QueryStoreCollectionOptions(
            Retention: new QueryStoreRetentionOptions(History: TimeSpan.FromDays(7)));

        options.Validate();

        Assert.Equal(TimeSpan.FromDays(7), options.EffectiveInitialLookback);
        Assert.Equal(TimeSpan.FromDays(7), options.EffectiveBackfillHorizon);
    }

    [Fact]
    public void AnInitialLookbackBeyondConfiguredRetentionIsRejected()
    {
        var options = new QueryStoreCollectionOptions(
            InitialLookback: TimeSpan.FromDays(30),
            Retention: new QueryStoreRetentionOptions(History: TimeSpan.FromDays(7)));

        Assert.Throws<ArgumentOutOfRangeException>(options.Validate);
    }

    [Fact]
    public void ABackfillHorizonBeyondConfiguredRetentionIsRejected()
    {
        var options = new QueryStoreCollectionOptions(
            BackfillIncrement: TimeSpan.FromDays(1),
            BackfillHorizon: TimeSpan.FromDays(30),
            Retention: new QueryStoreRetentionOptions(History: TimeSpan.FromDays(7)));

        Assert.Throws<ArgumentOutOfRangeException>(options.Validate);
    }

    /// <summary>
    /// Detail is a window inside history. Allowing it to reach further would promise per-interval
    /// rows for ground the prune has already cleared.
    /// </summary>
    [Fact]
    public void ADetailHorizonBeyondTheRetentionHorizonIsRejected()
    {
        var options = new QueryStoreRetentionOptions(
            History: TimeSpan.FromDays(7), Detail: TimeSpan.FromDays(30));

        Assert.Throws<ArgumentOutOfRangeException>(options.Validate);
    }

    [Fact]
    public void ARetentionHorizonBeyondTheSupportedMaximumIsRejected()
    {
        var options = new QueryStoreRetentionOptions(
            History: QueryStoreRetention.MaximumHistory + TimeSpan.FromDays(1));

        Assert.Throws<ArgumentOutOfRangeException>(options.Validate);
    }

    [Fact]
    public void ARetentionHorizonShorterThanADayIsRejected()
    {
        var options = new QueryStoreRetentionOptions(History: TimeSpan.FromHours(12));

        Assert.Throws<ArgumentOutOfRangeException>(options.Validate);
    }

    [Fact]
    public void ADetailHorizonShorterThanADayIsRejected()
    {
        var options = new QueryStoreRetentionOptions(Detail: TimeSpan.FromHours(12));

        Assert.Throws<ArgumentOutOfRangeException>(options.Validate);
    }

    /// <summary>
    /// Collection options validate the retention they were handed, so an incoherent pair is caught
    /// at startup by whichever of the two is built first rather than surviving into a cycle.
    /// </summary>
    [Fact]
    public void CollectionOptionsRejectAnInvalidRetentionHorizon()
    {
        var options = new QueryStoreCollectionOptions(
            Retention: new QueryStoreRetentionOptions(History: TimeSpan.FromHours(12)));

        Assert.Throws<ArgumentOutOfRangeException>(options.Validate);
    }
}
