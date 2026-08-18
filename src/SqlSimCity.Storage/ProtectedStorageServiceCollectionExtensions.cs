using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using SqlSimCity.Storage.Sqlite;

namespace SqlSimCity.Storage;

/// <summary>
/// Wires the protected storage seam into a host's DI container. When
/// <c>ProtectedStorage:Enabled</c> is <c>false</c> or absent (the default),
/// no <see cref="IProtectedRecordStore"/> is registered and nothing is
/// written to disk. Once enabled, a missing data directory fails at
/// registration time, and an unusable store fails the first time it is
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
            throw new ProtectedStorageConfigurationException(
                $"{sectionName}:{nameof(ProtectedStorageOptions.DataDirectory)} must be configured when protected storage is enabled.");
        }

        options.ValidateForEnabledStorage(sectionName);
        services.AddSingleton(options.Retention);
        services.AddSingleton(sp =>
        {
            var timeProvider = sp.GetRequiredService<TimeProvider>();
            var retention = sp.GetRequiredService<RetentionOptions>();
            return CreateStore(options, retention, timeProvider);
        });
        services.AddSingleton<IProtectedRecordStore>(sp => sp.GetRequiredService<SqliteProtectedRecordStore>());
        services.AddSingleton<IProtectedStorageInitializer>(sp => sp.GetRequiredService<SqliteProtectedRecordStore>());

        return services;
    }

    internal static SqliteProtectedRecordStore CreateStore(
        ProtectedStorageOptions options,
        RetentionOptions retention,
        TimeProvider timeProvider) =>
        new(options.DataDirectory!, options.DatabaseFileName, retention, timeProvider,
            options.MaxRecordKindLength, options.MaxPayloadBytes);
}
