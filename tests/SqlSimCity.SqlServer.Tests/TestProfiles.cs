using SqlSimCity.SqlServer.Auth;

namespace SqlSimCity.SqlServer.Tests;

/// <summary>Shared, minimal valid construction helpers so each test only overrides what it is actually testing.</summary>
internal static class TestProfiles
{
    public static ServerAddress ValidServer() => new("sql01.internal.example.com");

    public static ConnectionTimeouts ValidTimeouts() => new(connectTimeoutSeconds: 15, commandTimeoutSeconds: 30);

    public static PoolBounds ValidPool() => new(minPoolSize: 1, maxPoolSize: 10);

    public static ConnectionProfile Build(
        AuthenticationStrategy? authentication = null,
        ServerAddress? server = null,
        string initialDatabase = "sqlsimcity",
        EncryptionPolicy encryption = EncryptionPolicy.Mandatory,
        string? hostNameInCertificate = null,
        bool trustServerCertificate = false,
        ConnectionProfileId? id = null) =>
        new(
            id ?? new ConnectionProfileId("test-profile"),
            server ?? ValidServer(),
            initialDatabase,
            ValidTimeouts(),
            ValidPool(),
            encryption,
            authentication ?? new KerberosAuthenticationStrategy(),
            hostNameInCertificate,
            trustServerCertificate);
}
