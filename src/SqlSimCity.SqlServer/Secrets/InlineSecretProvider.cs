using System.Text;

namespace SqlSimCity.SqlServer.Secrets;

/// <summary>
/// Resolves exactly one secret that was supplied inline (today: a password read
/// out of a configured connection string) from memory instead of a mounted
/// file. It is deliberately narrow -- every other reference fails closed with
/// <see cref="SecretResolutionException"/> -- so it can never quietly stand in
/// for <see cref="FileSecretFileProvider"/> on a path that expects real mounted
/// secrets such as a client certificate or federated token.
///
/// An inline secret is weaker than a mounted one: it lives in the process
/// environment or configuration for the life of the process, is visible to
/// anything that can read that environment, and cannot be rotated without a
/// restart. See <see cref="ConnectionStringProfile"/> and SECURITY.md.
/// </summary>
public sealed class InlineSecretProvider : ISecretFileProvider
{
    private readonly string _fileName;
    private readonly byte[] _value;

    public InlineSecretProvider(SecretFileReference reference, string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        _fileName = reference.FileName;
        _value = Encoding.UTF8.GetBytes(value);
    }

    public Task<SecretBytes> ReadAsync(SecretFileReference reference, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (!string.Equals(reference.FileName, _fileName, StringComparison.Ordinal))
        {
            throw new SecretResolutionException(
                $"Secret reference '{reference.FileName}' is not available inline; mount it as a secret file and configure a secrets directory.");
        }

        // Callers own -- and zero -- what they receive, so hand out a copy and
        // keep this provider's own buffer intact for the next read.
        return Task.FromResult(new SecretBytes((byte[])_value.Clone()));
    }
}
