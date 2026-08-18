using SqlSimCity.Contracts.V1;
using SqlSimCity.Edge.Connector;
using SqlSimCity.SqlServer;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.Edge.Tests;

/// <summary>
/// Covers <c>SQLSIMCITY_EDGE_SQL_CONNECTION_STRING</c>, the one deliberate
/// exception to the connector's "no secret ever comes from an environment
/// variable" rule. It must produce the same fully validated profile the
/// field-by-field variables do, refuse to be mixed with them, and keep every
/// existing guard -- especially "never echo a configured value" -- intact.
/// </summary>
public sealed class ConnectionStringConnectorOptionsTests
{
    private const string Password = "do-not-echo-this-secret";

    private static string OnPremises =>
        $"Server=sql.example.internal,1433;Database=appdb;User Id=collector;Password={Password};TrustServerCertificate=true";

    private static string AzureSql =>
        $"Server=tcp:contoso.database.windows.net,1433;Database=appdb;User Id=collector;Password={Password}";

    [Fact]
    public void AConnectionStringBuildsTheSameValidatedProfileAsTheIndividualFields()
    {
        var env = ConnectionStringEnvironment(OnPremises);

        var options = ConnectorOptions.FromEnvironment(env);

        Assert.Equal(ConnectorSourceMode.Connected, options.SourceMode);
        var connected = Assert.IsType<ConnectedSourceOptions>(options.Connected);
        Assert.Equal("sql.example.internal", connected.Profile.Server.Host);
        Assert.Equal(1433, connected.Profile.Server.Port);
        Assert.Equal("appdb", connected.Profile.InitialDatabase);
        Assert.True(connected.Profile.TrustServerCertificate);
        Assert.Equal("edge:target-a", connected.Profile.Id.Value);
        var login = Assert.IsType<SqlLoginAuthenticationStrategy>(connected.Profile.Authentication);
        Assert.Equal("collector", login.Username);
    }

    [Fact]
    public async Task TheConnectionStringPasswordIsServedInlineInsteadOfFromAMountedFile()
    {
        var env = ConnectionStringEnvironment(OnPremises);

        var connected = ConnectorOptions.FromEnvironment(env).Connected!;

        var secrets = Assert.IsType<InlineSecretProvider>(connected.InlineSecrets);
        using var secret = await secrets.ReadAsync(
            new SecretFileReference(ConnectionStringProfile.InlinePasswordSecretName), CancellationToken.None);
        Assert.Equal(Password, secret.UseAsUtf8Text(chars => chars.ToString()));
    }

    [Fact]
    public async Task TheInlineProviderStillRefusesEverySecretTheConnectionStringDidNotCarry()
    {
        var env = ConnectionStringEnvironment(OnPremises);

        var connected = ConnectorOptions.FromEnvironment(env).Connected!;

        await Assert.ThrowsAsync<SecretResolutionException>(() =>
            connected.InlineSecrets!.ReadAsync(
                new SecretFileReference("client-certificate"), CancellationToken.None));
    }

    [Fact]
    public void TheFieldConfiguredPathCarriesNoInlineSecretsSoMountedFilesStillApply()
    {
        var env = ConnectedEnvironment();

        Assert.Null(ConnectorOptions.FromEnvironment(env).Connected!.InlineSecrets);
    }

