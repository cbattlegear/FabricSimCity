using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer.Auth;

/// <summary>
/// SQL Server login/password authentication. The password is never carried as
/// a plain string on this type -- only a <see cref="SecretFileReference"/> that
/// <see cref="SqlConnectionFactory"/> resolves once per connection attempt and
/// hands to <c>SqlCredential</c>, never to the connection string, so it cannot
/// leak through a log, diagnostic, or exception.
/// </summary>
public sealed class SqlLoginAuthenticationStrategy : AuthenticationStrategy
{
    private const int MaxUsernameLength = 128;

    public string Username { get; }

    public SecretFileReference PasswordSecretReference { get; }

    public SqlLoginAuthenticationStrategy(string username, SecretFileReference passwordSecretReference)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(username);
        ConnectionValidation.EnsureNoControlCharacters(username, nameof(username));
        ConnectionValidation.EnsureNoConnectionStringFragment(username, nameof(username));
        ConnectionValidation.EnsureLength(username, nameof(username), 1, MaxUsernameLength);

        Username = username;
        PasswordSecretReference = passwordSecretReference;
    }
}
