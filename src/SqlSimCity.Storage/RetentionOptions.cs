namespace SqlSimCity.Storage;

/// <summary>
/// Retention windows applied by <see cref="IProtectedRecordStore.PruneExpiredAsync"/>.
/// Defaults match the documented policy: 7 days of detail records and 90 days
/// of hourly rollups, pruned in bounded batches so a single call cannot lock
/// the store for an unbounded duration.
/// </summary>
public sealed class RetentionOptions
{
    /// <summary>
    /// SQLite's default parameter limit is 999. The lower bound leaves room for
    /// future pruning predicates while keeping one invocation predictably small.
    /// </summary>
    public const int MaximumPruneBatchSize = 500;

    public TimeSpan DetailRetention { get; set; } = TimeSpan.FromDays(7);

    public TimeSpan HourlyRollupRetention { get; set; } = TimeSpan.FromDays(90);

    /// <summary>
    /// Maximum number of records a single <see cref="IProtectedRecordStore.PruneExpiredAsync"/>
    /// invocation deletes. Valid values are 1 through <see cref="MaximumPruneBatchSize"/>.
    /// </summary>
    public int PruneBatchSize { get; set; } = 500;
}
