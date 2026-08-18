using SqlSimCity.SqlServer.Auth;

namespace SqlSimCity.SqlServer.Tests;

public class ConnectionProfileTests
{
    [Fact]
    public void ConstructorAcceptsValidProfile()
    {
        var profile = TestProfiles.Build();
        Assert.Equal("test-profile", profile.Id.Value);
        Assert.Equal("sqlsimcity", profile.InitialDatabase);
        Assert.False(profile.TrustServerCertificate);
    }

    [Fact]
    public void WithInitialDatabaseCopiesValidatedProfileWithoutChangingOtherSettings()
    {
        var profile = TestProfiles.Build(initialDatabase: "DB-A", hostNameInCertificate: "sql.example.com");

        var copy = profile.WithInitialDatabase("DB-B");

        Assert.Equal("DB-B", copy.InitialDatabase);
        Assert.Equal(profile.Id, copy.Id);
        Assert.Same(profile.Server, copy.Server);
        Assert.Same(profile.Timeouts, copy.Timeouts);
        Assert.Same(profile.Pool, copy.Pool);
        Assert.Same(profile.Authentication, copy.Authentication);
        Assert.Equal(profile.Encryption, copy.Encryption);
        Assert.Equal(profile.HostNameInCertificate, copy.HostNameInCertificate);
        Assert.Equal(profile.TrustServerCertificate, copy.TrustServerCertificate);
        Assert.Throws<ConnectionProfileValidationException>(() => profile.WithInitialDatabase("bad;db"));
    }

    [Fact]
    public void ApplicationNameIsFixedConstant()
    {
        Assert.Equal("SQLSimCity", ConnectionProfile.ApplicationName);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void ConstructorRejectsNullOrWhitespaceDatabase(string? database)
    {
        Assert.ThrowsAny<ArgumentException>(() => TestProfiles.Build(initialDatabase: database!));
    }

    [Fact]
    public void ConstructorRejectsControlCharactersInDatabase()
    {
        Assert.Throws<ConnectionProfileValidationException>(() => TestProfiles.Build(initialDatabase: "sql\u0007city"));
    }

    [Theory]
    [InlineData("db;DROP")]
    [InlineData("db=x")]
    public void ConstructorRejectsConnectionStringFragmentsInDatabase(string database)
    {
        Assert.Throws<ConnectionProfileValidationException>(() => TestProfiles.Build(initialDatabase: database));
    }

    [Fact]
    public void ConstructorRejectsDatabaseLongerThanMaxLength()
    {
        Assert.Throws<ConnectionProfileValidationException>(() => TestProfiles.Build(initialDatabase: new string('a', 129)));
    }

    [Fact]
    public void ConstructorRejectsControlCharactersInHostNameInCertificate()
    {
        Assert.Throws<ConnectionProfileValidationException>(
            () => TestProfiles.Build(hostNameInCertificate: "sql\u0007.example.com"));
    }

    [Fact]
    public void ConstructorAcceptsValidHostNameInCertificate()
    {
        var profile = TestProfiles.Build(hostNameInCertificate: "sql01.example.com");
        Assert.Equal("sql01.example.com", profile.HostNameInCertificate);
    }

    [Fact]
    public void ConstructorRejectsNullServer()
    {
        Assert.Throws<ArgumentNullException>(() => new ConnectionProfile(
            new ConnectionProfileId("test-profile"),
            server: null!,
            "sqlsimcity",
            TestProfiles.ValidTimeouts(),
            TestProfiles.ValidPool(),
            EncryptionPolicy.Mandatory,
            new KerberosAuthenticationStrategy()));
    }

    [Fact]
    public void ConstructorRejectsNullAuthentication()
    {
        Assert.Throws<ArgumentNullException>(() => new ConnectionProfile(
            new ConnectionProfileId("p"),
            TestProfiles.ValidServer(),
            "db",
            TestProfiles.ValidTimeouts(),
            TestProfiles.ValidPool(),
            EncryptionPolicy.Mandatory,
            authentication: null!));
    }

    [Fact]
    public void TrustServerCertificateIsPerProfileOnly()
    {
        var trusting = TestProfiles.Build(trustServerCertificate: true);
        var strict = TestProfiles.Build(trustServerCertificate: false);

        Assert.True(trusting.TrustServerCertificate);
        Assert.False(strict.TrustServerCertificate);
    }

    [Fact]
    public void EncryptionStrictIsAnIndependentOptIn()
    {
        var profile = TestProfiles.Build(encryption: EncryptionPolicy.Strict);
        Assert.Equal(EncryptionPolicy.Strict, profile.Encryption);
    }

    [Fact]
    public void ConstructorRejectsTrustServerCertificateWithStrictEncryption()
    {
        var ex = Assert.Throws<ConnectionProfileValidationException>(
            () => TestProfiles.Build(
                encryption: EncryptionPolicy.Strict,
                trustServerCertificate: true));

        Assert.Contains("Strict", ex.Message);
        Assert.Contains("TrustServerCertificate", ex.Message);
    }
}
