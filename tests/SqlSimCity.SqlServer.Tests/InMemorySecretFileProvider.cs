using System.Text;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer.Tests;

/// <summary>An in-memory secret provider for tests -- never touches disk or a live secrets mount.</summary>
internal sealed class InMemorySecretFileProvider : ISecretFileProvider
{
    private readonly Dictionary<string, byte[]> _secrets = [];

    public int ReadCount { get; private set; }

    public InMemorySecretFileProvider With(string fileName, string value)
    {
        _secrets[fileName] = Encoding.UTF8.GetBytes(value);
        return this;
    }

    public InMemorySecretFileProvider WithBytes(string fileName, byte[] value)
    {
        _secrets[fileName] = value;
        return this;
    }

    public Task<SecretBytes> ReadAsync(SecretFileReference reference, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ReadCount++;
        if (!_secrets.TryGetValue(reference.FileName, out var bytes))
        {
            throw new SecretResolutionException($"Secret reference '{reference.FileName}' does not exist.");
        }

        return Task.FromResult(new SecretBytes((byte[])bytes.Clone()));
    }
}
