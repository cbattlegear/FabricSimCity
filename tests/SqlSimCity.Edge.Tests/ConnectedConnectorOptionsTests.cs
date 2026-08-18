using SqlSimCity.Contracts.V1;
using SqlSimCity.Edge.Connector;
using SqlSimCity.SqlServer.Auth;

namespace SqlSimCity.Edge.Tests;

public sealed class ConnectedConnectorOptionsTests
{
    [Fact]
    public void FixtureIsTheDefaultSourceMode()
    {
        var options = ConnectorOptions.FromEnvironment(BaseEnvironment());

        Assert.Equal(ConnectorSourceMode.Fixture, options.SourceMode);
        Assert.Null(options.Connected);
    }

    [Theory]
    [InlineData("SqlLogin", typeof(SqlLoginAuthenticationStrategy))]
    [InlineData("Kerberos", typeof(KerberosAuthenticationStrategy))]
    [InlineData("ManagedIdentity", typeof(ManagedIdentityAuthenticationStrategy))]
    [InlineData("WorkloadIdentity", typeof(WorkloadIdentityAuthenticationStrategy))]
    [InlineData("ServicePrincipalCertificate", typeof(ServicePrincipalCertificateAuthenticationStrategy))]
    [InlineData("ServicePrincipalSecret", typeof(ServicePrincipalSecretAuthenticationStrategy))]
    public void ConnectedModeSelectsExactlyOneExistingAuthenticationStrategy(
        string mode,
        Type expectedType)
    {
        var env = ConnectedEnvironment();
        env["SQLSIMCITY_EDGE_SQL_AUTH_MODE"] = mode;

        var options = ConnectorOptions.FromEnvironment(env);

        Assert.Equal(ConnectorSourceMode.Connected, options.SourceMode);
        Assert.IsType(expectedType, options.Connected!.Profile.Authentication);
    }

    [Fact]
    public void ConnectedModeRejectsPlaintextSecretEnvironmentValues()
    {
        var env = ConnectedEnvironment();
        env["SQLSIMCITY_EDGE_SQL_PASSWORD"] = "do-not-echo-this-secret";

        var exception = Assert.Throws<ConnectorConfigurationException>(
            () => ConnectorOptions.FromEnvironment(env));

        Assert.Contains("plaintext secret", exception.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("do-not-echo-this-secret", exception.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void AzureSqlDatabaseRequiresKnownDatabases()
    {
        var env = ConnectedEnvironment();
        env["SQLSIMCITY_EDGE_SQL_PLATFORM"] = EnginePlatform.AzureSqlDatabase.ToString();
        env.Remove("SQLSIMCITY_EDGE_SQL_KNOWN_DATABASES");

        var exception = Assert.Throws<ConnectorConfigurationException>(
            () => ConnectorOptions.FromEnvironment(env));

        Assert.Contains("known database", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void UnknownAuthenticationModeDoesNotFallback()
    {
        var env = ConnectedEnvironment();
        env["SQLSIMCITY_EDGE_SQL_AUTH_MODE"] = "DefaultAzureCredential";

        var exception = Assert.Throws<ConnectorConfigurationException>(
            () => ConnectorOptions.FromEnvironment(env));

        Assert.Contains("must be one of", exception.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("fallback", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void DomainValidationFailuresRemainCuratedConfigurationErrors()
    {
        var env = ConnectedEnvironment();
        env["SQLSIMCITY_EDGE_SQL_PASSWORD_SECRET_FILE"] = "../private-password";

        var exception = Assert.Throws<ConnectorConfigurationException>(
            () => ConnectorOptions.FromEnvironment(env));

        Assert.Equal(
            "Connected SQL source configuration is invalid; check the documented field shapes.",
            exception.Message);
        Assert.DoesNotContain("../private-password", exception.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void InvalidSecretStoreBoundsAreConfigurationErrors()
    {
        var env = ConnectedEnvironment();
        env["SQLSIMCITY_EDGE_SQL_MAX_SECRET_SIZE_BYTES"] = "0";

        var exception = Assert.Throws<ConnectorConfigurationException>(
            () => ConnectorOptions.FromEnvironment(env));

        Assert.Contains("must be positive", exception.Message, StringComparison.Ordinal);
    }

    private static Dictionary<string, string?> BaseEnvironment() => new(StringComparer.Ordinal)
    {
        ["SQLSIMCITY_EDGE_CONNECTOR_ID"] = "edge-a",
        ["SQLSIMCITY_EDGE_TARGET_ID"] = "target-a",
        ["SQLSIMCITY_EDGE_KEY_ID"] = "key-a",
        ["SQLSIMCITY_EDGE_INGEST_ENDPOINT"] = "https://central.example/api/v1/edge/ingest",
        ["SQLSIMCITY_EDGE_SIGNING_SECRET_FILE"] = "signing-secret",
        ["SQLSIMCITY_EDGE_SPOOL_DIR"] = "spool",
        ["SQLSIMCITY_EDGE_SPOOL_KEY_FILE"] = "spool-key",
        ["SQLSIMCITY_EDGE_FIXTURES_DIR"] = "fixtures",
    };

    private static Dictionary<string, string?> ConnectedEnvironment()
    {
        var env = BaseEnvironment();
        env["SQLSIMCITY_EDGE_SOURCE_MODE"] = "Connected";
        env["SQLSIMCITY_EDGE_SQL_HOST"] = "sql.example.internal";
        env["SQLSIMCITY_EDGE_SQL_PORT"] = "1433";
        env["SQLSIMCITY_EDGE_SQL_INITIAL_DATABASE"] = "appdb";
        env["SQLSIMCITY_EDGE_SQL_PLATFORM"] = EnginePlatform.SqlServerOnPremises.ToString();
        env["SQLSIMCITY_EDGE_SQL_TARGET_DISPLAY_NAME"] = "Production SQL";
        env["SQLSIMCITY_EDGE_SQL_KNOWN_DATABASES"] = "appdb,reporting";
        env["SQLSIMCITY_EDGE_SQL_SECRETS_DIR"] = "sql-secrets";
        env["SQLSIMCITY_EDGE_SQL_AUTH_MODE"] = "SqlLogin";
        env["SQLSIMCITY_EDGE_SQL_USERNAME"] = "collector";
        env["SQLSIMCITY_EDGE_SQL_PASSWORD_SECRET_FILE"] = "sql-password";
        env["SQLSIMCITY_EDGE_SQL_TENANT_ID"] = "11111111-1111-1111-1111-111111111111";
        env["SQLSIMCITY_EDGE_SQL_CLIENT_ID"] = "22222222-2222-2222-2222-222222222222";
        env["SQLSIMCITY_EDGE_SQL_USER_ASSIGNED_CLIENT_ID"] = "33333333-3333-3333-3333-333333333333";
        env["SQLSIMCITY_EDGE_SQL_FEDERATED_TOKEN_FILE"] = "federated-token";
        env["SQLSIMCITY_EDGE_SQL_CLIENT_SECRET_FILE"] = "client-secret";
        env["SQLSIMCITY_EDGE_SQL_CERTIFICATE_SECRET_FILE"] = "client-certificate";
        env["SQLSIMCITY_EDGE_SQL_CERTIFICATE_PASSWORD_SECRET_FILE"] = "certificate-password";
        return env;
    }
}
