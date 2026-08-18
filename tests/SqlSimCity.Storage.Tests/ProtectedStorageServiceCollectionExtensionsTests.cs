using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using SqlSimCity.Storage.Crypto;

namespace SqlSimCity.Storage.Tests;

public sealed class ProtectedStorageServiceCollectionExtensionsTests : IDisposable
{
    private readonly string _directory =
        Path.Combine(Path.GetTempPath(), "sqlsimcity-storage-tests", Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_directory))
        {
            Directory.Delete(_directory, recursive: true);
        }
    }

    private static IConfiguration BuildConfiguration(Dictionary<string, string?> values) =>
        new ConfigurationBuilder().AddInMemoryCollection(values).Build();

    [Fact]
    public void DisabledModeRegistersNoStoreAndCreatesNothingOnDisk()
    {
        var dataDirectory = Path.Combine(_directory, "data");
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ProtectedStorage:Enabled"] = "false",
            ["ProtectedStorage:DataDirectory"] = dataDirectory,
        });
        var services = new ServiceCollection();

        services.AddProtectedStorage(configuration);
        using var provider = services.BuildServiceProvider();

        Assert.Null(provider.GetService<IProtectedRecordStore>());
        Assert.Null(provider.GetService<IProtectedStorageInitializer>());
        Assert.False(Directory.Exists(dataDirectory));
    }

    [Fact]
    public void AbsentSectionDefaultsToDisabled()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>());
        var services = new ServiceCollection();

        services.AddProtectedStorage(configuration);
        using var provider = services.BuildServiceProvider();

        Assert.Null(provider.GetService<IProtectedRecordStore>());
    }

    [Fact]
    public void EnabledWithoutDataDirectoryThrows()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ProtectedStorage:Enabled"] = "true",
        });
        var services = new ServiceCollection();

        Assert.Throws<ProtectedStorageConfigurationException>(() => services.AddProtectedStorage(configuration));
    }

    [Fact]
    public async Task EnabledWithAnUnusableDataDirectoryFailsAtInitialization()
    {
        Directory.CreateDirectory(_directory);
        var blockingFile = Path.Combine(_directory, "not-a-directory");
        await File.WriteAllTextAsync(blockingFile, "fixture");
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ProtectedStorage:Enabled"] = "true",
            ["ProtectedStorage:DataDirectory"] = Path.Combine(blockingFile, "data"),
        });
        var services = new ServiceCollection();
        services.AddProtectedStorage(configuration);
        using var provider = services.BuildServiceProvider();

        // The directory isn't touched until the store is actually resolved, so
        // misconfiguration is visible as soon as a host resolves it (e.g. at
        // startup, before EnsureReadyAsync) rather than as silent data loss later.
        await Assert.ThrowsAnyAsync<IOException>(async () =>
        {
            var initializer = provider.GetRequiredService<IProtectedStorageInitializer>();
            await initializer.EnsureReadyAsync();
        });
    }

    [Fact]
    public async Task EnabledWithValidConfigurationRegistersAWorkingStore()
    {
        var dataDirectory = Path.Combine(_directory, "data");
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ProtectedStorage:Enabled"] = "true",
            ["ProtectedStorage:DataDirectory"] = dataDirectory,
        });
        var services = new ServiceCollection();
        services.AddProtectedStorage(configuration);
        using var provider = services.BuildServiceProvider();

        var initializer = provider.GetRequiredService<IProtectedStorageInitializer>();
        await initializer.EnsureReadyAsync();
        var store = provider.GetRequiredService<IProtectedRecordStore>();
        await store.PutAsync("record-1", "kind", DateTimeOffset.UtcNow, StorageResolution.Detail, "payload"u8.ToArray());

        var result = await store.GetAsync("record-1");

        Assert.NotNull(result);
        Assert.True(Directory.Exists(dataDirectory));
    }

    [Theory]
    [InlineData("nested\\protected-storage.db")]
    [InlineData("../protected-storage.db")]
    [InlineData("..")]
    [InlineData("C:protected-storage.db")]
    public void EnabledWithUnsafeDatabaseFileNameThrows(string databaseFileName)
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ProtectedStorage:Enabled"] = "true",
            ["ProtectedStorage:DataDirectory"] = Path.Combine(_directory, "data"),
            ["ProtectedStorage:DatabaseFileName"] = databaseFileName,
        });

        var ex = Assert.Throws<ProtectedStorageConfigurationException>(() => new ServiceCollection().AddProtectedStorage(configuration));

        Assert.DoesNotContain(_directory, ex.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("00:00:00", "1.00:00:00", "1")]
    [InlineData("2.00:00:00", "1.00:00:00", "1")]
    [InlineData("1.00:00:00", "2.00:00:00", "0")]
    [InlineData("1.00:00:00", "2.00:00:00", "501")]
    public void EnabledWithInvalidRetentionThrows(string detail, string hourly, string batchSize)
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ProtectedStorage:Enabled"] = "true",
            ["ProtectedStorage:DataDirectory"] = Path.Combine(_directory, "data"),
            ["ProtectedStorage:Retention:DetailRetention"] = detail,
            ["ProtectedStorage:Retention:HourlyRollupRetention"] = hourly,
            ["ProtectedStorage:Retention:PruneBatchSize"] = batchSize,
        });

        Assert.Throws<ProtectedStorageConfigurationException>(() => new ServiceCollection().AddProtectedStorage(configuration));
    }

    [Fact]
    public void EnabledAcceptsConfiguredStorageLimitsAtBoundaries()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ProtectedStorage:Enabled"] = "true",
            ["ProtectedStorage:DataDirectory"] = Path.Combine(_directory, "data"),
            ["ProtectedStorage:MaxRecordKindLength"] = "1",
            ["ProtectedStorage:MaxPayloadBytes"] = "1",
            ["ProtectedStorage:Retention:PruneBatchSize"] = "500",
        });

        new ServiceCollection().AddProtectedStorage(configuration);
    }

    [Theory]
    [InlineData("0", "1")]
    [InlineData("1025", "1")]
    [InlineData("1", "0")]
    [InlineData("1", "16777217")]
    public void EnabledRejectsStorageLimitsOutsideDocumentedBounds(string recordKindLimit, string payloadLimit)
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ProtectedStorage:Enabled"] = "true",
            ["ProtectedStorage:DataDirectory"] = Path.Combine(_directory, "data"),
            ["ProtectedStorage:MaxRecordKindLength"] = recordKindLimit,
            ["ProtectedStorage:MaxPayloadBytes"] = payloadLimit,
        });

        Assert.Throws<ProtectedStorageConfigurationException>(() => new ServiceCollection().AddProtectedStorage(configuration));
    }

    [Fact]
    public void StoreConstructionSurfacesAnUnusableDataDirectory()
    {
        Directory.CreateDirectory(_directory);
        var blockingFile = Path.Combine(_directory, "not-a-directory");
        File.WriteAllText(blockingFile, "fixture");
        var options = new ProtectedStorageOptions
        {
            Enabled = true,
            DataDirectory = Path.Combine(blockingFile, "data"),
        };

        Assert.ThrowsAny<IOException>(() =>
            ProtectedStorageServiceCollectionExtensions.CreateStore(
                options, options.Retention, TimeProvider.System));
    }
}
