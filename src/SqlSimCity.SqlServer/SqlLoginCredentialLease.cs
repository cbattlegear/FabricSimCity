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
    void Rent();

    void Release();
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
/// SqlClient pool can open physical connections. Retirement clears the pool
/// before zeroing the password, and defers zeroing while returned results use
/// it. If the pool clear itself fails, the password is deliberately kept
/// valid (fail-closed) and the failure propagates to the caller instead of
/// being swallowed -- see <see cref="Retire"/>.
/// </summary>
internal sealed class SqlLoginCredentialLease : IDisposable, IPooledCredentialLease
{
    private readonly object _gate = new();
    private SecureString? _password;
    private int _activeConnections;
    private bool _retired;
    private bool _disposed;

    public SqlLoginCredentialLease(string username, SecureString password)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(username);
        ArgumentNullException.ThrowIfNull(password);

        _password = password;
        Credential = new SqlCredential(username, password);
    }

    public SqlCredential Credential { get; }

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

    public void Rent()
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            _activeConnections++;
        }
    }

    public void Release()
    {
        lock (_gate)
        {
            if (_activeConnections == 0)
            {
                throw new InvalidOperationException("SQL credential lease released more times than it was rented.");
            }

            _activeConnections--;
            DisposeIfRetiredAndUnused();
        }
    }

    /// <summary>
    /// Clears this lease's SqlClient pool, then zeros the password once no
    /// returned result is still using it. If <paramref name="poolController"/>
    /// throws, this lease is left exactly as it was -- not marked retired, and
    /// the password not zeroed -- so a lingering pool that could not be
    /// cleared is never paired with a credential someone might try to reuse
    /// after it was disposed. The exception propagates to the caller, which
    /// must not swallow it: see <see cref="SqlConnectionFactory.DisposeAsync"/>
    /// and <see cref="SqlConnectionFactory.InvalidateSqlLoginProfileAsync"/>.
    /// </summary>
    public void Retire(ISqlConnectionPoolController poolController, string connectionString)
    {
        ArgumentNullException.ThrowIfNull(poolController);
        ArgumentNullException.ThrowIfNull(connectionString);

        lock (_gate)
        {
            if (_retired)
            {
                return;
            }
        }

        using (var connection = new SqlConnection(connectionString, Credential))
        {
            poolController.ClearPool(connection);
        }

        lock (_gate)
        {
            _retired = true;
            DisposeIfRetiredAndUnused();
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _retired = true;
            DisposeIfRetiredAndUnused();
        }
    }

    private void DisposeIfRetiredAndUnused()
    {
        if (!_retired || _activeConnections != 0 || _disposed)
        {
            return;
        }

        _password?.Dispose();
        _password = null;
        _disposed = true;
    }
}

internal readonly record struct SqlLoginCredentialCacheKey(
    string ProfileId,
    string ConnectionString,
    string Username,
    string PasswordSecretFileName)
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
