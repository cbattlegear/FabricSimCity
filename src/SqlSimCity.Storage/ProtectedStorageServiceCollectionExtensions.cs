using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using SqlSimCity.Storage.Crypto;
using SqlSimCity.Storage.Sqlite;

namespace SqlSimCity.Storage;

/// <summary>
/// Wires the protected storage seam into a host's DI container. When
/// <c>ProtectedStorage:Enabled</c> is <c>false</c> or absent (the default),
/// no <see cref="IProtectedRecordStore"/> is registered and nothing is
/// written to disk, so fixture-only development never needs a key. Once
/// enabled, a missing data directory or key file path fails at registration
/// time, and a missing/invalid key file fails the first time the store is
/// resolved -- both before the host can serve traffic if the host awaits
/// <see cref="IProtectedStorageInitializer.EnsureReadyAsync"/> at startup.
/// </summary>
public static class ProtectedStorageServiceCollectionExtensions
{
    public static IServiceCollection AddProtectedStorage(
        this IServiceCollection services,
        IConfiguration configuration,
        string sectionName = ProtectedStorageOptions.SectionName)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        var options = new ProtectedStorageOptions();
        configuration.GetSection(sectionName).Bind(options);

        services.AddSingleton(TimeProvider.System);

        if (!options.Enabled)
        {
            return services;
        }

        if (string.IsNullOrWhiteSpace(options.DataDirectory))
        {
            throw new KeyRingConfigurationException(
                $"{sectionName}:{nameof(ProtectedStorageOptions.DataDirectory)} must be configured when protected storage is enabled.");
        }

        if (string.IsNullOrWhiteSpace(options.KeyFilePath))
        {
            throw new KeyRingConfigurationException(
                $"{sectionName}:{nameof(ProtectedStorageOptions.KeyFilePath)} must be configured when protected storage is enabled.");
        }

        options.ValidateForEnabledStorage(sectionName);
        services.AddSingleton(options.Retention);
        services.AddSingleton(sp =>
        {
            var keyRing = KeyRingLoader.Load(options.KeyFilePath);
            var timeProvider = sp.GetRequiredService<TimeProvider>();
            var retention = sp.GetRequiredService<RetentionOptions>();
            return CreateStore(options, keyRing, retention, timeProvider);
        });
        services.AddSingleton<IProtectedRecordStore>(sp => sp.GetRequiredService<SqliteProtectedRecordStore>());
        services.AddSingleton<IProtectedStorageInitializer>(sp => sp.GetRequiredService<SqliteProtectedRecordStore>());

        return services;
    }

    internal static SqliteProtectedRecordStore CreateStore(
        ProtectedStorageOptions options,
        KeyRing keyRing,
        RetentionOptions retention,
        TimeProvider timeProvider)
    {
        try
        {
            return new SqliteProtectedRecordStore(
                options.DataDirectory!, options.DatabaseFileName, keyRing, retention, timeProvider,
                options.MaxRecordKindLength, options.MaxPayloadBytes);
        }
        catch
        {
            keyRing.Dispose();
            throw;
        }
    }
}
