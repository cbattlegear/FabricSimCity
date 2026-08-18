using Microsoft.Extensions.Configuration;
using SqlSimCity.Collection.Catalog;
using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.SqlServer;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.Api;

/// <summary>
/// Wires the live-incident sampling seam into a host's DI container. <c>LiveIncidents:Mode</c>
/// defaults to <see cref="LiveIncidentsMode.Fixture"/> -- the existing no-credentials path is
/// completely unchanged when an operator configures nothing. Setting it to <c>Connected</c> opts
/// into a real <see cref="SqlConnectionFactory"/>-backed <see cref="LiveIncidentCollector"/>, but
/// only after <see cref="LiveIncidentsConnectionOptions"/> is fully validated here, synchronously,
/// during service registration -- before <c>WebApplication.Build()</c> even runs, let alone
/// <c>app.Run()</c> -- so a misconfigured Connected mode fails closed and never serves traffic
/// (requirement 1). Every validation failure is a <see cref="LiveIncidentsConfigurationException"/>
/// built only from section/key names, never a secret or resolved value.
/// </summary>
public static class LiveIncidentsServiceCollectionExtensions
{
    public static IServiceCollection AddLiveIncidents(
        this IServiceCollection services,
        IConfiguration configuration,
        ProbeCatalog probeCatalog,
        string sectionName = LiveIncidentsOptions.SectionName)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(probeCatalog);

        var options = new LiveIncidentsOptions();
        configuration.GetSection(sectionName).Bind(options);

        if (!Enum.TryParse<LiveIncidentsMode>(options.Mode, ignoreCase: true, out var mode))
        {
            throw new LiveIncidentsConfigurationException(
                $"{sectionName}:{nameof(LiveIncidentsOptions.Mode)} '{options.Mode}' must be 'Fixture' or 'Connected'.");
        }

        switch (mode)
        {
            case LiveIncidentsMode.Fixture:
                // Default, no-credentials live-incident path (requirement 7): the fixture
                // collector, never a real SQL Server connection, backs /api/v1/live and the
                // SignalR push until an operator opts a real ILiveIncidentCollector in.
                services.AddSingleton<ILiveIncidentCollector, FixtureLiveIncidentCollector>();
                break;

            case LiveIncidentsMode.Connected:
                RegisterConnected(services, options.Connection, probeCatalog, sectionName);
                break;

            default:
                throw new LiveIncidentsConfigurationException(
                    $"{sectionName}:{nameof(LiveIncidentsOptions.Mode)} '{options.Mode}' is not a recognized live-incidents mode.");
        }

