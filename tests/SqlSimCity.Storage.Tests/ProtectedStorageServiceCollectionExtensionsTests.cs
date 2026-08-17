using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

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
            ["ProtectedStorage:KeyFilePath"] = Path.Combine(_directory, "key.json"),
        });
        var services = new ServiceCollection();

        Assert.Throws<KeyRingConfigurationException>(() => services.AddProtectedStorage(configuration));
    }

    [Fact]
    public void EnabledWithoutKeyFilePathThrows()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ProtectedStorage:Enabled"] = "true",
            ["ProtectedStorage:DataDirectory"] = Path.Combine(_directory, "data"),
        });
        var services = new ServiceCollection();

        Assert.Throws<KeyRingConfigurationException>(() => services.AddProtectedStorage(configuration));
    }

    [Fact]
    public async Task EnabledWithMissingKeyFileFailsAtInitialization()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ProtectedStorage:Enabled"] = "true",
            ["ProtectedStorage:DataDirectory"] = Path.Combine(_directory, "data"),
            ["ProtectedStorage:KeyFilePath"] = Path.Combine(_directory, "does-not-exist.json"),
        });
        var services = new ServiceCollection();
        services.AddProtectedStorage(configuration);
        using var provider = services.BuildServiceProvider();

        // The key file isn't touched until the store is actually resolved, so
        // misconfiguration is visible as soon as a host resolves it (e.g. at
        // startup, before EnsureReadyAsync).
        await Assert.ThrowsAsync<KeyRingConfigurationException>(async () =>
        {
            var initializer = provider.GetRequiredService<IProtectedStorageInitializer>();
            await initializer.EnsureReadyAsync();
        });
    }

    [Fact]
    public async Task EnabledWithValidConfigurationRegistersAWorkingStore()
    {
        var key = KeyRingTestHelpers.NewKeyBytes();
        var keyFilePath = KeyRingTestHelpers.WriteKeyFile(_directory, activeKeyVersion: 1, (1, key));
        var dataDirectory = Path.Combine(_directory, "data");
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ProtectedStorage:Enabled"] = "true",
            ["ProtectedStorage:DataDirectory"] = dataDirectory,
            ["ProtectedStorage:KeyFilePath"] = keyFilePath,
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
}
