using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer.Tests.Auth;

public class KerberosAuthenticationStrategyTests
{
    [Fact]
    public void ConstructorIsStatelessAndAlwaysSucceeds()
    {
        var strategy = new KerberosAuthenticationStrategy();
        Assert.NotNull(strategy);
    }
}

public class EntraStrategyGuidValidationTests
{
    private static readonly Guid ValidTenant = Guid.NewGuid();
    private static readonly Guid ValidClient = Guid.NewGuid();

    [Fact]
    public void ManagedIdentitySystemAssignedHasNullClientId()
    {
        var strategy = new ManagedIdentityAuthenticationStrategy();
        Assert.Null(strategy.UserAssignedClientId);
    }

    [Fact]
    public void ManagedIdentityUserAssignedParsesClientId()
    {
        var strategy = new ManagedIdentityAuthenticationStrategy(ValidClient.ToString());
        Assert.Equal(ValidClient, strategy.UserAssignedClientId);
    }

    [Theory]
    [InlineData("not-a-guid")]
    [InlineData("")]
    [InlineData("   ")]
    public void ManagedIdentityRejectsInvalidClientId(string clientId)
    {
        Assert.ThrowsAny<Exception>(() => new ManagedIdentityAuthenticationStrategy(clientId));
    }

    [Fact]
    public void WorkloadIdentityRequiresValidTenantAndClient()
    {
        var strategy = new WorkloadIdentityAuthenticationStrategy(ValidTenant.ToString(), ValidClient.ToString());
        Assert.Equal(ValidTenant, strategy.TenantId);
        Assert.Equal(ValidClient, strategy.ClientId);
        Assert.Null(strategy.FederatedTokenFilePath);
    }

    [Fact]
    public void WorkloadIdentityRejectsInvalidTenantId()
    {
        Assert.Throws<AuthenticationConfigurationException>(
            () => new WorkloadIdentityAuthenticationStrategy("not-a-guid", ValidClient.ToString()));
    }

    [Fact]
    public void WorkloadIdentityRejectsInvalidClientId()
    {
        Assert.Throws<AuthenticationConfigurationException>(
            () => new WorkloadIdentityAuthenticationStrategy(ValidTenant.ToString(), "not-a-guid"));
    }

    [Fact]
    public void WorkloadIdentityAcceptsOverriddenFederatedTokenFilePath()
    {
        var strategy = new WorkloadIdentityAuthenticationStrategy(
            ValidTenant.ToString(), ValidClient.ToString(), federatedTokenFilePath: "/var/run/secrets/azure/tokens/token");
        Assert.Equal("/var/run/secrets/azure/tokens/token", strategy.FederatedTokenFilePath);
    }

    [Fact]
    public void ServicePrincipalCertificateRequiresValidTenantAndClient()
    {
        var strategy = new ServicePrincipalCertificateAuthenticationStrategy(
            ValidTenant.ToString(), ValidClient.ToString(), new SecretFileReference("client.pfx"));
        Assert.Equal(ValidTenant, strategy.TenantId);
        Assert.Equal(ValidClient, strategy.ClientId);
        Assert.Equal("client.pfx", strategy.CertificateSecretReference.FileName);
        Assert.Null(strategy.CertificatePasswordSecretReference);
    }

    [Fact]
    public void ServicePrincipalCertificateRejectsInvalidTenantId()
    {
        Assert.Throws<AuthenticationConfigurationException>(() => new ServicePrincipalCertificateAuthenticationStrategy(
            "not-a-guid", ValidClient.ToString(), new SecretFileReference("client.pfx")));
    }

    [Fact]
    public void ServicePrincipalSecretRequiresValidTenantAndClient()
    {
        var strategy = new ServicePrincipalSecretAuthenticationStrategy(
            ValidTenant.ToString(), ValidClient.ToString(), new SecretFileReference("client-secret"));
        Assert.Equal(ValidTenant, strategy.TenantId);
        Assert.Equal(ValidClient, strategy.ClientId);
        Assert.Equal("client-secret", strategy.ClientSecretReference.FileName);
    }

    [Fact]
    public void ServicePrincipalSecretRejectsInvalidClientId()
    {
        Assert.Throws<AuthenticationConfigurationException>(() => new ServicePrincipalSecretAuthenticationStrategy(
            ValidTenant.ToString(), "not-a-guid", new SecretFileReference("client-secret")));
    }
}
