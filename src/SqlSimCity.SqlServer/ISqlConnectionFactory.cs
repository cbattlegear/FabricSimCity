namespace SqlSimCity.SqlServer;

/// <summary>
/// Builds and opens a SQL Server connection from a validated
/// <see cref="ConnectionProfile"/>. Every connection is built through
/// <c>SqlConnectionStringBuilder</c> only, and exactly one authentication
/// strategy is applied with no fallback to another on failure.
/// </summary>
public interface ISqlConnectionFactory : IDisposable, IAsyncDisposable
{
    Task<SqlConnectionOpenResult> OpenAsync(ConnectionProfile profile, CancellationToken cancellationToken);

    /// <summary>
    /// Removes a cached SQL-login credential after the mounted password rotates.
    /// The associated pool is cleared after active results drain and before the
    /// old password is disposed. A bounded cancellation token leaves cleanup
    /// pending for <see cref="RetryPendingCleanupAsync"/>.
    /// </summary>
    Task InvalidateSqlLoginProfileAsync(
        ConnectionProfile profile,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Removes a cached Entra credential/callback after its mounted
    /// certificate or client secret rotates, or to force a managed- or
    /// workload-identity profile to acquire a fresh <c>TokenCredential</c> on
    /// its next open. The associated pool is cleared before any owned
    /// certificate material is disposed.
    /// </summary>
    Task InvalidateEntraProfileAsync(
        ConnectionProfile profile,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Retries pool cleanup retained after an earlier invalidation or shutdown
    /// failure. This remains available after shutdown has started.
    /// </summary>
    Task RetryPendingCleanupAsync(CancellationToken cancellationToken = default);
}
