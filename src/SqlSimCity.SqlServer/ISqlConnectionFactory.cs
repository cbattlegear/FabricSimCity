namespace SqlSimCity.SqlServer;

/// <summary>
/// Builds and opens a SQL Server connection from a validated
/// <see cref="ConnectionProfile"/>. Every connection is built through
/// <c>SqlConnectionStringBuilder</c> only, and exactly one authentication
/// strategy is applied with no fallback to another on failure.
/// </summary>
public interface ISqlConnectionFactory
{
    Task<SqlConnectionOpenResult> OpenAsync(ConnectionProfile profile, CancellationToken cancellationToken);
}
