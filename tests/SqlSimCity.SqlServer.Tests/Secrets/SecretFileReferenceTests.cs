using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer.Tests.Secrets;

public class SecretFileReferenceTests
{
    [Fact]
    public void ConstructorAcceptsSimpleFileName()
    {
        var reference = new SecretFileReference("sql-login-password");
        Assert.Equal("sql-login-password", reference.FileName);
        Assert.Equal("sql-login-password", reference.ToString());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void ConstructorRejectsNullOrWhitespace(string? fileName)
    {
        Assert.ThrowsAny<ArgumentException>(() => new SecretFileReference(fileName!));
    }

    [Theory]
    [InlineData(".")]
    [InlineData("..")]
    [InlineData("../secret")]
    [InlineData("..\\secret")]
    [InlineData("/etc/passwd")]
    [InlineData("subdir/secret")]
    [InlineData("subdir\\secret")]
    [InlineData("C:secret")]
    public void ConstructorRejectsTraversalAndPathSegments(string fileName)
    {
        Assert.Throws<SecretResolutionException>(() => new SecretFileReference(fileName));
    }

    [Fact]
    public void ConstructorRejectsControlCharacters()
    {
        Assert.Throws<SecretResolutionException>(() => new SecretFileReference("secret\u0007name"));
    }

    [Fact]
    public void ConstructorRejectsNameLongerThan255Characters()
    {
        Assert.Throws<SecretResolutionException>(() => new SecretFileReference(new string('a', 256)));
    }

    [Fact]
    public void ImplicitConversionFromStringWorks()
    {
        SecretFileReference reference = "sql-login-password";
        Assert.Equal("sql-login-password", reference.FileName);
    }
}
