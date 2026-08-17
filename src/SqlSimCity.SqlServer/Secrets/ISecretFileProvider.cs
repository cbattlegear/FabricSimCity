namespace SqlSimCity.SqlServer.Secrets;

/// <summary>
/// Resolves a validated <see cref="SecretFileReference"/> to its bytes under
/// an allowed secret directory (see <see cref="SecretFileProviderOptions"/>).
/// Callers read once per connection attempt and dispose the result promptly;
/// no implementation may log secret content, and every failure mode --
/// missing, unreadable, oversized, or otherwise invalid -- fails closed with
/// <see cref="SecretResolutionException"/> rather than returning a partially
/// usable value.
/// </summary>
public interface ISecretFileProvider
{
    Task<SecretBytes> ReadAsync(SecretFileReference reference, CancellationToken cancellationToken);
}
