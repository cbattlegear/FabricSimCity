namespace SqlSimCity.Storage;

/// <summary>
/// Retention windows applied by <see cref="IProtectedRecordStore.PruneExpiredAsync"/>.
/// Defaults match the documented policy: 7 days of detail records and 90 days
/// of hourly rollups, pruned in bounded batches so a single call cannot lock
/// the store for an unbounded duration.
/// </summary>
public sealed class RetentionOptions
{
    public TimeSpan DetailRetention { get; set; } = TimeSpan.FromDays(7);

    public TimeSpan HourlyRollupRetention { get; set; } = TimeSpan.FromDays(90);

    /// <summary>Maximum number of records deleted per pruning round-trip.</summary>
    public int PruneBatchSize { get; set; } = 500;
}
