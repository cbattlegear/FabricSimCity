using SqlSimCity.Archive;
using SqlSimCity.Domain;

namespace SqlSimCity.Api;

internal static class ArchiveServices
{
    public static bool IsArchiveMode(IConfiguration configuration)
    {
        var mode = configuration["Acquisition:Mode"] ?? "Fixture";
        if (string.Equals(mode, "Archive", StringComparison.OrdinalIgnoreCase))
            return true;
        if (string.Equals(mode, "Fixture", StringComparison.OrdinalIgnoreCase))
            return false;
        throw new ArchiveValidationException("Acquisition:Mode must be Fixture or Archive.");
    }

    public static ArchiveSource AddArchiveSource(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        var options = new ArchiveSourceOptions(
            configuration["Acquisition:Archive:AllowedDirectory"]
                ?? throw new ArchiveValidationException("Acquisition:Archive:AllowedDirectory is required."),
            configuration["Acquisition:Archive:FileName"]
                ?? throw new ArchiveValidationException("Acquisition:Archive:FileName is required."),
            configuration.GetValue<long?>("Acquisition:Archive:MaximumArchiveBytes")
                ?? 256L * 1024 * 1024);
        var source = ArchiveSource.Open(options);
        services.AddSingleton(source);
        services.AddSingleton<IAtlasSnapshotSource>(source);
        services.AddSingleton<IAtlasCollectorStatusSource>(source);
        services.AddSingleton<ICapabilitiesSource>(source);
        services.AddSingleton<IQueryStoreHistorySource>(source);
        services.AddSingleton<IDatabaseCitySource>(source);
        services.AddSingleton<ILiveIncidentResponseSource>(source);
        return source;
    }

    public static void MapArchiveInfo(this WebApplication app)
    {
        app.MapGet("/api/v1/archive", (ArchiveSource source, HttpContext context) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            return Results.Ok(source.Info);
        });
    }
}
