namespace SqlSimCity.Collection.QueryStore;

/// <summary>
/// The default horizons retained history covers. <see cref="QueryStoreRetentionOptions"/> is what
/// the collector and the sink actually read; these are the figures it falls back to, so a
/// deployment that configures nothing keeps exactly the behaviour that shipped without the setting.
/// </summary>
public static class QueryStoreRetention
{
    /// <summary>How far back normalized facts and hourly rollups are kept by default.</summary>
    public static readonly TimeSpan History = TimeSpan.FromDays(90);

    /// <summary>How far back per-interval runtime detail is kept before it is rolled up hourly.</summary>
    public static readonly TimeSpan Detail = TimeSpan.FromDays(7);

    /// <summary>
    /// The longest history horizon an operator may configure. Every publish rewrites the whole
    /// slot, so storage and write churn both scale with what is retained; a ceiling keeps a
    /// mistyped setting from turning each cycle into an unbounded rewrite.
    /// </summary>
    public static readonly TimeSpan MaximumHistory = TimeSpan.FromDays(365);
}

/// <summary>
/// How much history this deployment keeps, resolved once and handed to both the collector and the
/// sink so that what one reads and what the other keeps cannot drift apart. Reading further back
/// than <see cref="EffectiveHistory"/> puts load on a production instance to gather evidence the
/// first prune discards, which is why it also bounds the collector's initial lookback and backfill.
/// </summary>
/// <param name="History">
/// How far back normalized facts and hourly rollups are kept. <c>null</c> uses
/// <see cref="QueryStoreRetention.History"/>.
/// </param>
/// <param name="Detail">
/// How far back per-interval runtime detail survives before it is rolled up hourly. <c>null</c>
/// uses <see cref="QueryStoreRetention.Detail"/>.
/// </param>
public sealed record QueryStoreRetentionOptions(TimeSpan? History = null, TimeSpan? Detail = null)
{
    /// <summary>The horizons that shipped before retention was configurable.</summary>
    public static QueryStoreRetentionOptions Default { get; } = new();

    public TimeSpan EffectiveHistory => History ?? QueryStoreRetention.History;

    public TimeSpan EffectiveDetail => Detail ?? QueryStoreRetention.Detail;

    public void Validate()
    {
        if (EffectiveHistory < TimeSpan.FromDays(1) || EffectiveHistory > QueryStoreRetention.MaximumHistory)
            throw new ArgumentOutOfRangeException(
                nameof(History),
                "The Query Store retention horizon must be at least one day and at most " +
                $"{QueryStoreRetention.MaximumHistory.TotalDays:0} days.");
        if (EffectiveDetail < TimeSpan.FromDays(1))
            throw new ArgumentOutOfRangeException(
                nameof(Detail),
                "The Query Store detail horizon must be at least one day.");
        // Detail is a window inside history, not a second horizon beside it. Letting it reach
        // further back would promise per-interval rows for ground the prune has already cleared.
        if (EffectiveDetail > EffectiveHistory)
            throw new ArgumentOutOfRangeException(
                nameof(Detail),
                "The Query Store detail horizon cannot exceed the retention horizon; per-interval " +
                "detail is kept inside retained history, not beyond it.");
    }
}
