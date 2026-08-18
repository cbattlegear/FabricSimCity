using Microsoft.Data.SqlClient;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer.Tests;

public class SqlConnectionFactoryBuilderTests
{
    [Fact]
    public void BuildConnectionStringBuilderMandatorySetsEncryptMandatory()
    {
        var profile = TestProfiles.Build(encryption: EncryptionPolicy.Mandatory);
        var builder = SqlConnectionFactory.BuildConnectionStringBuilder(profile);
        Assert.Equal(SqlConnectionEncryptOption.Mandatory, builder.Encrypt);
    }

    [Fact]
    public void BuildConnectionStringBuilderStrictSetsEncryptStrict()
    {
        var profile = TestProfiles.Build(encryption: EncryptionPolicy.Strict);
        var builder = SqlConnectionFactory.BuildConnectionStringBuilder(profile);
        Assert.Equal(SqlConnectionEncryptOption.Strict, builder.Encrypt);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void BuildConnectionStringBuilderSetsTrustServerCertificateFromProfileOnly(bool trust)
    {
        var profile = TestProfiles.Build(trustServerCertificate: trust);
        var builder = SqlConnectionFactory.BuildConnectionStringBuilder(profile);
        Assert.Equal(trust, builder.TrustServerCertificate);
    }

    [Fact]
    public void BuildConnectionStringBuilderAlwaysSetsPersistSecurityInfoFalse()
    {
        var profile = TestProfiles.Build();
        var builder = SqlConnectionFactory.BuildConnectionStringBuilder(profile);
        Assert.False(builder.PersistSecurityInfo);
    }

    [Fact]
    public void BuildConnectionStringBuilderAlwaysSetsApplicationIntentReadOnly()
    {
        var profile = TestProfiles.Build();
        var builder = SqlConnectionFactory.BuildConnectionStringBuilder(profile);
        Assert.Equal(ApplicationIntent.ReadOnly, builder.ApplicationIntent);
    }

    [Fact]
    public void BuildConnectionStringBuilderAlwaysSetsFixedApplicationName()
    {
        var profile = TestProfiles.Build();
        var builder = SqlConnectionFactory.BuildConnectionStringBuilder(profile);
        Assert.Equal("SQLSimCity", builder.ApplicationName);
    }

    [Fact]
    public void BuildConnectionStringBuilderSetsBoundedTimeouts()
    {
        var profile = TestProfiles.Build();
        var builder = SqlConnectionFactory.BuildConnectionStringBuilder(profile);
        Assert.Equal(15, builder.ConnectTimeout);
        Assert.Equal(30, builder.CommandTimeout);
    }

    [Fact]
    public void BuildConnectionStringBuilderEnablesPoolingWithConfiguredBounds()
    {
        var profile = TestProfiles.Build();
        var builder = SqlConnectionFactory.BuildConnectionStringBuilder(profile);
        Assert.True(builder.Pooling);
        Assert.Equal(1, builder.MinPoolSize);
        Assert.Equal(10, builder.MaxPoolSize);
    }

    [Fact]
    public void BuildConnectionStringBuilderSetsDataSourceAndInitialCatalog()
    {
        var profile = TestProfiles.Build(server: new ServerAddress("sql01.example.com", port: 14330), initialDatabase: "atlas");
        var builder = SqlConnectionFactory.BuildConnectionStringBuilder(profile);
        Assert.Equal("tcp:sql01.example.com,14330", builder.DataSource);
        Assert.Equal("atlas", builder.InitialCatalog);
    }

    [Fact]
    public void BuildConnectionStringBuilderOmitsHostNameInCertificateWhenNotConfigured()
    {
        var profile = TestProfiles.Build();
        var builder = SqlConnectionFactory.BuildConnectionStringBuilder(profile);
        Assert.True(string.IsNullOrEmpty(builder.HostNameInCertificate));
    }

    [Fact]
    public void BuildConnectionStringBuilderSetsHostNameInCertificateWhenConfigured()
    {
        var profile = TestProfiles.Build(hostNameInCertificate: "sql01.pinned.example.com");
        var builder = SqlConnectionFactory.BuildConnectionStringBuilder(profile);
        Assert.Equal("sql01.pinned.example.com", builder.HostNameInCertificate);
    }

    [Theory]
    [MemberData(nameof(AllAuthenticationStrategies))]
    public void BuildConnectionStringBuilderNeverSetsUserIdOrPasswordForAnyAuthMode(AuthenticationStrategy strategy)
    {
        var profile = TestProfiles.Build(authentication: strategy);
        var builder = SqlConnectionFactory.BuildConnectionStringBuilder(profile);

        Assert.True(string.IsNullOrEmpty(builder.UserID));
        Assert.True(string.IsNullOrEmpty(builder.Password));
        Assert.DoesNotContain("Password", builder.ConnectionString, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("User ID", builder.ConnectionString, StringComparison.OrdinalIgnoreCase);
    }

    public static TheoryData<AuthenticationStrategy> AllAuthenticationStrategies()
    {
        var tenant = Guid.NewGuid().ToString();
        var client = Guid.NewGuid().ToString();
        return new TheoryData<AuthenticationStrategy>
        {
            new SqlLoginAuthenticationStrategy("svc-atlas-reader", new SecretFileReference("sql-login-password")),
            new KerberosAuthenticationStrategy(),
            new ManagedIdentityAuthenticationStrategy(),
            new WorkloadIdentityAuthenticationStrategy(tenant, client),
            new ServicePrincipalCertificateAuthenticationStrategy(tenant, client, new SecretFileReference("client.pfx")),
            new ServicePrincipalSecretAuthenticationStrategy(tenant, client, new SecretFileReference("client-secret")),
        };
    }
}
