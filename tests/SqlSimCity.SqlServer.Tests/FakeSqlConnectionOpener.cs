using Microsoft.Data.SqlClient;

namespace SqlSimCity.SqlServer.Tests;

/// <summary>
/// A fake <see cref="ISqlConnectionOpener"/> that never touches the network.
/// Configurable to succeed instantly or throw, and records whether it was
/// invoked at all -- the structural evidence that a failed strategy never
/// silently falls through to a "successful" open.
/// </summary>
internal sealed class FakeSqlConnectionOpener : ISqlConnectionOpener
{
    private readonly Exception? _failure;

    public FakeSqlConnectionOpener(Exception? failure = null)
    {
        _failure = failure;
    }

    public int OpenCallCount { get; private set; }

    public SqlConnection? LastConnectionSeen { get; private set; }

    public bool LastConnectionWasDisposed { get; private set; }

    public Task OpenAsync(SqlConnection connection, CancellationToken cancellationToken)
    {
        OpenCallCount++;
        LastConnectionSeen = connection;
        connection.Disposed += (_, _) => LastConnectionWasDisposed = true;
        cancellationToken.ThrowIfCancellationRequested();
        if (_failure is not null)
        {
            throw _failure;
        }

        return Task.CompletedTask;
    }
}
