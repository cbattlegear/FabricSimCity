using System.Text.Json.Serialization;
using Microsoft.AspNetCore.SignalR;
using SqlSimCity.Api;
using SqlSimCity.Collection.Atlas;
using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Domain;
using SqlSimCity.SqlServer;
using SqlSimCity.SqlServer.Secrets;
using SqlSimCity.Storage;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    WebRootPath = WebRootResolver.Resolve(AppContext.BaseDirectory),
});

var probeCatalog = ApplicationInitialization.LoadProbeCatalog();
var capabilitiesSource = await FixtureCapabilitiesSource.CreateAsync(
    cancellationToken: CancellationToken.None);

builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));
builder.Services.AddSignalR().AddJsonProtocol(options =>
    options.PayloadSerializerOptions.Converters.Add(new JsonStringEnumConverter()));
builder.Services.AddSingleton(probeCatalog);
builder.Services.AddSingleton<ICapabilitiesSource>(capabilitiesSource);
builder.Services.AddProtectedStorage(builder.Configuration);

// LiveIncidents:Mode defaults to Fixture (no credentials); Connected opts a real
// SqlConnectionFactory-backed collector in and fails closed before the host serves traffic.
builder.Services.AddLiveIncidents(builder.Configuration, probeCatalog);
builder.Services.AddSingleton<LiveIncidentSamplerService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<LiveIncidentSamplerService>());

if (AtlasConfiguration.IsConnected(builder.Configuration))
{
    var atlasOptions = AtlasConfiguration.BuildCollectionOptions(builder.Configuration);
    var connectionProfile = AtlasConfiguration.BuildProfile(builder.Configuration);
    builder.Services.AddSingleton(atlasOptions);
    builder.Services.AddSingleton(connectionProfile);
    builder.Services.AddSingleton(TimeProvider.System);
    builder.Services.AddSingleton(new FileSecretFileProvider(AtlasConfiguration.BuildSecretOptions(builder.Configuration)));
    builder.Services.AddSingleton<ISqlConnectionFactory>(services =>
        new SqlConnectionFactory(services.GetRequiredService<FileSecretFileProvider>()));
    builder.Services.AddSingleton<IAtlasProbeExecutor, SqlClientAtlasProbeExecutor>();
    builder.Services.AddSingleton<ILiveAtlasActivitySource>(services =>
        new LiveIncidentAtlasActivitySource(
            () => services.GetRequiredService<LiveIncidentSamplerService>().GetCurrentResponse(),
            atlasOptions.TargetId));
    builder.Services.AddSingleton<AtlasCollector>();
    builder.Services.AddSingleton<IReconnectJitter, RandomReconnectJitter>();
    builder.Services.AddSingleton<IReconnectBackoff>(services =>
        new ExponentialReconnectBackoff(
            TimeSpan.FromSeconds(5), TimeSpan.FromMinutes(5),
            services.GetRequiredService<IReconnectJitter>()));
    builder.Services.AddSingleton<AtlasRefreshCoordinator>();
    builder.Services.AddSingleton<ConnectedAtlasSource>();
    builder.Services.AddSingleton<IAtlasSnapshotSource>(services => services.GetRequiredService<ConnectedAtlasSource>());
    builder.Services.AddSingleton<IAtlasCollectorStatusSource>(services => services.GetRequiredService<ConnectedAtlasSource>());
    builder.Services.AddHostedService<AtlasRefreshBackgroundService>();
}
else
{
    builder.Services.AddSingleton<FixtureAtlasSnapshotSource>();
    builder.Services.AddSingleton<IAtlasSnapshotSource>(services => services.GetRequiredService<FixtureAtlasSnapshotSource>());
    builder.Services.AddSingleton<IAtlasCollectorStatusSource>(services => services.GetRequiredService<FixtureAtlasSnapshotSource>());
}

var app = builder.Build();

// Protected storage is opt-in and fails closed: when enabled, a missing/invalid
// key, corrupt canary, or migration error must stop the process before it
// serves traffic rather than silently falling back to an unencrypted store.
var protectedStorageInitializer = app.Services.GetService<IProtectedStorageInitializer>();
if (protectedStorageInitializer is not null)
{
    await protectedStorageInitializer.EnsureReadyAsync(app.Lifetime.ApplicationStopping);
}

app.Use(async (context, next) =>
{
    context.Response.Headers.ContentSecurityPolicy =
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; " +
        "font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; " +
        "base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
    context.Response.Headers.XContentTypeOptions = "nosniff";
    context.Response.Headers.XFrameOptions = "DENY";
    context.Response.Headers["Referrer-Policy"] = "no-referrer";
    context.Response.Headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
    context.Response.Headers["Cross-Origin-Opener-Policy"] = "same-origin";
    await next();
});

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/healthz", () => Results.Ok(new { status = "healthy" }));
app.MapGet("/readyz", () => Results.Ok(new { status = "ready" }));
app.MapGet("/api/v1/atlas", (IAtlasSnapshotSource source, HttpContext context) =>
{
    context.Response.Headers.CacheControl = "no-store";
    return Results.Ok(source.GetCurrent());
});
app.MapGet("/api/v1/atlas/status", (IAtlasCollectorStatusSource source, HttpContext context) =>
{
    context.Response.Headers.CacheControl = "no-store";
    return Results.Ok(source.GetStatus());
});
app.MapGet("/api/v1/capabilities", (ICapabilitiesSource source, HttpContext context) =>
{
    context.Response.Headers.CacheControl = "no-store";
    return Results.Ok(source.GetCurrent());
});
app.MapGet("/api/v1/live", (LiveIncidentSamplerService sampler, HttpContext context) =>
{
    context.Response.Headers.CacheControl = "no-store";
    return Results.Ok(sampler.GetCurrentResponse());
});
app.MapHub<CurrentSnapshotHub>("/hubs/current-snapshot");
app.MapFallbackToFile("index.html");

app.Run();
