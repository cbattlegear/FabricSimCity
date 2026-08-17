namespace SqlSimCity.SqlServer;

/// <summary>
/// A non-fatal fact worth surfacing to an operator about a resolved
/// connection. Warnings are always scoped to the single profile/connection
/// they were produced for; nothing here is global, and no warning applies to
/// any profile other than the one that produced it.
/// </summary>
public enum ConnectionWarning
{
    /// <summary>
    /// The profile opted into <c>TrustServerCertificate</c>, so the server's
    /// TLS certificate is not validated against a trusted chain or host name
    /// for this connection.
    /// </summary>
    TrustServerCertificateEnabled,
}
