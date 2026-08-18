using System.Text;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer.Tests.Secrets;

public class SecretBytesTests
{
    [Fact]
    public void SpanExposesOriginalBytes()
    {
        var secret = new SecretBytes(Encoding.UTF8.GetBytes("hunter2"));
        Assert.Equal("hunter2", Encoding.UTF8.GetString(secret.Span));
    }

    [Fact]
    public void DisposeZeroesBackingBuffer()
    {
        var bytes = Encoding.UTF8.GetBytes("hunter2");
        var secret = new SecretBytes(bytes);

        secret.Dispose();

        Assert.All(bytes, b => Assert.Equal(0, b));
    }

    [Fact]
    public void SpanAfterDisposeThrowsObjectDisposedException()
    {
        var secret = new SecretBytes(Encoding.UTF8.GetBytes("hunter2"));
        secret.Dispose();

        Assert.Throws<ObjectDisposedException>(() => secret.Span.Length);
    }

    [Fact]
    public void DisposeIsIdempotent()
    {
        var secret = new SecretBytes(Encoding.UTF8.GetBytes("hunter2"));
        secret.Dispose();
        var exception = Record.Exception(secret.Dispose);
        Assert.Null(exception);
    }

    [Fact]
    public void ToUtf8SecureStringProducesCorrectLength()
    {
        var secret = new SecretBytes(Encoding.UTF8.GetBytes("hunter2"));
        using var secure = secret.ToUtf8SecureString();
        Assert.Equal(7, secure.Length);
        Assert.True(secure.IsReadOnly());
    }

    [Fact]
    public void ToUtf8SecureStringTrimsTrailingCrLf()
    {
        var secret = new SecretBytes(Encoding.UTF8.GetBytes("hunter2\r\n"));
        using var secure = secret.ToUtf8SecureString();
        Assert.Equal(7, secure.Length);
    }

    [Fact]
    public void ToUtf8SecureStringTrimsTrailingLfOnly()
    {
        var secret = new SecretBytes(Encoding.UTF8.GetBytes("hunter2\n"));
        using var secure = secret.ToUtf8SecureString();
        Assert.Equal(7, secure.Length);
    }

    [Fact]
    public void UseAsUtf8TextDecodesWithoutMaterializingSecureString()
    {
        var secret = new SecretBytes(Encoding.UTF8.GetBytes("hunter2"));
        var length = secret.UseAsUtf8Text(chars => chars.Length);
        Assert.Equal(7, length);
    }

    [Fact]
    public void UseAsUtf8TextInvalidUtf8ThrowsSecretResolutionException()
    {
        var secret = new SecretBytes([0xFF, 0xFE, 0x00, 0x01]);
        Assert.Throws<SecretResolutionException>(() => secret.UseAsUtf8Text(chars => chars.Length));
    }

    [Fact]
    public void ConstructorRejectsNullBytes()
    {
        Assert.Throws<ArgumentNullException>(() => new SecretBytes(null!));
    }
}
