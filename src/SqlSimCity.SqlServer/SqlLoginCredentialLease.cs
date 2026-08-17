using System.Security;
using Microsoft.Data.SqlClient;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer;

internal interface ISqlLoginCredentialLeaseFactory
{
    Task<SqlLoginCredentialLease> CreateAsync(
        SqlLoginAuthenticationStrategy authentication,
        CancellationToken cancellationToken);
}

/// <summary>
/// A reference-counted, retireable credential lease shared by
/// <see cref="SqlLoginCredentialLease"/> and <c>EntraCredentialLease</c> so
/// <see cref="SqlConnectionFactory"/> can rent, release, and retire either
/// kind through one generic caching code path
/// (<see cref="SqlConnectionFactory"/>'s private <c>RentLeaseAsync</c>).
/// </summary>
internal interface IPooledCredentialLease
{
    bool TryRent();

    void Release();

    void BeginRetirement();

    ValueTask RetireAsync(
        ISqlConnectionPoolController poolController,
        string connectionString,
        bool clearPool,
        CancellationToken cancellationToken);
}

internal interface ICredentialCacheKey
{
    string ConnectionString { get; }
}

internal interface ISqlConnectionPoolController
{
    void ClearPool(SqlConnection connection);
}

internal sealed class DefaultSqlConnectionPoolController : ISqlConnectionPoolController
{
    public void ClearPool(SqlConnection connection)
    {
        ArgumentNullException.ThrowIfNull(connection);
        SqlConnection.ClearPool(connection);
    }
}

internal sealed class SecretFileSqlLoginCredentialLeaseFactory : ISqlLoginCredentialLeaseFactory
{
    private readonly ISecretFileProvider _secretProvider;

    public SecretFileSqlLoginCredentialLeaseFactory(ISecretFileProvider secretProvider)
    {
        ArgumentNullException.ThrowIfNull(secretProvider);
        _secretProvider = secretProvider;
    }

    public async Task<SqlLoginCredentialLease> CreateAsync(
        SqlLoginAuthenticationStrategy authentication,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(authentication);

        SecureString? password = null;
        try
        {
            using var passwordBytes = await _secretProvider
                .ReadAsync(authentication.PasswordSecretReference, cancellationToken)
                .ConfigureAwait(false);
            password = passwordBytes.ToUtf8SecureString();
            return new SqlLoginCredentialLease(authentication.Username, password);
        }
        catch
        {
            password?.Dispose();
            throw;
        }
    }
}

/// <summary>
/// Owns one SQL-login credential and its read-only password for as long as its
/// SqlClient pool can open physical connections. Retirement first rejects new
/// rents, waits for active results to drain, then clears the pool before
/// zeroing the password. A pool-clear failure keeps the password valid,
/// non-rentable, and reachable for a later cleanup retry.
/// </summary>
internal abstract class PooledCredentialLease : IPooledCredentialLease
{
    private readonly object _gate = new();
    private int _activeConnections;
    private TaskCompletionSource? _drained;
    private TaskCompletionSource? _cleanupChanged;
    private bool _cleanupInProgress;
    private bool _retirementStarted;
    private bool _disposed;
    private int _disposeCount;

    internal bool IsDisposed
    {
        get
        {
            lock (_gate)
            {
                return _disposed;
            }
        }
    }

    internal int DisposeCount
    {
        get
        {
            lock (_gate)
            {
                return _disposeCount;
            }
        }
    }

    public bool TryRent()
    {
        lock (_gate)
        {
            if (_retirementStarted || _disposed)
            {
                return false;
            }

            _activeConnections++;
            return true;
        }
    }

    public void Release()
    {
        TaskCompletionSource? drained = null;
        lock (_gate)
        {
            if (_activeConnections == 0)
            {
                return;
            }

            _activeConnections--;
            if (_activeConnections == 0)
            {
                drained = _drained;
            }
        }

        drained?.TrySetResult();
    }

    public void BeginRetirement()
    {
        lock (_gate)
        {
            if (_retirementStarted)
            {
                return;
            }

            _retirementStarted = true;
            if (_activeConnections > 0)
            {
                _drained = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            }
        }
    }

    public async ValueTask RetireAsync(
        ISqlConnectionPoolController poolController,
        string connectionString,
        bool clearPool,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(poolController);
        ArgumentNullException.ThrowIfNull(connectionString);
        BeginRetirement();

        Task? drainTask;
        lock (_gate)
        {
            drainTask = _drained?.Task;
        }

        if (drainTask is not null)
        {
            await drainTask.WaitAsync(cancellationToken).ConfigureAwait(false);
        }

        while (true)
        {
            Task? concurrentCleanup = null;
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }

                if (_cleanupInProgress)
                {
                    concurrentCleanup = _cleanupChanged!.Task;
                }
                else
                {
                    _cleanupInProgress = true;
                    _cleanupChanged = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                }
            }

            if (concurrentCleanup is not null)
            {
                await concurrentCleanup.WaitAsync(cancellationToken).ConfigureAwait(false);
                continue;
            }

            try
            {
                if (clearPool)
                {
                    ClearPool(poolController, connectionString);
                }

                lock (_gate)
                {
                    if (!_disposed)
                    {
                        DisposeMaterial();
                        _disposeCount++;
                        _disposed = true;
                    }
                }
                return;
            }
            finally
            {
                TaskCompletionSource cleanupChanged;
                lock (_gate)
                {
                    _cleanupInProgress = false;
                    cleanupChanged = _cleanupChanged!;
                    _cleanupChanged = null;
                }

                cleanupChanged.TrySetResult();
            }
        }
    }

    protected abstract void ClearPool(ISqlConnectionPoolController poolController, string connectionString);

    protected abstract void DisposeMaterial();
}

internal sealed class SqlLoginCredentialLease : PooledCredentialLease
{
    private SecureString? _password;

    public SqlLoginCredentialLease(string username, SecureString password)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(username);
        ArgumentNullException.ThrowIfNull(password);

        _password = password;
        Credential = new SqlCredential(username, password);
    }

    public SqlCredential Credential { get; }

    protected override void ClearPool(ISqlConnectionPoolController poolController, string connectionString)
    {
        using var connection = new SqlConnection(connectionString, Credential);
        poolController.ClearPool(connection);
    }

    protected override void DisposeMaterial()
    {
        _password?.Dispose();
        _password = null;
    }
}

internal readonly record struct SqlLoginCredentialCacheKey(
    string ProfileId,
    string ConnectionString,
    string Username,
    string PasswordSecretFileName) : ICredentialCacheKey
{
    public static SqlLoginCredentialCacheKey From(
        ConnectionProfile profile,
        SqlConnectionStringBuilder builder,
        SqlLoginAuthenticationStrategy authentication) =>
        new(
            profile.Id.Value,
            builder.ConnectionString,
            authentication.Username,
            authentication.PasswordSecretReference.FileName);
}