    [Theory]
    [InlineData("HOST", "sql.other.internal")]
    [InlineData("PORT", "1433")]
    [InlineData("INSTANCE", "SQL2022")]
    [InlineData("INITIAL_DATABASE", "appdb")]
    [InlineData("AUTH_MODE", "SqlLogin")]
    [InlineData("USERNAME", "collector")]
    [InlineData("PASSWORD_SECRET_FILE", "sql-password")]
    [InlineData("ENCRYPTION", "Mandatory")]
    [InlineData("TRUST_SERVER_CERTIFICATE", "true")]
    [InlineData("HOST_NAME_IN_CERTIFICATE", "sql.example.internal")]
    [InlineData("CONNECT_TIMEOUT_SECONDS", "15")]
    [InlineData("COMMAND_TIMEOUT_SECONDS", "30")]
    [InlineData("MIN_POOL_SIZE", "0")]
    [InlineData("MAX_POOL_SIZE", "20")]
    // Regression: these were omitted from the conflict list, so setting a
    // user-assigned identity alongside a managed-identity connection string
    // silently authenticated as the *system-assigned* identity instead.
    [InlineData("USER_ASSIGNED_CLIENT_ID", "8f2c5b4e-6a1d-4c3f-9e7b-0d5a2c8f1b3e")]
    [InlineData("TENANT_ID", "8f2c5b4e-6a1d-4c3f-9e7b-0d5a2c8f1b3e")]
    [InlineData("CLIENT_ID", "8f2c5b4e-6a1d-4c3f-9e7b-0d5a2c8f1b3e")]
    [InlineData("FEDERATED_TOKEN_FILE", "/var/run/token")]
    [InlineData("CLIENT_SECRET_FILE", "client-secret")]
    [InlineData("CERTIFICATE_SECRET_FILE", "client-cert")]
    [InlineData("CERTIFICATE_PASSWORD_SECRET_FILE", "cert-password")]
    public void MixingAConnectionStringWithAnyFieldItAlreadyCoversIsRejectedRatherThanIgnored(
        string suffix, string value)
    {
        var env = ConnectionStringEnvironment(OnPremises);
        env[$"SQLSIMCITY_EDGE_SQL_{suffix}"] = value;

        var exception = Assert.Throws<ConnectorConfigurationException>(
            () => ConnectorOptions.FromEnvironment(env));

        Assert.Contains($"SQLSIMCITY_EDGE_SQL_{suffix}", exception.Message, StringComparison.Ordinal);
        Assert.Contains("CONNECTION_STRING", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void FieldsTheConnectionStringCannotExpressStillApplyAlongsideIt()
    {
        // Collection tuning and the display name are not connection settings, so
        // they must remain configurable without forcing the long-hand path.
        var env = ConnectionStringEnvironment(OnPremises);
        env["SQLSIMCITY_EDGE_SQL_TARGET_DISPLAY_NAME"] = "Production SQL";
        env["SQLSIMCITY_EDGE_SQL_KNOWN_DATABASES"] = "appdb,reporting";
        env["SQLSIMCITY_EDGE_SQL_DATABASE_CONCURRENCY"] = "2";

        var connected = ConnectorOptions.FromEnvironment(env).Connected!;

        Assert.Equal("Production SQL", connected.TargetDisplayName);
        Assert.Equal(["appdb", "reporting"], connected.KnownDatabases);
        Assert.Equal(2, connected.Atlas.DatabaseConcurrency);
    }

    [Fact]
    public void ThePlatformIsInferredFromTheHostNameWhenOnlyAConnectionStringIsConfigured()
    {
        Assert.Equal(
            EnginePlatform.SqlServerOnPremises,
            ConnectorOptions.FromEnvironment(ConnectionStringEnvironment(OnPremises)).Connected!.Platform);
        Assert.Equal(
            EnginePlatform.AzureSqlDatabase,
            ConnectorOptions.FromEnvironment(ConnectionStringEnvironment(AzureSql)).Connected!.Platform);
    }

    [Fact]
    public void AnExplicitPlatformStillWinsOverTheInferredOne()
    {
        // Managed Instance shares the Azure SQL host suffix, so inference alone
        // could never reach it; stating the platform must remain possible.
        var env = ConnectionStringEnvironment(AzureSql);
        env["SQLSIMCITY_EDGE_SQL_PLATFORM"] = EnginePlatform.AzureSqlManagedInstance.ToString();

        Assert.Equal(
            EnginePlatform.AzureSqlManagedInstance,
            ConnectorOptions.FromEnvironment(env).Connected!.Platform);
    }

    [Fact]
    public void AnAzureSqlConnectionStringSatisfiesTheKnownDatabasesRequirementWithItsOwnDatabase()
    {
        var connected = ConnectorOptions.FromEnvironment(ConnectionStringEnvironment(AzureSql)).Connected!;

        Assert.Equal(["appdb"], connected.KnownDatabases);
    }

    [Fact]
    public void ExplicitKnownDatabasesWinOverTheAzureSqlFallback()
    {
        var env = ConnectionStringEnvironment(AzureSql);
        env["SQLSIMCITY_EDGE_SQL_KNOWN_DATABASES"] = "reporting";

        Assert.Equal(["reporting"], ConnectorOptions.FromEnvironment(env).Connected!.KnownDatabases);
    }

    [Fact]
    public void TheDisplayNameFallsBackToTheTargetIdSoOnlyOneVariableIsEverRequired()
    {
        var connected = ConnectorOptions.FromEnvironment(ConnectionStringEnvironment(OnPremises)).Connected!;

        Assert.Equal("target-a", connected.TargetDisplayName);
    }

    [Fact]
    public void AnInvalidConnectionStringIsACuratedConfigurationErrorThatNeverEchoesThePassword()
    {
        var env = ConnectionStringEnvironment(
            $"Server=sql.example.internal;Database=appdb;User Id=collector;Password={Password};Encrypt=false");

        var exception = Assert.Throws<ConnectorConfigurationException>(
            () => ConnectorOptions.FromEnvironment(env));

        Assert.Contains("SQLSIMCITY_EDGE_SQL_CONNECTION_STRING", exception.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(Password, exception.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void AnUnsupportedAuthenticationKeywordIsRejectedRatherThanSilentlyDowngraded()
    {
        var env = ConnectionStringEnvironment(
            "Server=sql.example.internal;Database=appdb;Authentication=Active Directory Default");

        var exception = Assert.Throws<ConnectorConfigurationException>(
            () => ConnectorOptions.FromEnvironment(env));

        Assert.DoesNotContain("fallback", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void PlaintextSecretVariablesAreStillRejectedAlongsideAConnectionString()
    {
        // The connection string is the *only* sanctioned inline secret; the older
        // blanket prohibition on plaintext secret variables must not be weakened.
        var env = ConnectionStringEnvironment(OnPremises);
        env["SQLSIMCITY_EDGE_SQL_CLIENT_SECRET"] = "another-secret";

        var exception = Assert.Throws<ConnectorConfigurationException>(
            () => ConnectorOptions.FromEnvironment(env));

        Assert.Contains("plaintext secret", exception.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("another-secret", exception.ToString(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void ABlankConnectionStringIsTreatedAsAbsentSoTheFieldPathStillApplies(string blank)
    {
        var env = ConnectedEnvironment();
        env["SQLSIMCITY_EDGE_SQL_CONNECTION_STRING"] = blank;

        var connected = ConnectorOptions.FromEnvironment(env).Connected!;

        Assert.Null(connected.InlineSecrets);
        Assert.Equal("sql.example.internal", connected.Profile.Server.Host);
    }

    [Fact]
    public void AConnectionStringIsIgnoredEntirelyWhileTheSourceModeIsFixture()
    {
        var env = BaseEnvironment();
        env["SQLSIMCITY_EDGE_SQL_CONNECTION_STRING"] = OnPremises;

        var options = ConnectorOptions.FromEnvironment(env);

        Assert.Equal(ConnectorSourceMode.Fixture, options.SourceMode);
        Assert.Null(options.Connected);
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

    private static Dictionary<string, string?> ConnectionStringEnvironment(string connectionString)
    {
        var env = BaseEnvironment();
        env["SQLSIMCITY_EDGE_SOURCE_MODE"] = "Connected";
        env["SQLSIMCITY_EDGE_SQL_CONNECTION_STRING"] = connectionString;
        return env;
    }

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
        return env;
    }
}
