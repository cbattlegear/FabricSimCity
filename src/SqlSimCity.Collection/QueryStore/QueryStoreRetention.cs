namespace SqlSimCity.Collection.QueryStore;

/// <summary>
/// The default horizons retained history covers. <see cref="QueryStoreRetentionOptions"/> is what
/// the collector and the sink actually read; these are the figures it falls back to, so a
/// deployment that configures nothing keeps exactly the behaviour that shipped without the setting.
/// </summary>
public static class QueryStoreRetention
{
    /// <summary>
    /// How far back normalized facts and hourly rollups are kept by default.
    ///
    /// One day, because this map is a picture of a city's <em>current</em> traffic. Ninety days of
    /// accumulated executions grade every street by a quarter-year average, which is the one thing
    /// a traffic map must not do: a road that was slow in May reads slow today, and a road that
    /// went bad an hour ago is diluted to nothing by the ninety days of calm behind it.
    /// </summary>
    public static readonly TimeSpan History = TimeSpan.FromDays(1);

    /// <summary>
    /// How far back per-interval runtime detail is kept before it is rolled up hourly.
    ///
    /// Equal to <see cref="History"/> rather than shorter than it. Per-interval rows are what any
    /// window narrower than "everything retained" is computed from, so rolling them up early would
    /// leave the recent-activity window nothing to read.
    /// </summary>
    public static readonly TimeSpan Detail = TimeSpan.FromDays(1);

    /// <summary>
    /// The longest history horizon an operator may configure. Every publish rewrites the whole
    /// slot, so storage and write churn both scale with what is retained; a ceiling keeps a
    /// mistyped setting from turning each cycle into an unbounded rewrite.
    /// </summary>
    public static readonly TimeSpan MaximumHistory = TimeSpan.FromDays(365);

    /// <summary>
    /// The shortest history horizon an operator may configure.
    ///
    /// An hour rather than a day, because retention now bounds a live picture instead of an
    /// archive. Below an hour the horizon starts to undercut Query Store's own interval length,
    /// at which point a prune can clear ground before the interval covering it has closed.
    /// </summary>
    public static readonly TimeSpan MinimumHistory = TimeSpan.FromHours(1);
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

    /// <summary>
    /// The detail horizon, never longer than the history horizon it sits inside.
    ///
    /// The cap is applied to the *default* rather than rejected in <see cref="Validate"/>, so that
    /// lowering history alone narrows detail with it. Pinning the default instead would make
    /// <c>RetentionHours: 2</c> fail to start against a detail horizon the operator never set --
    /// the same trap the shipped <c>InitialLookbackDays: 90</c> laid before it was nulled.
    /// </summary>
    public TimeSpan EffectiveDetail
    {
        get
        {
            if (Detail is { } configured) return configured;
            var history = EffectiveHistory;
            return QueryStoreRetention.Detail < history ? QueryStoreRetention.Detail : history;
        }
    }

    public void Validate()
    {
        if (EffectiveHistory < QueryStoreRetention.MinimumHistory || EffectiveHistory > QueryStoreRetention.MaximumHistory)
            throw new ArgumentOutOfRangeException(
                nameof(History),
                "The Query Store retention horizon must be at least " +
                $"{QueryStoreRetention.MinimumHistory.TotalHours:0} hour(s) and at most " +
                $"{QueryStoreRetention.MaximumHistory.TotalDays:0} days.");
        if (EffectiveDetail < QueryStoreRetention.MinimumHistory)
            throw new ArgumentOutOfRangeException(
                nameof(Detail),
                "The Query Store detail horizon must be at least " +
                $"{QueryStoreRetention.MinimumHistory.TotalHours:0} hour(s).");
        // Detail is a window inside history, not a second horizon beside it. Letting it reach
        // further back would promise per-interval rows for ground the prune has already cleared.
        if (EffectiveDetail > EffectiveHistory)
            throw new ArgumentOutOfRangeException(
                nameof(Detail),
                "The Query Store detail horizon cannot exceed the retention horizon; per-interval " +
                "detail is kept inside retained history, not beyond it.");
    }
}
