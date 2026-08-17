using Microsoft.Data.SqlClient;

namespace SqlSimCity.SqlServer;

/// <summary>
/// An opened connection plus any profile-scoped warnings discovered while
/// building it (for example <see cref="ConnectionWarning.TrustServerCertificateEnabled"/>).
/// Disposing this result disposes the underlying connection.
/// </summary>
public sealed class SqlConnectionOpenResult : IDisposable, IAsyncDisposable
{
    private Action? _releaseCredentialLease;

    public SqlConnectionOpenResult(
        SqlConnection connection,
        IReadOnlyList<ConnectionWarning> warnings,
        Action? releaseCredentialLease = null)
    {
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(warnings);
        Connection = connection;
        Warnings = warnings;
        _releaseCredentialLease = releaseCredentialLease;
        if (releaseCredentialLease is not null)
        {
            Connection.Disposed += OnConnectionDisposed;
        }
    }

    public SqlConnection Connection { get; }

    public IReadOnlyList<ConnectionWarning> Warnings { get; }

    public void Dispose()
    {
        try
        {
            Connection.Dispose();
        }
        finally
        {
            ReleaseCredentialLease();
        }
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            await Connection.DisposeAsync().ConfigureAwait(false);
        }
        finally
        {
            ReleaseCredentialLease();
        }
    }

    private void ReleaseCredentialLease() =>
        Interlocked.Exchange(ref _releaseCredentialLease, null)?.Invoke();

    private void OnConnectionDisposed(object? sender, EventArgs eventArgs) => ReleaseCredentialLease();
}
