using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Azure.Identity;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer.Tests.Auth;

public class EntraTokenCredentialFactoryTests
{
    [Fact]
    public async Task CreateAsyncManagedIdentitySystemAssignedProducesManagedIdentityCredential()
    {
        var strategy = new ManagedIdentityAuthenticationStrategy();
        var material = await EntraTokenCredentialFactory.CreateAsync(
            strategy, new InMemorySecretFileProvider(), CancellationToken.None);

        Assert.IsType<ManagedIdentityCredential>(material.Credential);
        Assert.Null(material.OwnedCertificate);
    }

    [Fact]
    public async Task CreateAsyncManagedIdentityUserAssignedProducesManagedIdentityCredential()
    {
        var strategy = new ManagedIdentityAuthenticationStrategy(Guid.NewGuid().ToString());
        var material = await EntraTokenCredentialFactory.CreateAsync(
            strategy, new InMemorySecretFileProvider(), CancellationToken.None);

        Assert.IsType<ManagedIdentityCredential>(material.Credential);
        Assert.Null(material.OwnedCertificate);
    }

    [Fact]
    public async Task CreateAsyncWorkloadIdentityProducesWorkloadIdentityCredential()
    {
        var strategy = new WorkloadIdentityAuthenticationStrategy(Guid.NewGuid().ToString(), Guid.NewGuid().ToString());
        var material = await EntraTokenCredentialFactory.CreateAsync(
            strategy, new InMemorySecretFileProvider(), CancellationToken.None);

        Assert.IsType<WorkloadIdentityCredential>(material.Credential);
        Assert.Null(material.OwnedCertificate);
    }

    [Fact]
    public async Task CreateAsyncServicePrincipalSecretProducesClientSecretCredentialAndReadsSecretOnce()
    {
        var secrets = new InMemorySecretFileProvider().With("client-secret", "super-secret-value");
        var strategy = new ServicePrincipalSecretAuthenticationStrategy(
            Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new SecretFileReference("client-secret"));

        var material = await EntraTokenCredentialFactory.CreateAsync(strategy, secrets, CancellationToken.None);

        Assert.IsType<ClientSecretCredential>(material.Credential);
        Assert.Null(material.OwnedCertificate);
        Assert.Equal(1, secrets.ReadCount);
    }

    [Fact]
    public async Task CreateAsyncServicePrincipalCertificateProducesClientCertificateCredential()
    {
        using var selfSigned = CreateSelfSignedCertificate();
        var pfxBytes = selfSigned.Export(X509ContentType.Pfx, "cert-password");
        var secrets = new InMemorySecretFileProvider();
        secrets.WithBytes("client.pfx", pfxBytes);
        secrets.With("cert-password", "cert-password");

        var strategy = new ServicePrincipalCertificateAuthenticationStrategy(
            Guid.NewGuid().ToString(),
            Guid.NewGuid().ToString(),
            new SecretFileReference("client.pfx"),
            new SecretFileReference("cert-password"));

        var material = await EntraTokenCredentialFactory.CreateAsync(strategy, secrets, CancellationToken.None);
        using var owned = material.OwnedCertificate;

        Assert.IsType<ClientCertificateCredential>(material.Credential);
        Assert.NotNull(owned);
    }

    [Fact]
    public async Task CreateAsyncServicePrincipalCertificateWithoutPasswordSucceeds()
    {
        using var selfSigned = CreateSelfSignedCertificate();
        var pfxBytes = selfSigned.Export(X509ContentType.Pfx); // no password
        var secrets = new InMemorySecretFileProvider();
        secrets.WithBytes("client.pfx", pfxBytes);

        var strategy = new ServicePrincipalCertificateAuthenticationStrategy(
            Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new SecretFileReference("client.pfx"));

        var material = await EntraTokenCredentialFactory.CreateAsync(strategy, secrets, CancellationToken.None);
        using var owned = material.OwnedCertificate;

        Assert.IsType<ClientCertificateCredential>(material.Credential);
        Assert.NotNull(owned);
    }

    [Fact]
    public async Task CreateAsyncRejectsNullStrategy()
    {
        await Assert.ThrowsAsync<ArgumentNullException>(
            () => EntraTokenCredentialFactory.CreateAsync(null!, new InMemorySecretFileProvider(), CancellationToken.None));
    }

    [Fact]
    public async Task CreateAsyncRejectsNullSecretProvider()
    {
        await Assert.ThrowsAsync<ArgumentNullException>(
            () => EntraTokenCredentialFactory.CreateAsync(new ManagedIdentityAuthenticationStrategy(), null!, CancellationToken.None));
    }

    private static X509Certificate2 CreateSelfSignedCertificate()
    {
        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest(
            "CN=sqlsimcity-test-client", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        return request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddMinutes(5));
    }
}