        return services;
    }

    private static void RegisterConnected(
        IServiceCollection services,
        LiveIncidentsConnectionOptions connection,
        ProbeCatalog probeCatalog,
        string sectionName)
    {
        var connectionSection = $"{sectionName}:{nameof(LiveIncidentsOptions.Connection)}";

        // Building the profile, platform, and secret provider now -- not lazily inside a
        // service factory -- guarantees every validation exception below surfaces the moment
        // this method runs, which callers await before the host can start serving traffic.
        var platform = ParsePlatform(connection.Platform, connectionSection);
        var profile = BuildConnectionProfile(connection, connectionSection);
        var targetId = RequireNonBlank(connection.TargetId, connectionSection, nameof(LiveIncidentsConnectionOptions.TargetId));
        var displayName = RequireNonBlank(connection.DisplayName, connectionSection, nameof(LiveIncidentsConnectionOptions.DisplayName));

        var secretOptions = new SecretFileProviderOptions
        {
            SecretsDirectory = connection.Secrets.Directory,
            MaxSecretSizeBytes = connection.Secrets.MaxSecretSizeBytes,
        };

        services.AddSingleton<ISecretFileProvider>(new FileSecretFileProvider(secretOptions));
        services.AddSingleton<ISqlConnectionFactory>(sp =>
            new SqlConnectionFactory(sp.GetRequiredService<ISecretFileProvider>()));
        services.AddSingleton<ILiveIncidentProbeExecutor>(sp =>
            new SqlLiveIncidentProbeExecutor(sp.GetRequiredService<ISqlConnectionFactory>(), profile, probeCatalog));
        services.AddSingleton<ILiveIncidentCollector>(sp =>
            new LiveIncidentCollector(
                sp.GetRequiredService<ILiveIncidentProbeExecutor>(),
                targetId,
                displayName,
                configuredPlatform: platform));
    }

    private static EnginePlatform ParsePlatform(string? rawPlatform, string connectionSection)
    {
        if (string.IsNullOrWhiteSpace(rawPlatform))
        {
            throw new LiveIncidentsConfigurationException(
                $"{connectionSection}:{nameof(LiveIncidentsConnectionOptions.Platform)} must be configured when LiveIncidents:Mode is Connected " +
                "(requirement 3: platform must never be inferred from a master-scoped identity probe).");
        }

        // Unknown/Unsupported are valid contract values but must never be *configured*: an
        // operator opting into Connected mode always knows and states the real platform.
        if (!Enum.TryParse<EnginePlatform>(rawPlatform, ignoreCase: true, out var platform)
            || platform is EnginePlatform.Unknown or EnginePlatform.Unsupported)
        {
            throw new LiveIncidentsConfigurationException(
                $"{connectionSection}:{nameof(LiveIncidentsConnectionOptions.Platform)} '{rawPlatform}' must be one of: " +
                $"{EnginePlatform.SqlServerOnPremises}, {EnginePlatform.AzureSqlDatabase}, {EnginePlatform.AzureSqlManagedInstance}.");
        }

        return platform;
    }

    private static ConnectionProfile BuildConnectionProfile(LiveIncidentsConnectionOptions connection, string connectionSection)
    {
        try
        {
            var server = new ServerAddress(
                RequireNonBlank(connection.Server.Host, connectionSection, $"{nameof(LiveIncidentsConnectionOptions.Server)}:{nameof(LiveIncidentsServerOptions.Host)}"),
                connection.Server.InstanceName,
                connection.Server.Port);

            var database = RequireNonBlank(connection.Database, connectionSection, nameof(LiveIncidentsConnectionOptions.Database));

            var timeouts = new ConnectionTimeouts(connection.Timeouts.ConnectSeconds, connection.Timeouts.CommandSeconds);
            var pool = new PoolBounds(connection.Pool.MinPoolSize, connection.Pool.MaxPoolSize);

            if (!Enum.TryParse<EncryptionPolicy>(connection.Encryption, ignoreCase: true, out var encryption))
            {
                throw new LiveIncidentsConfigurationException(
                    $"{connectionSection}:{nameof(LiveIncidentsConnectionOptions.Encryption)} '{connection.Encryption}' must be 'Mandatory' or 'Strict'.");
            }

            var authentication = BuildAuthenticationStrategy(connection.Authentication, connectionSection);

            return new ConnectionProfile(
                new ConnectionProfileId(RequireNonBlank(connection.TargetId, connectionSection, nameof(LiveIncidentsConnectionOptions.TargetId))),
                server,
                database,
                timeouts,
                pool,
                encryption,
                authentication,
                connection.HostNameInCertificate,
                connection.TrustServerCertificate);
        }
        catch (ConnectionProfileValidationException ex)
        {
            // ConnectionProfileValidationException messages are already secret-free (field names
            // and shapes only); wrapping preserves that guarantee while identifying the section.
            throw new LiveIncidentsConfigurationException($"{connectionSection}: {ex.Message}", ex);
        }
    }

    private static AuthenticationStrategy BuildAuthenticationStrategy(LiveIncidentsAuthenticationOptions auth, string connectionSection)
    {
        var authSection = $"{connectionSection}:{nameof(LiveIncidentsConnectionOptions.Authentication)}";
        var mode = RequireNonBlank(auth.Mode, connectionSection, $"{nameof(LiveIncidentsConnectionOptions.Authentication)}:{nameof(LiveIncidentsAuthenticationOptions.Mode)}");

        return mode.ToLowerInvariant() switch
        {
            "sqllogin" => new SqlLoginAuthenticationStrategy(
                RequireNonBlank(auth.Username, authSection, nameof(LiveIncidentsAuthenticationOptions.Username)),
                RequireNonBlank(auth.PasswordSecretFile, authSection, nameof(LiveIncidentsAuthenticationOptions.PasswordSecretFile))),
            "managedidentity" => new ManagedIdentityAuthenticationStrategy(auth.UserAssignedClientId),
            "workloadidentity" => new WorkloadIdentityAuthenticationStrategy(
                RequireNonBlank(auth.TenantId, authSection, nameof(LiveIncidentsAuthenticationOptions.TenantId)),
                RequireNonBlank(auth.ClientId, authSection, nameof(LiveIncidentsAuthenticationOptions.ClientId)),
                auth.FederatedTokenFilePath),
            "serviceprincipalcertificate" => new ServicePrincipalCertificateAuthenticationStrategy(
                RequireNonBlank(auth.TenantId, authSection, nameof(LiveIncidentsAuthenticationOptions.TenantId)),
                RequireNonBlank(auth.ClientId, authSection, nameof(LiveIncidentsAuthenticationOptions.ClientId)),
                RequireNonBlank(auth.CertificateSecretFile, authSection, nameof(LiveIncidentsAuthenticationOptions.CertificateSecretFile)),
                string.IsNullOrWhiteSpace(auth.CertificatePasswordSecretFile)
                    ? (SecretFileReference?)null
                    : new SecretFileReference(auth.CertificatePasswordSecretFile)),
            "serviceprincipalsecret" => new ServicePrincipalSecretAuthenticationStrategy(
                RequireNonBlank(auth.TenantId, authSection, nameof(LiveIncidentsAuthenticationOptions.TenantId)),
                RequireNonBlank(auth.ClientId, authSection, nameof(LiveIncidentsAuthenticationOptions.ClientId)),
                RequireNonBlank(auth.ClientSecretFile, authSection, nameof(LiveIncidentsAuthenticationOptions.ClientSecretFile))),
            "kerberos" => new KerberosAuthenticationStrategy(),
            _ => throw new LiveIncidentsConfigurationException(
                $"{authSection}:{nameof(LiveIncidentsAuthenticationOptions.Mode)} '{auth.Mode}' must be one of: " +
                "SqlLogin, Kerberos, ManagedIdentity, WorkloadIdentity, ServicePrincipalCertificate, ServicePrincipalSecret."),
        };
    }

    private static string RequireNonBlank(string? value, string section, string key)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new LiveIncidentsConfigurationException($"{section}:{key} must be configured when LiveIncidents:Mode is Connected.");
        }

        return value;
    }
}
