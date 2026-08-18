using System.Text;
using SqlSimCity.SqlServer.Auth;
using SqlSimCity.SqlServer.Secrets;

namespace SqlSimCity.SqlServer.Tests;

public class ConnectionStringProfileTests
{
    private static ConnectionStringProfile Parse(string connectionString) =>
        ConnectionStringProfile.Parse(connectionString, new ConnectionProfileId("test"));

    [Fact]
    public void ParseMapsHostPortDatabaseAndSqlLogin()
    {
        var parsed = Parse("Server=sql01.example.com,14330;Database=Sales;User Id=reader;Password=p@ss;");

        Assert.Equal("sql01.example.com", parsed.Profile.Server.Host);
        Assert.Equal(14330, parsed.Profile.Server.Port);
        Assert.Null(parsed.Profile.Server.InstanceName);
        Assert.Equal("Sales", parsed.Profile.InitialDatabase);
        var sqlLogin = Assert.IsType<SqlLoginAuthenticationStrategy>(parsed.Profile.Authentication);
        Assert.Equal("reader", sqlLogin.Username);
        Assert.Equal(ConnectionStringProfile.InlinePasswordSecretName, sqlLogin.PasswordSecretReference.FileName);
        Assert.NotNull(parsed.InlineSecrets);
    }

    [Fact]
    public async Task ParseResolvesTheInlinePasswordThroughTheSecretProvider()
    {
        var parsed = Parse("Server=localhost;User Id=reader;Password=s3cr3t;TrustServerCertificate=true");

        using var secret = await parsed.InlineSecrets!.ReadAsync(
            new SecretFileReference(ConnectionStringProfile.InlinePasswordSecretName),
            CancellationToken.None);

        Assert.Equal("s3cr3t", Encoding.UTF8.GetString(secret.Span));
    }

    [Fact]
    public async Task InlineSecretsRejectEveryOtherReference()
    {
        var parsed = Parse("Server=localhost;User Id=reader;Password=s3cr3t;TrustServerCertificate=true");

        await Assert.ThrowsAsync<SecretResolutionException>(() => parsed.InlineSecrets!.ReadAsync(
            new SecretFileReference("some-other-secret"),
            CancellationToken.None));
    }

    [Fact]
    public async Task InlineSecretsSurviveACallerDisposingWhatItRead()
    {
        var parsed = Parse("Server=localhost;User Id=reader;Password=s3cr3t;TrustServerCertificate=true");
        var reference = new SecretFileReference(ConnectionStringProfile.InlinePasswordSecretName);

        using (var first = await parsed.InlineSecrets!.ReadAsync(reference, CancellationToken.None))
        {
            Assert.Equal("s3cr3t", Encoding.UTF8.GetString(first.Span));
        }

        using var second = await parsed.InlineSecrets!.ReadAsync(reference, CancellationToken.None);
        Assert.Equal("s3cr3t", Encoding.UTF8.GetString(second.Span));
    }

    [Theory]
    [InlineData("Server=tcp:sql01.example.com,1433;", "sql01.example.com", 1433)]
    [InlineData("Server=TCP:sql01.example.com,1433;", "sql01.example.com", 1433)]
    [InlineData("Data Source=sql01.example.com,1433;", "sql01.example.com", 1433)]
    public void ParseStripsTheNetworkLibraryPrefixAndPort(string dataSource, string host, int port)
    {
        var parsed = Parse($"{dataSource}User Id=reader;Password=p;");

        Assert.Equal(host, parsed.Profile.Server.Host);
        Assert.Equal(port, parsed.Profile.Server.Port);
    }

    [Fact]
    public void ParseReadsANamedInstance()
    {
        var parsed = Parse("Server=sql01\\SQLEXPRESS;User Id=reader;Password=p;");

        Assert.Equal("sql01", parsed.Profile.Server.Host);
        Assert.Equal("SQLEXPRESS", parsed.Profile.Server.InstanceName);
        Assert.Null(parsed.Profile.Server.Port);
    }

