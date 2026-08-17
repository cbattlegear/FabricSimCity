using Microsoft.Data.SqlClient;

namespace SqlSimCity.SqlServer;

/// <summary>The production <see cref="ISqlConnectionOpener"/>: opens the connection over the network.</summary>
public sealed class DefaultSqlConnectionOpener : ISqlConnectionOpener
{
    public Task OpenAsync(SqlConnection connection, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(connection);
        return connection.OpenAsync(cancellationToken);
    }
}
