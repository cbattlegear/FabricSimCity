namespace SqlSimCity.Api;

/// <summary>
/// Root binding target for the <c>LiveIncidents</c> configuration section.
/// <see cref="Mode"/> defaults to <see cref="LiveIncidentsMode.Fixture"/> so an
/// operator who configures nothing keeps today's no-credentials behavior;
/// <see cref="Connection"/> is required, and validated, only when
/// <see cref="Mode"/> is <see cref="LiveIncidentsMode.Connected"/>.
/// </summary>
public sealed class LiveIncidentsOptions
{
    public const string SectionName = "LiveIncidents";

    /// <summary>Raw configured mode string; parsed explicitly in <c>LiveIncidentsServiceCollectionExtensions</c> so an unrecognized value is always a curated <see cref="LiveIncidentsConfigurationException"/>, never a binder-internal exception.</summary>
    public string Mode { get; set; } = nameof(LiveIncidentsMode.Fixture);

    public LiveIncidentsConnectionOptions Connection { get; set; } = new();
}

/// <summary>
/// The SQL Server (or Azure SQL) target and authentication a <c>Connected</c>-mode
/// <c>ILiveIncidentCollector</c> samples. Every field here is either a plain identifier/hostname
/// or a reference to a secret file (never a resolved secret value), so this whole options graph
/// is safe to bind, hold, and even log by field name.
/// </summary>
public sealed class LiveIncidentsConnectionOptions
{
    /// <summary>
    /// An optional ordinary ADO.NET connection string that replaces every field
    /// below except <see cref="TargetId"/>, <see cref="DisplayName"/>, and
    /// <see cref="Platform"/> (which all fall back to defaults). See
    /// <c>SqlSimCityConnectionString</c> for the shared keys it also honors.
    /// </summary>
    public string? ConnectionString { get; set; }

    /// <summary>A short, stable label for this target, used as the sampler's target id.</summary>
    public string? TargetId { get; set; }

    /// <summary>A human-readable label for this target, shown in the UI.</summary>
    public string? DisplayName { get; set; }

    /// <summary>
    /// The negotiated/configured platform this target runs on. Required in <c>Connected</c> mode
    /// (requirement 3): platform must never be inferred solely from a master-scoped identity
    /// probe that can fail for an Azure contained user, so an operator states it up front.
    /// </summary>
    public string? Platform { get; set; }

    public LiveIncidentsServerOptions Server { get; set; } = new();

    /// <summary>The initial/target database this collector samples (never <c>tempdb</c> itself; see <see cref="Platform"/> for tempdb scoping).</summary>
    public string? Database { get; set; }

    /// <summary><c>Mandatory</c> (default) or <c>Strict</c>; see <c>EncryptionPolicy</c>.</summary>
    public string Encryption { get; set; } = "Mandatory";

    public bool TrustServerCertificate { get; set; }

    public string? HostNameInCertificate { get; set; }

    public LiveIncidentsTimeoutOptions Timeouts { get; set; } = new();

    public LiveIncidentsPoolOptions Pool { get; set; } = new();

    public LiveIncidentsAuthenticationOptions Authentication { get; set; } = new();

    public LiveIncidentsSecretsOptions Secrets { get; set; } = new();
}

public sealed class LiveIncidentsServerOptions
{
    public string? Host { get; set; }

    public string? InstanceName { get; set; }

    public int? Port { get; set; }
}

public sealed class LiveIncidentsTimeoutOptions
{
    public int ConnectSeconds { get; set; } = 15;

    public int CommandSeconds { get; set; } = 10;
}

public sealed class LiveIncidentsPoolOptions
{
    public int MinPoolSize { get; set; }

    public int MaxPoolSize { get; set; } = 5;
}

/// <summary>
/// Selects one <c>AuthenticationStrategy</c>. Only <see cref="Mode"/>'s matching fields are read;
/// fields for other modes are ignored. <see cref="PasswordSecretFile"/> is a file name resolved
/// under <see cref="LiveIncidentsSecretsOptions.Directory"/> -- never a password value.
/// </summary>
public sealed class LiveIncidentsAuthenticationOptions
{
    /// <summary><c>SqlLogin</c>, <c>Kerberos</c>, or one explicit Microsoft Entra strategy.</summary>
    public string? Mode { get; set; }

    /// <summary>SQL login username (<c>SqlLogin</c> mode only).</summary>
    public string? Username { get; set; }

    /// <summary>Secret file name holding the SQL login password (<c>SqlLogin</c> mode only).</summary>
    public string? PasswordSecretFile { get; set; }

    /// <summary>Optional user-assigned managed identity client id (<c>ManagedIdentity</c> mode only; system-assigned when omitted).</summary>
    public string? UserAssignedClientId { get; set; }

    /// <summary>Entra tenant id (workload identity or service principal modes).</summary>
    public string? TenantId { get; set; }

    /// <summary>Entra application (client) id (workload identity or service principal modes).</summary>
    public string? ClientId { get; set; }

    /// <summary>Optional override of the projected federated token file path (<c>WorkloadIdentity</c> mode only).</summary>
    public string? FederatedTokenFilePath { get; set; }

    /// <summary>Secret file containing a PKCS#12/PFX client certificate.</summary>
    public string? CertificateSecretFile { get; set; }

    /// <summary>Optional secret file containing the PFX password.</summary>
    public string? CertificatePasswordSecretFile { get; set; }

    /// <summary>Secret file containing a service-principal client secret.</summary>
    public string? ClientSecretFile { get; set; }
}

public sealed class LiveIncidentsSecretsOptions
{
    public string Directory { get; set; } = "/run/secrets";

    public int MaxSecretSizeBytes { get; set; } = 16 * 1_024;
}
