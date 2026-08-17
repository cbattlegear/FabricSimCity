using Microsoft.Data.SqlClient;

namespace SqlSimCity.SqlServer;

/// <summary>
/// Performs the network <c>Open</c> call for an already-constructed
/// <see cref="SqlConnection"/>. This indirection is <see cref="SqlConnectionFactory"/>'s
/// test seam: unit tests supply a fake that fails without a live network,
/// against a real <see cref="SqlConnection"/> instance, to verify cancellation
/// and disposal-on-failure behavior.
/// </summary>
public interface ISqlConnectionOpener
{
    Task OpenAsync(SqlConnection connection, CancellationToken cancellationToken);
}
