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

        // The hardened path provisions nothing: that operator supplies
        // ProtectedStorage:Enabled themselves and still fails closed without it.
        Assert.Null(ProtectedStorageAutoProvisioning.TryProvision(configuration));
    }

    [Fact]
    public void ProvisioningEnablesProtectedStorageAndPointsAtTheDataDirectory()
    {
        var configuration = Build(("ConnectionStrings:SqlSimCity", ConnectionString));

        var provisioning = ProtectedStorageAutoProvisioning.TryProvision(configuration);

        Assert.NotNull(provisioning);
        Assert.Null(provisioning.UnavailableReason);
        Assert.Equal("true", provisioning.ConfigurationOverrides["ProtectedStorage:Enabled"]);
        Assert.Equal(
            provisioning.DataDirectory,
            provisioning.ConfigurationOverrides["ProtectedStorage:DataDirectory"]);
        Assert.True(Directory.Exists(provisioning.DataDirectory));
    }

    [Fact]
    public void ProvisioningLeavesNothingBehindInTheDataDirectory()
    {
        // The write probe proves the directory is usable before the app commits to
        // it. It must not survive that check -- a stray file in the data directory
        // would show up in every backup and every operator's listing.
        var configuration = Build(("ConnectionStrings:SqlSimCity", ConnectionString));

        var provisioning = ProtectedStorageAutoProvisioning.TryProvision(configuration);

        Assert.NotNull(provisioning);
        Assert.Empty(Directory.EnumerateFileSystemEntries(provisioning.DataDirectory));
    }

    [Fact]
    public void ProvisioningIsIdempotent()
    {
        var configuration = Build(("ConnectionStrings:SqlSimCity", ConnectionString));

        var first = ProtectedStorageAutoProvisioning.TryProvision(configuration);
        var second = ProtectedStorageAutoProvisioning.TryProvision(configuration);

        Assert.NotNull(first);
        Assert.NotNull(second);
        Assert.Null(second.UnavailableReason);
        Assert.Equal(first.DataDirectory, second.DataDirectory);
    }

    [Fact]
    public void AnOperatorWhoEnabledProtectedStorageIsLeftAlone()
    {
        var configuration = Build(
            ("ConnectionStrings:SqlSimCity", ConnectionString),
            ("ProtectedStorage:Enabled", "true"));

        Assert.Null(ProtectedStorageAutoProvisioning.TryProvision(configuration));
    }

    [Fact]
    public void TheSharedEnvironmentVariableAlsoTurnsQueryStoreOn()
    {
        var configuration = Build(("SQLSIMCITY_CONNECTION_STRING", ConnectionString));

        Assert.True(QueryStoreHistoryConfiguration.IsConnected(configuration));
    }

    [Fact]
    public void AnUnwritableDataDirectoryDisablesQueryStoreInsteadOfFailingStartup()
    {
        // Program.cs awaits EnsureReadyAsync at startup, so a data directory that
        // cannot be created at all -- an unwritable mount, or a path whose parent is
        // a file, as here -- would take the process down. Adding a convenience must
        // never stop a deployment that boots today.
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
