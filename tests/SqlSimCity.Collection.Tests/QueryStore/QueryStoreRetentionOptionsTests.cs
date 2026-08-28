using SqlSimCity.Collection.QueryStore;

namespace SqlSimCity.Collection.Tests.QueryStore;

/// <summary>
/// Retention used to be a pair of constants, so a deployment that wanted less history had no way to
/// ask for it and paid the full cold-start and publish cost regardless. These pin the configurable
/// horizon, and the invariant that made it a constant in the first place: what the collector reads
/// and what the sink keeps are held to one figure and cannot drift apart.
///
/// They also pin the horizons themselves. A traffic map grades streets by a ratio taken over what is
/// retained, so the retention horizon <em>is</em> the averaging window: at ninety days every street
/// is coloured by a quarter-year mean and an hour-old problem is invisible inside it.
/// </summary>
public sealed class QueryStoreRetentionOptionsTests
{
    [Fact]
    public void ConfiguringNothingKeepsOneDayOfHistory()
    {
        Assert.Equal(TimeSpan.FromDays(1), QueryStoreRetentionOptions.Default.EffectiveHistory);
        Assert.Equal(TimeSpan.FromDays(1), QueryStoreRetentionOptions.Default.EffectiveDetail);
    }

    /// <summary>
    /// Detail is what any window narrower than "everything retained" is computed from, so it is not
    /// rolled up ahead of history. Equal horizons, not a shorter detail one.
    /// </summary>
    [Fact]
    public void PerIntervalDetailSurvivesAsLongAsHistoryDoes()
    {
        Assert.Equal(
            QueryStoreRetentionOptions.Default.EffectiveHistory,
            QueryStoreRetentionOptions.Default.EffectiveDetail);
    }

    /// <summary>
    /// Lowering history alone must not fail to start. Detail follows it down rather than being
    /// rejected against a default the operator never set -- the trap the shipped
    /// <c>InitialLookbackDays: 90</c> laid before it was nulled.
    /// </summary>
    [Fact]
    public void LoweringHistoryAloneNarrowsDetailInsteadOfBeingRejected()
    {
        var options = new QueryStoreRetentionOptions(History: TimeSpan.FromHours(2));

        options.Validate();

        Assert.Equal(TimeSpan.FromHours(2), options.EffectiveDetail);
    }

    /// <summary>
    /// The cap is the whole reason retention and lookback were one constant. Expressing it against
    /// the configured horizon is what stops a lowered retention from leaving the collector reading
    /// evidence the first prune would discard.
    /// </summary>
    [Fact]
    public void TheBackfillHorizonNarrowsWithRetentionRatherThanOutrunningIt()
    {
        var options = new QueryStoreCollectionOptions(
            Retention: new QueryStoreRetentionOptions(History: TimeSpan.FromHours(2)));

        options.Validate();

        Assert.Equal(TimeSpan.FromHours(2), options.EffectiveBackfillHorizon);
    }

    /// <summary>
    /// A collector that reaches its whole horizon in one cold-start cycle publishes nothing until
    /// that cycle finishes, which is how a wiped volume takes a city offline. Walking back an
    /// increment per cycle is therefore the default rather than something to opt into.
    /// </summary>
    [Fact]
    public void TheProgressiveBackfillIsOnWithoutBeingAskedFor()
    {
        var options = new QueryStoreCollectionOptions();

        options.Validate();

        Assert.True(options.BackfillEnabled);
        Assert.Equal(TimeSpan.FromHours(1), options.EffectiveBackfillIncrement);
        Assert.Equal(TimeSpan.FromHours(3), options.EffectiveBackfillHorizon);
    }

    /// <summary>
    /// The first cycle takes one increment, not the whole horizon: that is what makes the load
    /// incremental rather than a cold start wearing a different name. It cannot go below the
    /// overlap, because a cycle is obliged to re-read that much regardless.
    /// </summary>
    [Fact]
    public void TheFirstCycleReadsOneIncrementFlooredAtTheOverlap()
    {
        var options = new QueryStoreCollectionOptions();

        options.Validate();

        Assert.Equal(TimeSpan.FromMinutes(65), options.EffectiveInitialLookback);
        Assert.True(options.EffectiveInitialLookback >= options.EffectiveOverlap);
        Assert.True(options.EffectiveInitialLookback < options.EffectiveBackfillHorizon);
    }

    [Fact]
    public void AWiderIncrementWidensTheFirstCycleWithIt()
    {
        var options = new QueryStoreCollectionOptions(BackfillIncrement: TimeSpan.FromHours(2));

        options.Validate();

        Assert.Equal(TimeSpan.FromHours(2), options.EffectiveInitialLookback);
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

    /// <summary>
    /// Half a day is now a supported horizon, not a rejected one: retention bounds a live picture
    /// rather than an archive. The floor moved to an hour, below which a prune could clear ground
    /// before the Query Store interval covering it has closed.
    /// </summary>
    [Fact]
    public void AHalfDayHorizonIsAcceptedNowThatRetentionBoundsALivePicture()
    {
        var options = new QueryStoreRetentionOptions(History: TimeSpan.FromHours(12));

        options.Validate();

        Assert.Equal(TimeSpan.FromHours(12), options.EffectiveHistory);
    }

    [Fact]
    public void ARetentionHorizonShorterThanAnHourIsRejected()
    {
        var options = new QueryStoreRetentionOptions(History: TimeSpan.FromMinutes(30));

        Assert.Throws<ArgumentOutOfRangeException>(options.Validate);
    }

    [Fact]
    public void ADetailHorizonShorterThanAnHourIsRejected()
    {
        var options = new QueryStoreRetentionOptions(Detail: TimeSpan.FromMinutes(30));

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
            Retention: new QueryStoreRetentionOptions(History: TimeSpan.FromMinutes(30)));

        Assert.Throws<ArgumentOutOfRangeException>(options.Validate);
    }
}