    [Fact]
    public void ParseRejectsAnInstanceAndPortTogether()
    {
        var ex = Assert.Throws<ConnectionProfileValidationException>(
            () => Parse("Server=sql01\\SQLEXPRESS,1433;User Id=reader;Password=p;"));

        Assert.Contains("exactly one", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ParseDefaultsTheDatabaseToMaster()
    {
        var parsed = Parse("Server=sql01;User Id=reader;Password=p;");

        Assert.Equal("master", parsed.Profile.InitialDatabase);
    }

    [Fact]
    public void ParseDefaultsToMandatoryEncryptionAndTheProfileDefaults()
    {
        var parsed = Parse("Server=sql01;User Id=reader;Password=p;");

        Assert.Equal(EncryptionPolicy.Mandatory, parsed.Profile.Encryption);
        Assert.False(parsed.Profile.TrustServerCertificate);
        Assert.Null(parsed.Profile.HostNameInCertificate);
    }

    [Fact]
    public void ParseMapsStrictEncryptionAndCertificateSettings()
    {
        var parsed = Parse(
            "Server=sql01;User Id=reader;Password=p;Encrypt=strict;HostNameInCertificate=sql01.example.com");

        Assert.Equal(EncryptionPolicy.Strict, parsed.Profile.Encryption);
        Assert.Equal("sql01.example.com", parsed.Profile.HostNameInCertificate);
    }

    [Fact]
    public void ParseMapsTrustServerCertificate()
    {
        var parsed = Parse("Server=sql01;User Id=reader;Password=p;TrustServerCertificate=true");

        Assert.True(parsed.Profile.TrustServerCertificate);
    }

    [Fact]
    public void ParseRejectsOptionalEncryption()
    {
        var ex = Assert.Throws<ConnectionProfileValidationException>(
            () => Parse("Server=sql01;User Id=reader;Password=p;Encrypt=false"));

        Assert.Contains("Encrypt=false is not supported", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ParseMapsTimeoutsAndPoolBounds()
    {
        var parsed = Parse(
            "Server=sql01;User Id=reader;Password=p;Connect Timeout=25;Command Timeout=45;Min Pool Size=2;Max Pool Size=9");

        Assert.Equal(25, parsed.Profile.Timeouts.ConnectTimeoutSeconds);
        Assert.Equal(45, parsed.Profile.Timeouts.CommandTimeoutSeconds);
        Assert.Equal(2, parsed.Profile.Pool.MinPoolSize);
        Assert.Equal(9, parsed.Profile.Pool.MaxPoolSize);
    }

    [Theory]
    [InlineData("Connect Timeout=0")]
    [InlineData("Command Timeout=0")]
    public void ParseRejectsInfiniteTimeouts(string setting)
    {
        var ex = Assert.Throws<ConnectionProfileValidationException>(
            () => Parse($"Server=sql01;User Id=reader;Password=p;{setting}"));

        Assert.Contains("infinite", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ParseMapsIntegratedSecurityToKerberos()
    {
        var parsed = Parse("Server=sql01;Integrated Security=true;");

        Assert.IsType<KerberosAuthenticationStrategy>(parsed.Profile.Authentication);
        Assert.Null(parsed.InlineSecrets);
    }

    [Fact]
    public void ParseMapsSystemAssignedManagedIdentity()
    {
        var parsed = Parse(
            "Server=tenant.database.windows.net;Database=Sales;Authentication=Active Directory Managed Identity;");

        var managedIdentity = Assert.IsType<ManagedIdentityAuthenticationStrategy>(parsed.Profile.Authentication);
        Assert.Null(managedIdentity.UserAssignedClientId);
        Assert.Null(parsed.InlineSecrets);
    }

    [Fact]
    public void ParseMapsUserAssignedManagedIdentityFromUserId()
    {
        const string clientId = "11111111-2222-3333-4444-555555555555";
        var parsed = Parse(
            $"Server=tenant.database.windows.net;Authentication=Active Directory Managed Identity;User Id={clientId}");

        var managedIdentity = Assert.IsType<ManagedIdentityAuthenticationStrategy>(parsed.Profile.Authentication);
        Assert.Equal(Guid.Parse(clientId), managedIdentity.UserAssignedClientId);
    }

    [Fact]
    public void ParseRejectsEntraStrategiesAConnectionStringCannotFullyDescribe()
    {
        var ex = Assert.Throws<ConnectionProfileValidationException>(
            () => Parse("Server=sql01;Authentication=Active Directory Service Principal;User Id=app;Password=p"));

        Assert.Contains("cannot be configured by connection string alone", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ParseRejectsDefaultAzureCredentialStyleAuthentication()
    {
        Assert.Throws<ConnectionProfileValidationException>(
            () => Parse("Server=sql01;Authentication=Active Directory Default"));
    }

    [Fact]
    public void ParseRequiresAnAuthenticationMethod()
    {
        var ex = Assert.Throws<ConnectionProfileValidationException>(() => Parse("Server=sql01;Database=Sales"));

        Assert.Contains("must select an authentication method", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ParseRequiresAPasswordAlongsideAUserId()
    {
        var ex = Assert.Throws<ConnectionProfileValidationException>(
            () => Parse("Server=sql01;User Id=reader"));

        Assert.Contains("no Password", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ParseRequiresAServer()
    {
        var ex = Assert.Throws<ConnectionProfileValidationException>(
            () => Parse("Database=Sales;User Id=reader;Password=p"));

        Assert.Contains("must set Server", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ParseRejectsAnUnknownKeyword()
    {
        Assert.Throws<ConnectionProfileValidationException>(
            () => Parse("Server=sql01;Nonsense=1;User Id=reader;Password=p"));
    }

    [Theory]
    [InlineData("tenant.database.windows.net", true)]
    [InlineData("TENANT.DATABASE.WINDOWS.NET", true)]
    [InlineData("sql01.internal.example.com", false)]
    [InlineData("localhost", false)]
    public void ParseFlagsAzureSqlHostsForPlatformDefaulting(string host, bool expected)
    {
        var parsed = Parse($"Server={host};User Id=reader;Password=p");

        Assert.Equal(expected, parsed.IsAzureSqlHost);
    }

    [Fact]
    public void ParsedProfilesNeverCarryThePasswordIntoTheBuiltConnectionString()
    {
        var parsed = Parse("Server=sql01;Database=Sales;User Id=reader;Password=sup3rs3cret;");

        var built = SqlConnectionFactory.BuildConnectionStringBuilder(parsed.Profile).ConnectionString;

        Assert.DoesNotContain("sup3rs3cret", built, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Application Name=SQLSimCity", built, StringComparison.Ordinal);
        Assert.Contains("Application Intent=ReadOnly", built, StringComparison.Ordinal);
    }

    [Fact]
    public void ParsedProfilesAreRedactedByTheSafeSettingsProjection()
    {
        var parsed = Parse("Server=sql01;Database=Sales;User Id=reader;Password=sup3rs3cret;");

        var safe = SafeConnectionSettings.From(parsed.Profile);

        Assert.Equal("reader", safe.SqlLoginUsername);
        Assert.DoesNotContain("sup3rs3cret", safe.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    // A non-numeric value for a numeric keyword: SqlClient's own FormatException
    // is "The input string 'sup3rs3cret' was not in a correct format."
    [InlineData("Server=sql01;Connect Timeout=sup3rs3cret")]
    [InlineData("Server=sql01;Max Pool Size=sup3rs3cret")]
    // An unquoted ';' then '=' inside a password splits it, and the trailing
    // fragment resurfaces as "Keyword not supported: '<fragment>'".
    [InlineData("Server=sql01;User Id=reader;Password=p@ss;sup3rs3cret=1")]
    // An unquoted quote character stops the parser mid-value.
    [InlineData("Server=sql01;User Id=reader;Password='sup3rs3cret")]
    [InlineData("Server=sql01;User Id=reader;Password=\"sup3rs3cret")]
    [InlineData("Server=sql01;sup3rs3cret=1")]
    public void ParseFailuresNeverRelaySqlClientsOwnMessageBecauseItCanQuoteTheOffendingValue(
        string connectionString)
    {
        // SqlClient's parse errors are not uniformly value-free, so this parser
        // must substitute a curated message and must not chain the inner
        // exception -- otherwise a logged ToString() would republish the value.
        var exception = Assert.Throws<ConnectionProfileValidationException>(() => Parse(connectionString));

        Assert.DoesNotContain("sup3rs3cret", exception.ToString(), StringComparison.OrdinalIgnoreCase);
        Assert.Null(exception.InnerException);
    }

    [Theory]
    [InlineData("admin:")]
    [InlineData("ADMIN:")]
    [InlineData("lpc:")]
    [InlineData("np:")]
    public void ParseRejectsNetworkLibraryPrefixesItCannotHonor(string prefix)
    {
        // Regression: these were previously stripped, so "Server=admin:sqlhost"
        // silently became an ordinary connection to a different endpoint than the
        // dedicated administrator connection the operator asked for.
        var ex = Assert.Throws<ConnectionProfileValidationException>(
            () => Parse($"Server={prefix}sqlhost;User Id=reader;Password=p;TrustServerCertificate=true"));

        Assert.Contains("network library prefix", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ParseStillAcceptsTheTcpPrefixItCanRebuild()
    {
        var parsed = Parse("Server=tcp:sql01.example.com,1433;User Id=reader;Password=p");

        Assert.Equal("sql01.example.com", parsed.Profile.Server.Host);
        Assert.Equal(1433, parsed.Profile.Server.Port);
    }

    [Fact]
    public void ParseDefaultsMaxPoolSizeToTheFieldConfiguredCeiling()
    {
        // Regression: SqlClient's own default is 100, five times what every
        // field-configured path allows.
        var parsed = Parse("Server=sql01;User Id=reader;Password=p");

        Assert.Equal(20, parsed.Profile.Pool.MaxPoolSize);
        Assert.Equal(0, parsed.Profile.Pool.MinPoolSize);
    }

    [Fact]
    public void ParseHonorsAnExplicitMaxPoolSize()
    {
        var parsed = Parse("Server=sql01;User Id=reader;Password=p;Max Pool Size=7;Min Pool Size=2");

        Assert.Equal(7, parsed.Profile.Pool.MaxPoolSize);
        Assert.Equal(2, parsed.Profile.Pool.MinPoolSize);
    }

    [Fact]
    public void ParseHonorsAnExplicitMaxPoolSizeThatMatchesSqlClientsDefault()
    {
        var parsed = Parse("Server=sql01;User Id=reader;Password=p;Max Pool Size=100");

        Assert.Equal(100, parsed.Profile.Pool.MaxPoolSize);
    }

    [Fact]
    public void ParseNormalizesAnInvalidManagedIdentityClientIdToAValidationError()
    {
        // Regression: this surfaced as an AuthenticationConfigurationException that
        // escaped every caller's curated configuration handler, costing the edge
        // connector its EX_CONFIG exit code.
        var ex = Assert.Throws<ConnectionProfileValidationException>(
            () => Parse("Server=sql01;Authentication=Active Directory Managed Identity;User Id=not-a-guid"));

        Assert.Contains("authentication settings are invalid", ex.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("not-a-guid", ex.Message, StringComparison.OrdinalIgnoreCase);
    }
}