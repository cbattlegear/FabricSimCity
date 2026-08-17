namespace SqlSimCity.SqlServer.Secrets;

/// <summary>
/// A validated reference to a secret file, identified by simple file name
/// only. It never carries a directory, drive letter, or traversal segment, so
/// resolving it under <see cref="SecretFileProviderOptions.SecretsDirectory"/>
/// cannot escape that directory by construction. The reference is a name, not
/// the secret value itself.
/// </summary>
public readonly record struct SecretFileReference
{
    private const int MaxLength = 255;

    public SecretFileReference(string fileName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(fileName);
        if (fileName.Length > MaxLength)
        {
            throw new SecretResolutionException($"Secret file reference must be {MaxLength} characters or fewer.");
        }

        if (!IsSimpleFileName(fileName))
        {
            throw new SecretResolutionException(
                "Secret file reference must be a simple file name without path separators, drive letters, or traversal segments.");
        }

        FileName = fileName;
    }

    public string FileName { get; }

    public override string ToString() => FileName;

    public static implicit operator SecretFileReference(string fileName) => new(fileName);

    private static bool IsSimpleFileName(string value) =>
        value is not "." and not ".."
        && !value.Contains('/')
        && !value.Contains('\\')
        && !value.Contains(':')
        && !value.Any(char.IsControl);
}
