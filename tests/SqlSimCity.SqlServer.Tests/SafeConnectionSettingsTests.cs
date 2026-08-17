using System.Text.Json;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer.Tests;

public class SafeConnectionSettingsTests
{
    [Fact]
    public void FromSqlLoginExposesUsernameButNoPasswordProperty()
    {
        var profile = TestProfiles.Build(
            authentication: new SqlLoginAuthenticationStrategy("svc-atlas-reader", new SecretFileReference("sql-login-password")));

        var settings = SafeConnectionSettings.From(profile);

        Assert.Equal("svc-atlas-reader", settings.SqlLoginUsername);
        Assert.Equal(nameof(SqlLoginAuthenticationStrategy), settings.AuthenticationKind);
        Assert.All(typeof(SafeConnectionSettings).GetProperties(), p => Assert.NotEqual("Password", p.Name));
    }

    [Fact]
    public void FromKerberosHasNoSqlOrEntraIdentifiers()
    {
        var profile = TestProfiles.Build(authentication: new KerberosAuthenticationStrategy());
        var settings = SafeConnectionSettings.From(profile);

        Assert.Null(settings.SqlLoginUsername);
        Assert.Null(settings.EntraTenantId);
        Assert.Null(settings.EntraClientId);
    }

    [Fact]
    public void FromManagedIdentitySystemAssignedReportsNoUserAssignedIdentity()
    {
        var profile = TestProfiles.Build(authentication: new ManagedIdentityAuthenticationStrategy());
        var settings = SafeConnectionSettings.From(profile);

        Assert.False(settings.EntraUsesUserAssignedIdentity);
        Assert.Null(settings.EntraClientId);
    }

    [Fact]
    public void FromManagedIdentityUserAssignedReportsClientId()
    {
        var clientId = Guid.NewGuid();
        var profile = TestProfiles.Build(authentication: new ManagedIdentityAuthenticationStrategy(clientId.ToString()));
        var settings = SafeConnectionSettings.From(profile);

        Assert.True(settings.EntraUsesUserAssignedIdentity);
        Assert.Equal(clientId.ToString(), settings.EntraClientId);
    }

    [Fact]
    public void FromWorkloadIdentityReportsTenantAndClientIds()
    {
        var tenant = Guid.NewGuid();
        var client = Guid.NewGuid();
        var profile = TestProfiles.Build(authentication: new WorkloadIdentityAuthenticationStrategy(tenant.ToString(), client.ToString()));
        var settings = SafeConnectionSettings.From(profile);

        Assert.Equal(tenant.ToString(), settings.EntraTenantId);
        Assert.Equal(client.ToString(), settings.EntraClientId);
    }

    [Fact]
    public void FromTrustServerCertificateSurfacesWarning()
    {
        var profile = TestProfiles.Build(trustServerCertificate: true);
        var settings = SafeConnectionSettings.From(profile);
        Assert.Contains(ConnectionWarning.TrustServerCertificateEnabled, settings.Warnings);
    }

    [Fact]
    public void FromRejectsNullProfile()
    {
        Assert.Throws<ArgumentNullException>(() => SafeConnectionSettings.From(null!));
    }

    [Fact]
    public void SerializationServicePrincipalSecretNeverContainsSecretContent()
    {
        var profile = TestProfiles.Build(authentication: new ServicePrincipalSecretAuthenticationStrategy(
            Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new SecretFileReference("client-secret")));

        var settings = SafeConnectionSettings.From(profile);
        var json = JsonSerializer.Serialize(settings);

        // SafeConnectionSettings.From never reads secret bytes at all -- it
        // only carries the tenant/client GUIDs -- so the file reference name
        // (not a secret itself) must be the only client-secret trace present.
        Assert.DoesNotContain("ClientSecretReference", json);
        Assert.Contains(nameof(ServicePrincipalSecretAuthenticationStrategy), json);
    }

    [Fact]
    public void SerializationSqlLoginNeverContainsPasswordField()
    {
        var profile = TestProfiles.Build(
            authentication: new SqlLoginAuthenticationStrategy("svc-atlas-reader", new SecretFileReference("sql-login-password")));

        var settings = SafeConnectionSettings.From(profile);
        var json = JsonSerializer.Serialize(settings);

        Assert.Contains("svc-atlas-reader", json);
        Assert.DoesNotContain("Password", json, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ToStringOfConnectionProfileDoesNotThrowAndNeverIncludesSecretMaterial()
    {
        // ConnectionProfile does not override ToString; the default
        // (type-name only) representation is what any incidental
        // logging/exception message would print, so it structurally cannot
        // contain secret content.
        var profile = TestProfiles.Build(
            authentication: new SqlLoginAuthenticationStrategy("svc-atlas-reader", new SecretFileReference("sql-login-password")));

        var text = profile.ToString();

        Assert.NotNull(text);
        Assert.DoesNotContain("sql-login-password", text);
    }
}
