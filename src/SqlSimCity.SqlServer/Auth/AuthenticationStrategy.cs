namespace SqlSimCity.SqlServer.Auth;

/// <summary>
/// The closed set of ways <see cref="SqlConnectionFactory"/> can authenticate a
/// connection. Every concrete case is a sealed type in this assembly (see
/// <see cref="SqlLoginAuthenticationStrategy"/>, <see cref="KerberosAuthenticationStrategy"/>,
/// and the <see cref="EntraAuthenticationStrategy"/> family); there is no
/// fallback between strategies, and no strategy carries a raw secret value --
/// only a reference the configured secret provider resolves at connection
/// time.
/// </summary>
public abstract class AuthenticationStrategy
{
    private protected AuthenticationStrategy()
    {
    }
}
