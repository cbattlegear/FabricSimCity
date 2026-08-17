using SqlSimCity.SqlServer.Auth;

namespace SqlSimCity.SqlServer;

/// <summary>
/// An immutable, fully validated description of one SQL Server target and how
/// to authenticate to it. Every field is checked at construction (see
/// <see cref="ConnectionValidation"/> and each value type's own constructor),
/// so a caller can never hold a <see cref="ConnectionProfile"/> whose fields
/// have not already passed validation. The application name is always
/// <see cref="ApplicationName"/>; there is no way to override it per profile.
/// </summary>
public sealed class ConnectionProfile
{
    /// <summary>The fixed `Application Name` every connection built from this library reports.</summary>
    public const string ApplicationName = "SQLSimCity";

    private const int MaxDatabaseNameLength = 128;
    private const int MaxHostNameInCertificateLength = 255;

    public ConnectionProfileId Id { get; }

    public ServerAddress Server { get; }

    public string InitialDatabase { get; }

    public ConnectionTimeouts Timeouts { get; }

    public PoolBounds Pool { get; }

    public EncryptionPolicy Encryption { get; }

    /// <summary>Overrides the host name checked against the server's TLS certificate, when it differs from <see cref="ServerAddress.Host"/>.</summary>
    public string? HostNameInCertificate { get; }

    /// <summary>
    /// This profile's explicit, per-profile opt-in to skip TLS certificate
    /// validation. Never inherited or defaulted from any other profile or
    /// global setting; see <see cref="ConnectionWarning.TrustServerCertificateEnabled"/>.
    /// </summary>
    public bool TrustServerCertificate { get; }

    public AuthenticationStrategy Authentication { get; }

    public ConnectionProfile(
        ConnectionProfileId id,
        ServerAddress server,
        string initialDatabase,
        ConnectionTimeouts timeouts,
        PoolBounds pool,
        EncryptionPolicy encryption,
        AuthenticationStrategy authentication,
        string? hostNameInCertificate = null,
        bool trustServerCertificate = false)
    {
        ArgumentNullException.ThrowIfNull(server);
        ArgumentNullException.ThrowIfNull(timeouts);
        ArgumentNullException.ThrowIfNull(pool);
        ArgumentNullException.ThrowIfNull(authentication);
        ArgumentException.ThrowIfNullOrWhiteSpace(initialDatabase);

        ConnectionValidation.EnsureNoControlCharacters(initialDatabase, nameof(initialDatabase));
        ConnectionValidation.EnsureNoConnectionStringFragment(initialDatabase, nameof(initialDatabase));
        ConnectionValidation.EnsureLength(initialDatabase, nameof(initialDatabase), 1, MaxDatabaseNameLength);

        if (hostNameInCertificate is not null)
        {
            ConnectionValidation.EnsureNoControlCharacters(hostNameInCertificate, nameof(hostNameInCertificate));
            ConnectionValidation.EnsureNoConnectionStringFragment(hostNameInCertificate, nameof(hostNameInCertificate));
            ConnectionValidation.EnsureLength(
                hostNameInCertificate, nameof(hostNameInCertificate), 1, MaxHostNameInCertificateLength);
        }

        Id = id;
        Server = server;
        InitialDatabase = initialDatabase;
        Timeouts = timeouts;
        Pool = pool;
        Encryption = encryption;
        HostNameInCertificate = hostNameInCertificate;
        TrustServerCertificate = trustServerCertificate;
        Authentication = authentication;
    }
}
