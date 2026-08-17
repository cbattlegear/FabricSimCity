using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer.Tests.Auth;

public class SqlLoginAuthenticationStrategyTests
{
    [Fact]
    public void ConstructorAcceptsValidUsername()
    {
        var strategy = new SqlLoginAuthenticationStrategy("svc-atlas-reader", new SecretFileReference("sql-login-password"));
        Assert.Equal("svc-atlas-reader", strategy.Username);
        Assert.Equal("sql-login-password", strategy.PasswordSecretReference.FileName);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void ConstructorRejectsNullOrWhitespaceUsername(string? username)
    {
        Assert.ThrowsAny<ArgumentException>(
            () => new SqlLoginAuthenticationStrategy(username!, new SecretFileReference("pw")));
    }

    [Fact]
    public void ConstructorRejectsControlCharactersInUsername()
    {
        Assert.Throws<ConnectionProfileValidationException>(
            () => new SqlLoginAuthenticationStrategy("svc\u0007reader", new SecretFileReference("pw")));
    }

    [Theory]
    [InlineData("svc;DROP")]
    [InlineData("svc=x")]
    public void ConstructorRejectsConnectionStringFragmentsInUsername(string username)
    {
        Assert.Throws<ConnectionProfileValidationException>(
            () => new SqlLoginAuthenticationStrategy(username, new SecretFileReference("pw")));
    }

    [Fact]
    public void ConstructorRejectsUsernameLongerThanMaxLength()
    {
        Assert.Throws<ConnectionProfileValidationException>(
            () => new SqlLoginAuthenticationStrategy(new string('a', 129), new SecretFileReference("pw")));
    }

    [Fact]
    public void NoPropertyCanHoldAPlaintextPassword()
    {
        // Structural guarantee: the only password-related property is a
        // SecretFileReference (a validated file name), never a string that
        // could hold the password itself.
        var properties = typeof(SqlLoginAuthenticationStrategy).GetProperties();
        Assert.All(properties, p => Assert.NotEqual("Password", p.Name));
        Assert.Contains(properties, p => p.Name == nameof(SqlLoginAuthenticationStrategy.PasswordSecretReference)
            && p.PropertyType == typeof(SecretFileReference));
    }
}
