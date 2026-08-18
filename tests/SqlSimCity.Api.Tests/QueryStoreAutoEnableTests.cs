using Microsoft.Extensions.Configuration;

namespace SqlSimCity.Api.Tests;

/// <summary>
/// Connecting a real server used to make the query views emptier than fixture
/// mode: a connection string enabled Atlas and live incidents, but Query Store
/// history stayed on <c>UnavailableQueryStoreHistorySource</c> and returned
/// nothing, silently. These tests pin the behaviour that fixes it, and the
/// boundaries that keep the hardened path hardened.
/// </summary>
public sealed class QueryStoreAutoEnableTests : IDisposable
{
    private const string ConnectionString =
        "Server=sql01.example.internal,1433;Database=master;Integrated Security=true;TrustServerCertificate=true";

    private readonly string _root =
        Path.Combine(Path.GetTempPath(), "sqlsimcity-autoprovision-tests", Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }

    private string DataDirectory => Path.Combine(_root, "data");

    private IConfiguration Build(params (string Key, string? Value)[] values)
    {
        var settings = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
        {
            ["ProtectedStorage:DataDirectory"] = DataDirectory,
            // The shipped default, which is tmpfs under Docker.
            ["ProtectedStorage:KeyFilePath"] = "/run/secrets/sqlsimcity-storage-key",
        };

        foreach (var (key, value) in values)
        {
            settings[key] = value;
        }

        return new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
    }

    [Fact]
    public void AConnectionStringTurnsOnConnectedQueryStoreHistory()
    {
        var configuration = Build(("ConnectionStrings:SqlSimCity", ConnectionString));

        Assert.True(QueryStoreHistoryConfiguration.IsConnected(configuration));
    }

    [Fact]
    public void WithoutAnyConnectionConfigurationQueryStoreStaysOnFixtures()
    {
        var configuration = Build(("QueryStoreHistory:Mode", "Fixture"));

        Assert.False(QueryStoreHistoryConfiguration.IsConnected(configuration));
    }

    [Fact]
    public void ModeDisabledStillWinsOverAConnectionString()
    {
        var configuration = Build(
            ("ConnectionStrings:SqlSimCity", ConnectionString),
            ("QueryStoreHistory:Mode", "Disabled"));

        Assert.False(QueryStoreHistoryConfiguration.IsConnected(configuration));
        Assert.Null(ProtectedStorageAutoProvisioning.TryProvision(configuration));
    }

    [Fact]
    public void ExplicitModeConnectedStillWorksWithoutAConnectionString()
    {
        var configuration = Build(("QueryStoreHistory:Mode", "Connected"));

        Assert.True(QueryStoreHistoryConfiguration.IsConnected(configuration));

        // The hardened path provisions nothing: that operator supplies a key and
        // still fails closed without one.
        Assert.Null(ProtectedStorageAutoProvisioning.TryProvision(configuration));
    }

    [Fact]
    public void ProvisioningEnablesProtectedStorageAndCreatesAKey()
    {
        var configuration = Build(("ConnectionStrings:SqlSimCity", ConnectionString));

        var provisioning = ProtectedStorageAutoProvisioning.TryProvision(configuration);

        Assert.NotNull(provisioning);
        Assert.True(provisioning.KeyCreated);
        Assert.True(File.Exists(provisioning.KeyFilePath));
        Assert.Equal("true", provisioning.ConfigurationOverrides["ProtectedStorage:Enabled"]);
        Assert.Equal(
            provisioning.KeyFilePath,
            provisioning.ConfigurationOverrides["ProtectedStorage:KeyFilePath"]);
    }

    [Fact]
    public void TheGeneratedKeyNeverLandsInsideTheDataDirectory()
    {
        // tools/backup-data.sh refuses to take a backup at all when the key file
        // resolves inside the data directory, so generating one there would
        // silently break backups for operators who configured none of this.
        var configuration = Build(("ConnectionStrings:SqlSimCity", ConnectionString));

        var provisioning = ProtectedStorageAutoProvisioning.TryProvision(configuration);

        Assert.NotNull(provisioning);
        var data = Path.GetFullPath(DataDirectory);
        var key = Path.GetFullPath(provisioning.KeyFilePath);
        Assert.False(
            key.StartsWith(data + Path.DirectorySeparatorChar, StringComparison.Ordinal),
            $"generated key '{key}' must not live inside the data directory '{data}'");
    }

