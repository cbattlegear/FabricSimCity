using Microsoft.Data.SqlClient;

namespace SqlSimCity.SqlServer;

/// <summary>
/// An opened connection plus any profile-scoped warnings discovered while
/// building it (for example <see cref="ConnectionWarning.TrustServerCertificateEnabled"/>).
/// Disposing this result disposes the underlying connection.
/// </summary>
public sealed class SqlConnectionOpenResult : IDisposable, IAsyncDisposable
{
    public SqlConnectionOpenResult(SqlConnection connection, IReadOnlyList<ConnectionWarning> warnings)
    {
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(warnings);
        Connection = connection;
        Warnings = warnings;
    }

    public SqlConnection Connection { get; }

    public IReadOnlyList<ConnectionWarning> Warnings { get; }

    public void Dispose() => Connection.Dispose();

    public ValueTask DisposeAsync() => Connection.DisposeAsync();
}
