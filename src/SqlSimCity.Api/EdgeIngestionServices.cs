using SqlSimCity.Edge.Ingestion;
using SqlSimCity.Edge.Signing;

namespace SqlSimCity.Api;

/// <summary>
/// Opt-in configuration for central edge ingestion. Disabled by default: unless
/// <see cref="Enabled"/> is explicitly set, no ingestion endpoint is mapped and the app stays
/// strictly GET-only. When enabled, the connector allowlist and signing secrets are loaded from a
/// catalog plus a secrets directory (never inline), replay nonces are journaled to a durable path,
/// and every bound below is enforced.
/// </summary>
public sealed class EdgeIngestionOptions
{
    public const string SectionName = "EdgeIngestion";

    public bool Enabled { get; init; }
    public string? SecretCatalogFile { get; init; }
    public string? SecretsDirectory { get; init; }
    public string? NonceJournalPath { get; init; }
    public int ClockSkewSeconds { get; init; } = 300;
    public long MaxBatchBytes { get; init; } = 4 * 1024 * 1024;
    public int RateLimitPermitPerMinute { get; init; } = 120;

    public void Validate()
    {
        if (!Enabled)
            return;
        if (string.IsNullOrWhiteSpace(SecretCatalogFile))
            throw new InvalidOperationException($"{SectionName}:SecretCatalogFile is required when edge ingestion is enabled.");
        if (string.IsNullOrWhiteSpace(SecretsDirectory))
            throw new InvalidOperationException($"{SectionName}:SecretsDirectory is required when edge ingestion is enabled.");
        if (string.IsNullOrWhiteSpace(NonceJournalPath))
            throw new InvalidOperationException($"{SectionName}:NonceJournalPath is required when edge ingestion is enabled.");
        if (ClockSkewSeconds is < 5 or > 3600)
            throw new InvalidOperationException($"{SectionName}:ClockSkewSeconds must be between 5 and 3600.");
        if (MaxBatchBytes is < 4096 or > 64L * 1024 * 1024)
            throw new InvalidOperationException($"{SectionName}:MaxBatchBytes must be between 4 KiB and 64 MiB.");
        if (RateLimitPermitPerMinute is < 1 or > 100_000)
            throw new InvalidOperationException($"{SectionName}:RateLimitPermitPerMinute must be between 1 and 100000.");
    }
}

/// <summary>Holds the wired-up ingestion collaborators so endpoints resolve them from DI.</summary>
public sealed class EdgeIngestionContext(
    EdgeIngestionOptions options,
    HmacRequestVerifier verifier,
    EdgeObservationStore store,
    IngestionLimits limits)
{
    public EdgeIngestionOptions Options { get; } = options;
    public HmacRequestVerifier Verifier { get; } = verifier;
    public EdgeObservationStore Store { get; } = store;
    public IngestionLimits Limits { get; } = limits;
}

public static class EdgeIngestionServiceCollectionExtensions
{
    /// <summary>
    /// Registers edge ingestion only when explicitly enabled. Loads the connector allowlist/secrets
    /// and the durable replay-nonce journal, failing closed if any required file is missing or invalid.
    /// </summary>
    public static IServiceCollection AddEdgeIngestion(this IServiceCollection services, IConfiguration configuration)
    {
        var section = configuration.GetSection(EdgeIngestionOptions.SectionName);
        var options = new EdgeIngestionOptions
        {
            Enabled = section.GetValue<bool>(nameof(EdgeIngestionOptions.Enabled)),
            SecretCatalogFile = section.GetValue<string?>(nameof(EdgeIngestionOptions.SecretCatalogFile)),
            SecretsDirectory = section.GetValue<string?>(nameof(EdgeIngestionOptions.SecretsDirectory)),
            NonceJournalPath = section.GetValue<string?>(nameof(EdgeIngestionOptions.NonceJournalPath)),
            ClockSkewSeconds = section.GetValue<int?>(nameof(EdgeIngestionOptions.ClockSkewSeconds)) ?? 300,
            MaxBatchBytes = section.GetValue<long?>(nameof(EdgeIngestionOptions.MaxBatchBytes)) ?? 4 * 1024 * 1024,
            RateLimitPermitPerMinute = section.GetValue<int?>(nameof(EdgeIngestionOptions.RateLimitPermitPerMinute)) ?? 120,
        };
        options.Validate();
        services.AddSingleton(options);

        if (!options.Enabled)
            return services;

        var secrets = ConnectorSecretCatalog.Load(options.SecretCatalogFile!, options.SecretsDirectory!);
        var nonces = new FileNonceReplayStore(options.NonceJournalPath!);
        services.AddSingleton<IConnectorSecretResolver>(secrets);
        services.AddSingleton<INonceReplayStore>(nonces);
        services.AddSingleton(new SignatureVerificationOptions(TimeSpan.FromSeconds(options.ClockSkewSeconds)));
        services.AddSingleton<EdgeObservationStore>();
        services.AddSingleton(new IngestionLimits());
        services.AddSingleton(sp => new HmacRequestVerifier(
            sp.GetRequiredService<IConnectorSecretResolver>(),
            sp.GetRequiredService<INonceReplayStore>(),
            sp.GetRequiredService<SignatureVerificationOptions>(),
            sp.GetService<TimeProvider>() ?? TimeProvider.System));
        services.AddSingleton(sp => new EdgeIngestionContext(
            sp.GetRequiredService<EdgeIngestionOptions>(),
            sp.GetRequiredService<HmacRequestVerifier>(),
            sp.GetRequiredService<EdgeObservationStore>(),
            sp.GetRequiredService<IngestionLimits>()));
        return services;
    }
}
