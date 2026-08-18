using SqlSimCity.Collection.Atlas;
using SqlSimCity.SqlServer;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.Api;

public static class AtlasConfiguration
{
    public static bool IsConnected(IConfiguration configuration) =>
        configuration.GetValue<string>("Atlas:Mode")?.Equals("Connected", StringComparison.OrdinalIgnoreCase) == true;

    public static AtlasCollectionOptions BuildCollectionOptions(IConfiguration configuration)
    {
        var section = configuration.GetSection("Atlas");
        var options = new AtlasCollectionOptions
        {
            TargetId = section.GetValue<string>("TargetId") ?? "primary",
            DisplayName = section.GetValue<string>("DisplayName") ?? "SQL Server",
            KnownDatabases = section.GetSection("KnownDatabases").Get<string[]>() ?? [],
            DatabaseConcurrency = section.GetValue<int?>("DatabaseConcurrency") ?? 4,
            QueryStoreWindow = TimeSpan.FromMinutes(section.GetValue<int?>("QueryStoreWindowMinutes") ?? 1_440),
            RefreshInterval = TimeSpan.FromSeconds(section.GetValue<int?>("RefreshIntervalSeconds") ?? 60),
            StaleAfter = TimeSpan.FromSeconds(section.GetValue<int?>("StaleAfterSeconds") ?? 180),
        };
        options.Validate();
        return options;
    }

    public static ConnectionProfile BuildProfile(IConfiguration configuration)
    {
        var section = configuration.GetRequiredSection("Atlas:Connection");
        var authentication = BuildAuthentication(section.GetRequiredSection("Authentication"));
        return new ConnectionProfile(
            new ConnectionProfileId(section.GetValue<string>("ProfileId") ?? "atlas-primary"),
            new ServerAddress(
                section.GetValue<string>("Host") ?? throw new InvalidOperationException("Atlas:Connection:Host is required."),
                section.GetValue<string>("Instance"),
                section.GetValue<int?>("Port")),
            section.GetValue<string>("InitialDatabase") ?? "master",
            new ConnectionTimeouts(
                section.GetValue<int?>("ConnectTimeoutSeconds") ?? 15,
                section.GetValue<int?>("CommandTimeoutSeconds") ?? 30),
            new PoolBounds(0, section.GetValue<int?>("MaxPoolSize") ?? 20),
            Enum.Parse<EncryptionPolicy>(section.GetValue<string>("Encryption") ?? "Mandatory", ignoreCase: true),
            authentication,
            section.GetValue<string>("HostNameInCertificate"),
            section.GetValue<bool?>("TrustServerCertificate") ?? false);
    }

    public static SecretFileProviderOptions BuildSecretOptions(IConfiguration configuration) => new()
    {
        SecretsDirectory = configuration.GetValue<string>("Atlas:SecretsDirectory")
            ?? SecretFileProviderOptions.DefaultSecretsDirectory,
    };

    private static AuthenticationStrategy BuildAuthentication(IConfiguration section)
    {
        var mode = section.GetValue<string>("Mode") ?? throw new InvalidOperationException("Atlas connection authentication mode is required.");
        return mode.ToUpperInvariant() switch
        {
            "SQLLOGIN" => new SqlLoginAuthenticationStrategy(
                section.GetValue<string>("Username") ?? throw new InvalidOperationException("SQL login username is required."),
                new SecretFileReference(section.GetValue<string>("PasswordSecret")
                    ?? throw new InvalidOperationException("SQL login password secret reference is required."))),
            "KERBEROS" => new KerberosAuthenticationStrategy(),
            "MANAGEDIDENTITY" => new ManagedIdentityAuthenticationStrategy(section.GetValue<string>("UserAssignedClientId")),
            "WORKLOADIDENTITY" => new WorkloadIdentityAuthenticationStrategy(
                Required(section, "TenantId"), Required(section, "ClientId"), section.GetValue<string>("FederatedTokenFilePath")),
            "SERVICEPRINCIPALSECRET" => new ServicePrincipalSecretAuthenticationStrategy(
                Required(section, "TenantId"), Required(section, "ClientId"),
                new SecretFileReference(Required(section, "ClientSecret"))),
            "SERVICEPRINCIPALCERTIFICATE" => new ServicePrincipalCertificateAuthenticationStrategy(
                Required(section, "TenantId"), Required(section, "ClientId"),
                new SecretFileReference(Required(section, "CertificateSecret")),
                section.GetValue<string>("CertificatePasswordSecret") is { } password
                    ? new SecretFileReference(password)
                    : (SecretFileReference?)null),
            _ => throw new InvalidOperationException("Atlas connection authentication mode is not supported."),
        };
    }

    private static string Required(IConfiguration configuration, string name) =>
        configuration.GetValue<string>(name) ?? throw new InvalidOperationException($"Atlas authentication {name} is required.");
}
