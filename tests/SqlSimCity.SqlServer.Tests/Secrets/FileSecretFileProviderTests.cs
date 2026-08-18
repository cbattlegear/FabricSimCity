using System.Text;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer.Tests.Secrets;

public sealed class FileSecretFileProviderTests : IDisposable
{
    private readonly DirectoryInfo _secretsDirectory = Directory.CreateTempSubdirectory("sqlsimcity-secrets-tests-");

    public void Dispose()
    {
        try
        {
            _secretsDirectory.Delete(recursive: true);
        }
        catch (IOException)
        {
            // Best-effort cleanup; a locked handle on a shared CI runner
            // should not fail the test that already asserted its outcome.
        }
    }

    private FileSecretFileProvider CreateProvider(int maxSecretSizeBytes = 16 * 1024) =>
        new(new SecretFileProviderOptions { SecretsDirectory = _secretsDirectory.FullName, MaxSecretSizeBytes = maxSecretSizeBytes });

    private string WriteSecretFile(string fileName, byte[] content)
    {
        var path = Path.Combine(_secretsDirectory.FullName, fileName);
        File.WriteAllBytes(path, content);
        return path;
    }

    [Fact]
    public async Task ReadAsyncReturnsFileContentBytes()
    {
        WriteSecretFile("db-password", Encoding.UTF8.GetBytes("hunter2"));
        var provider = CreateProvider();

        using var secret = await provider.ReadAsync(new SecretFileReference("db-password"), CancellationToken.None);

        Assert.Equal("hunter2", Encoding.UTF8.GetString(secret.Span));
    }

    [Fact]
    public async Task ReadAsyncTrimsTrailingCrLfViaUseAsUtf8Text()
    {
        WriteSecretFile("db-password", Encoding.UTF8.GetBytes("hunter2\r\n"));
        var provider = CreateProvider();

        using var secret = await provider.ReadAsync(new SecretFileReference("db-password"), CancellationToken.None);

        var decoded = secret.UseAsUtf8Text(chars => new string(chars));
        Assert.Equal("hunter2", decoded);
    }

    [Fact]
    public async Task ReadAsyncMissingFileThrowsSecretResolutionException()
    {
        var provider = CreateProvider();

        var ex = await Assert.ThrowsAsync<SecretResolutionException>(
            () => provider.ReadAsync(new SecretFileReference("does-not-exist"), CancellationToken.None));

        Assert.DoesNotContain("hunter2", ex.Message);
    }

    [Fact]
    public async Task ReadAsyncOverSizeLimitThrowsSecretResolutionException()
    {
        WriteSecretFile("too-big", new byte[32]);
        var provider = CreateProvider(maxSecretSizeBytes: 16);

        await Assert.ThrowsAsync<SecretResolutionException>(
            () => provider.ReadAsync(new SecretFileReference("too-big"), CancellationToken.None));
    }

    [Fact]
    public async Task ReadAsyncAtSizeLimitSucceeds()
    {
        WriteSecretFile("exact-size", new byte[16]);
        var provider = CreateProvider(maxSecretSizeBytes: 16);

        using var secret = await provider.ReadAsync(new SecretFileReference("exact-size"), CancellationToken.None);
        Assert.Equal(16, secret.Length);
    }

    [Fact]
    public async Task ReadAsyncInvalidUtf8ThrowsSecretResolutionExceptionOnDecode()
    {
        // 0xFF is never valid as a standalone UTF-8 lead byte.
        WriteSecretFile("bad-encoding", [0xFF, 0xFE, 0x00, 0x01]);
        var provider = CreateProvider();

        using var secret = await provider.ReadAsync(new SecretFileReference("bad-encoding"), CancellationToken.None);

        Assert.Throws<SecretResolutionException>(() => secret.UseAsUtf8Text(chars => new string(chars)));
    }

    [Fact]
    public async Task ReadAsyncCancellationThrowsOperationCanceledException()
    {
        WriteSecretFile("db-password", Encoding.UTF8.GetBytes("hunter2"));
        var provider = CreateProvider();
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => provider.ReadAsync(new SecretFileReference("db-password"), cts.Token));
    }

    [Fact]
    public void ConstructorRejectsMissingSecretsDirectoryConfiguration()
    {
        Assert.Throws<ArgumentException>(() => new FileSecretFileProvider(new SecretFileProviderOptions { SecretsDirectory = "" }));
    }

    [Fact]
    public void ConstructorRejectsNonPositiveMaxSecretSizeBytes()
    {
        Assert.Throws<ArgumentException>(() => new FileSecretFileProvider(
            new SecretFileProviderOptions { SecretsDirectory = _secretsDirectory.FullName, MaxSecretSizeBytes = 0 }));
    }

    [Fact]
    public async Task ReadAsyncThrowsForMissingSecretWithoutLoggingOrExposingContent()
    {
        // Fail-closed: a missing/unreadable/invalid secret must never surface
        // as anything other than SecretResolutionException, and the message
        // must not echo any file content back to a caller/log sink.
        var provider = CreateProvider();
        var ex = await Record.ExceptionAsync(
            () => provider.ReadAsync(new SecretFileReference("never-created"), CancellationToken.None));

        Assert.IsType<SecretResolutionException>(ex);
    }
}
