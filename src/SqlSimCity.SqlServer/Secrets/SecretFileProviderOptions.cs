namespace SqlSimCity.SqlServer.Secrets;

/// <summary>
/// Configuration for <see cref="FileSecretFileProvider"/>. The default
/// directory matches the conventional Docker/Compose secrets mount point.
/// </summary>
public sealed class SecretFileProviderOptions
{
    public const string DefaultSecretsDirectory = "/run/secrets";
    public const int DefaultMaxSecretSizeBytes = 16 * 1_024;

    public string SecretsDirectory { get; init; } = DefaultSecretsDirectory;

    public int MaxSecretSizeBytes { get; init; } = DefaultMaxSecretSizeBytes;
}
