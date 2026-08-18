using SqlSimCity.SqlServer.Auth;

namespace SqlSimCity.SqlServer;

/// <summary>
/// A connection profile's secret-free shape for authorized UI and protected
/// storage. It contains operationally sensitive target and identity metadata,
/// so callers must not log or expose it indiscriminately. Authentication is
/// represented only by its kind plus non-secret identifiers; no password,
/// certificate, client secret, federated token, or bearer token reaches it.
/// </summary>
public sealed record SafeConnectionSettings
{
    public required string ProfileId { get; init; }

    public required string DataSource { get; init; }

    public required string InitialDatabase { get; init; }

    public required string Encryption { get; init; }

    public required bool TrustServerCertificate { get; init; }

    public string? HostNameInCertificate { get; init; }

    public required int ConnectTimeoutSeconds { get; init; }

    public required int CommandTimeoutSeconds { get; init; }

    public required int MinPoolSize { get; init; }

    public required int MaxPoolSize { get; init; }

    public required string ApplicationIntent { get; init; }

    public required string ApplicationName { get; init; }

    public required string AuthenticationKind { get; init; }

    public string? SqlLoginUsername { get; init; }

    public string? EntraTenantId { get; init; }

    public string? EntraClientId { get; init; }

    public bool EntraUsesUserAssignedIdentity { get; init; }

    public required IReadOnlyList<ConnectionWarning> Warnings { get; init; }

    /// <summary>
    /// Keeps incidental exception and debug logging from exposing target or
    /// identity metadata. Authorized callers can read individual properties.
    /// </summary>
    public override string ToString() => $"{nameof(SafeConnectionSettings)} {{ Redacted = true }}";

    public static SafeConnectionSettings From(ConnectionProfile profile)
    {
        ArgumentNullException.ThrowIfNull(profile);

        var warnings = profile.TrustServerCertificate
            ? new[] { ConnectionWarning.TrustServerCertificateEnabled }
            : Array.Empty<ConnectionWarning>();

        var settings = new SafeConnectionSettings
        {
            ProfileId = profile.Id.Value,
            DataSource = profile.Server.ToDataSource(),
            InitialDatabase = profile.InitialDatabase,
            Encryption = profile.Encryption.ToString(),
            TrustServerCertificate = profile.TrustServerCertificate,
            HostNameInCertificate = profile.HostNameInCertificate,
            ConnectTimeoutSeconds = profile.Timeouts.ConnectTimeoutSeconds,
            CommandTimeoutSeconds = profile.Timeouts.CommandTimeoutSeconds,
            MinPoolSize = profile.Pool.MinPoolSize,
            MaxPoolSize = profile.Pool.MaxPoolSize,
            ApplicationIntent = "ReadOnly",
            ApplicationName = ConnectionProfile.ApplicationName,
            AuthenticationKind = profile.Authentication.GetType().Name,
            Warnings = warnings,
        };

        return profile.Authentication switch
        {
            SqlLoginAuthenticationStrategy sqlLogin => settings with { SqlLoginUsername = sqlLogin.Username },
            WorkloadIdentityAuthenticationStrategy workloadIdentity => settings with
            {
                EntraTenantId = workloadIdentity.TenantId.ToString(),
                EntraClientId = workloadIdentity.ClientId.ToString(),
            },
            ServicePrincipalCertificateAuthenticationStrategy certificate => settings with
            {
                EntraTenantId = certificate.TenantId.ToString(),
                EntraClientId = certificate.ClientId.ToString(),
            },
            ServicePrincipalSecretAuthenticationStrategy secret => settings with
            {
                EntraTenantId = secret.TenantId.ToString(),
                EntraClientId = secret.ClientId.ToString(),
            },
            ManagedIdentityAuthenticationStrategy managedIdentity => settings with
            {
                EntraUsesUserAssignedIdentity = managedIdentity.UserAssignedClientId is not null,
                EntraClientId = managedIdentity.UserAssignedClientId?.ToString(),
            },
            _ => settings,
        };
    }
}
