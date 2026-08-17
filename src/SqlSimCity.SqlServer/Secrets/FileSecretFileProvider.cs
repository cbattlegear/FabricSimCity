namespace SqlSimCity.SqlServer.Secrets;

/// <summary>
/// Resolves secret references to files under a single configured directory
/// (normally the Docker/Compose secrets mount, e.g. <c>/run/secrets</c>). Every
/// candidate path is canonicalized with <see cref="Path.GetFullPath(string)"/>
/// and re-checked against that directory after combining, so a reference
/// cannot escape it even via an unexpected filesystem entry. See SECURITY.md.
/// </summary>
public sealed class FileSecretFileProvider : ISecretFileProvider
{
    private readonly string _secretsDirectoryFullPath;
    private readonly int _maxSecretSizeBytes;

    public FileSecretFileProvider(SecretFileProviderOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (string.IsNullOrWhiteSpace(options.SecretsDirectory))
        {
            throw new ArgumentException("SecretsDirectory must be configured.", nameof(options));
        }

        if (options.MaxSecretSizeBytes <= 0)
        {
            throw new ArgumentException("MaxSecretSizeBytes must be positive.", nameof(options));
        }

        _secretsDirectoryFullPath = Path.GetFullPath(options.SecretsDirectory)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        _maxSecretSizeBytes = options.MaxSecretSizeBytes;
    }

    public async Task<SecretBytes> ReadAsync(SecretFileReference reference, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        var candidatePath = Path.GetFullPath(Path.Combine(_secretsDirectoryFullPath, reference.FileName));
        if (!IsWithinSecretsDirectory(candidatePath))
        {
            throw new SecretResolutionException(
                $"Secret reference '{reference.FileName}' resolved outside the configured secrets directory.");
        }

        FileInfo fileInfo;
        try
        {
            fileInfo = new FileInfo(candidatePath);
        }
        catch (Exception ex) when (ex is ArgumentException or PathTooLongException or NotSupportedException)
        {
            throw new SecretResolutionException($"Secret reference '{reference.FileName}' is not a valid path.", ex);
        }

        if (!fileInfo.Exists)
        {
            throw new SecretResolutionException($"Secret reference '{reference.FileName}' does not exist.");
        }

        if (fileInfo.Length > _maxSecretSizeBytes)
        {
            throw new SecretResolutionException(
                $"Secret reference '{reference.FileName}' exceeds the {_maxSecretSizeBytes}-byte limit.");
        }

        byte[] buffer;
        try
        {
            buffer = await File.ReadAllBytesAsync(candidatePath, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new SecretResolutionException($"Secret reference '{reference.FileName}' could not be read.", ex);
        }

        // The file could have grown between the length check above and the read
        // completing; re-check rather than trust the earlier FileInfo snapshot.
        if (buffer.Length > _maxSecretSizeBytes)
        {
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(buffer);
            throw new SecretResolutionException(
                $"Secret reference '{reference.FileName}' exceeds the {_maxSecretSizeBytes}-byte limit.");
        }

        return new SecretBytes(buffer);
    }

    private bool IsWithinSecretsDirectory(string candidateFullPath) =>
        candidateFullPath.Length > _secretsDirectoryFullPath.Length + 1
        && candidateFullPath.StartsWith(_secretsDirectoryFullPath, StringComparison.Ordinal)
        && (candidateFullPath[_secretsDirectoryFullPath.Length] == Path.DirectorySeparatorChar
            || candidateFullPath[_secretsDirectoryFullPath.Length] == Path.AltDirectorySeparatorChar);
}