    [Fact]
    public void TheEphemeralDefaultKeyPathIsNeverUsedAsAGenerationTarget()
    {
        // Generating into /run/secrets (tmpfs) would produce a key that vanishes
        // on restart and leaves an unopenable store behind.
        var configuration = Build(("ConnectionStrings:SqlSimCity", ConnectionString));

        var provisioning = ProtectedStorageAutoProvisioning.TryProvision(configuration);

        Assert.NotNull(provisioning);
        Assert.NotEqual("/run/secrets/sqlsimcity-storage-key", provisioning.KeyFilePath);
    }

    [Fact]
    public void AnAlreadyMountedKeyIsPreferredOverGeneratingANewOne()
    {
        var mounted = Path.Combine(_root, "mounted-key.json");
        Directory.CreateDirectory(_root);
        File.WriteAllText(mounted, "{}");

        var configuration = Build(
            ("ConnectionStrings:SqlSimCity", ConnectionString),
            ("ProtectedStorage:KeyFilePath", mounted));

        var provisioning = ProtectedStorageAutoProvisioning.TryProvision(configuration);

        Assert.NotNull(provisioning);
        Assert.False(provisioning.KeyCreated);
        Assert.Equal(mounted, provisioning.KeyFilePath);
        Assert.Equal("{}", File.ReadAllText(mounted));
    }

    [Fact]
    public void AnOperatorWhoEnabledProtectedStorageKeepsFullControlOfKeyCustody()
    {
        var configuration = Build(
            ("ConnectionStrings:SqlSimCity", ConnectionString),
            ("ProtectedStorage:Enabled", "true"));

        Assert.Null(ProtectedStorageAutoProvisioning.TryProvision(configuration));
    }

    [Fact]
    public void ProvisioningTwiceReusesTheFirstKey()
    {
        var configuration = Build(("ConnectionStrings:SqlSimCity", ConnectionString));

        var first = ProtectedStorageAutoProvisioning.TryProvision(configuration);
        var second = ProtectedStorageAutoProvisioning.TryProvision(configuration);

        Assert.NotNull(first);
        Assert.NotNull(second);
        Assert.True(first.KeyCreated);
        Assert.False(second.KeyCreated);
        Assert.Equal(first.KeyFilePath, second.KeyFilePath);
    }

    [Fact]
    public void TheSharedEnvironmentVariableAlsoTurnsQueryStoreOn()
    {
        var configuration = Build(("SQLSIMCITY_CONNECTION_STRING", ConnectionString));

        Assert.True(QueryStoreHistoryConfiguration.IsConnected(configuration));
    }

    [Fact]
    public void AnUnwritableKeyLocationDisablesQueryStoreInsteadOfFailingStartup()
    {
        // The shipped container has a read-only root filesystem with only the data
        // volume writable, so the key directory beside it cannot always be created.
        // Standing in for that here with a data directory whose parent is a file:
        // creating any sibling directory is impossible, exactly as on a read-only
        // mount. Adding a convenience must never stop a deployment that boots today.
        Directory.CreateDirectory(_root);
        var blocker = Path.Combine(_root, "blocked");
        File.WriteAllText(blocker, "not a directory");

        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
            {
                ["ProtectedStorage:DataDirectory"] = Path.Combine(blocker, "data"),
                ["ConnectionStrings:SqlSimCity"] = ConnectionString,
            })
            .Build();

        var provisioning = ProtectedStorageAutoProvisioning.TryProvision(configuration);

        Assert.NotNull(provisioning);
        Assert.NotNull(provisioning!.UnavailableReason);
        Assert.False(provisioning.KeyCreated);

        // The overrides must actually leave the app in a startable state: protected
        // storage stays off, and Query Store history is off with it, because the
        // combination of the two is what Program.cs refuses to start.
        var applied = new ConfigurationBuilder()
            .AddConfiguration(configuration)
            .AddInMemoryCollection(provisioning.ConfigurationOverrides)
            .Build();

        Assert.False(QueryStoreHistoryConfiguration.IsConnected(applied));
        Assert.False(applied.GetValue<bool>("ProtectedStorage:Enabled"));
    }
}
