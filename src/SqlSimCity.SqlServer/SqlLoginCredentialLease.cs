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
/// before zeroing the password, and defers zeroing while returned results use it.
/// </summary>
internal sealed class SqlLoginCredentialLease : IDisposable
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

            _retired = true;
        }

        using (var connection = new SqlConnection(connectionString, Credential))
        {
            poolController.ClearPool(connection);
        }

        lock (_gate)
        {
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
