namespace SqlSimCity.SqlServer.Auth;

/// <summary>
/// Linux Kerberos service identity authentication (Integrated Security/SSPI)
/// using the container's own Kerberos identity. Deployment requires: a keytab
/// mounted as a Docker/Compose secret; <c>KRB5_CONFIG</c> pointing at a
/// <c>krb5.conf</c> naming the realm and KDC; <c>KRB5_KTNAME</c> pointing at
/// that keytab; a <c>MSSQLSvc/&lt;target FQDN&gt;:&lt;port&gt;</c> service
/// principal name registered for the SQL Server target; and working
/// forward/reverse DNS plus clock sync with the KDC (Kerberos rejects clock
/// skew beyond a small tolerance). See SECURITY.md. There is no
/// interactive/browser user delegation here, and nothing in this library falls
/// back from Kerberos to SQL login.
/// </summary>
public sealed class KerberosAuthenticationStrategy : AuthenticationStrategy
{
    public KerberosAuthenticationStrategy()
    {
    }
}
