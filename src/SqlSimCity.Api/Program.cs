using System.Text.Json.Serialization;
using Microsoft.AspNetCore.SignalR;
using SqlSimCity.Api;
using SqlSimCity.Collection.Atlas;
using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Collection.DatabaseCity;
using SqlSimCity.Collection.QueryStore;
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
var acquisitionMode = ArchiveServices.GetAcquisitionMode(builder.Configuration);
var archiveMode = acquisitionMode == AcquisitionMode.Archive;
var edgeMode = acquisitionMode == AcquisitionMode.Edge;

builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));
builder.Services.AddSignalR().AddJsonProtocol(options =>
    options.PayloadSerializerOptions.Converters.Add(new JsonStringEnumConverter()));
builder.Services.AddSingleton(probeCatalog);
builder.Services.AddProtectedStorage(builder.Configuration);
var queryStoreConnected = QueryStoreHistoryConfiguration.IsConnected(builder.Configuration);
var atlasConnected = AtlasConfiguration.IsConnected(builder.Configuration);
var liveConnected = string.Equals(
    builder.Configuration["LiveIncidents:Mode"], "Connected", StringComparison.OrdinalIgnoreCase);
var edgeIngestionEnabled = builder.Configuration.GetValue<bool>("EdgeIngestion:Enabled");
var protectedStorageEnabled = builder.Configuration.GetValue<bool>("ProtectedStorage:Enabled");
if (archiveMode && (
        queryStoreConnected ||
        atlasConnected ||
        liveConnected ||
        edgeIngestionEnabled ||
        protectedStorageEnabled))
    throw new InvalidOperationException(
        "Acquisition:Mode=Archive cannot be combined with connected Atlas, Query Store, live incidents, edge ingestion, or protected storage.");
if (edgeMode && (!edgeIngestionEnabled || queryStoreConnected || atlasConnected || liveConnected || protectedStorageEnabled))
    throw new InvalidOperationException(
        "Acquisition:Mode=Edge requires edge ingestion and cannot be combined with connected Atlas, Query Store, live incidents, or protected storage.");
if (!edgeMode && edgeIngestionEnabled)
    throw new InvalidOperationException("Edge ingestion may be enabled only when Acquisition:Mode=Edge.");
if (queryStoreConnected && !atlasConnected)
    throw new InvalidOperationException("Connected Query Store history requires Atlas:Mode=Connected so both share one validated profile and authentication strategy.");
if (queryStoreConnected && !builder.Configuration.GetValue<bool>("ProtectedStorage:Enabled"))
    throw new InvalidOperationException("Connected Query Store history requires ProtectedStorage:Enabled=true; plaintext fallback is forbidden.");

builder.Services.AddSqlSimCityHttpSecurity(builder.Configuration);
builder.Services.AddEdgeIngestion(builder.Configuration);

if (archiveMode)
{
    builder.Services.AddArchiveSource(builder.Configuration);
}
else if (edgeMode)
{
    builder.Services.AddEdgeAcquisitionSource(builder.Configuration);
}
else
{
    var capabilitiesSource = await FixtureCapabilitiesSource.CreateAsync(
        cancellationToken: CancellationToken.None);
    builder.Services.AddSingleton<ICapabilitiesSource>(capabilitiesSource);
    // LiveIncidents:Mode defaults to Fixture (no credentials); Connected opts a real
    // SqlConnectionFactory-backed collector in and fails closed before the host serves traffic.
    builder.Services.AddLiveIncidents(builder.Configuration, probeCatalog);
    builder.Services.AddSingleton<LiveIncidentSamplerService>();
    builder.Services.AddSingleton<ILiveIncidentResponseSource>(
        services => services.GetRequiredService<LiveIncidentSamplerService>());
    builder.Services.AddHostedService(services => services.GetRequiredService<LiveIncidentSamplerService>());
}
builder.Services.AddFindings();

if (acquisitionMode == AcquisitionMode.Fixture && atlasConnected)
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
    builder.Services.AddSingleton<IDatabaseCityProbeExecutor, SqlClientDatabaseCityProbeExecutor>();
    builder.Services.AddSingleton<IDatabaseCitySource, ConnectedDatabaseCitySource>();
    builder.Services.AddHostedService<AtlasRefreshBackgroundService>();
    if (queryStoreConnected)
    {
        builder.Services.AddSingleton(QueryStoreHistoryConfiguration.BuildCollectionOptions(builder.Configuration));
        builder.Services.AddSingleton(QueryStoreHistoryConfiguration.BuildHostOptions(builder.Configuration));
        builder.Services.AddSingleton<IQueryStoreIncrementalSource, SqlQueryStoreIncrementalSource>();
        builder.Services.AddSingleton<ProtectedQueryStoreRepository>();
        builder.Services.AddSingleton<QueryStoreCollectionStatusTracker>();
        builder.Services.AddSingleton<SecureShowplanParser>();
        builder.Services.AddSingleton<ProtectedQueryStoreHistorySink>();
        builder.Services.AddSingleton<IQueryStoreHistorySink>(services =>
            services.GetRequiredService<ProtectedQueryStoreHistorySink>());
        builder.Services.AddSingleton<IncrementalQueryStoreCollector>();
        builder.Services.AddSingleton<ConnectedQueryStoreHistorySource>();
        builder.Services.AddSingleton<IQueryStoreHistorySource>(services =>
            services.GetRequiredService<ConnectedQueryStoreHistorySource>());
        builder.Services.AddHostedService<QueryStoreHistoryBackgroundService>();
    }
    else
    {
        builder.Services.AddSingleton<IQueryStoreHistorySource, UnavailableQueryStoreHistorySource>();
    }
}
else if (acquisitionMode == AcquisitionMode.Fixture)
{
    builder.Services.AddSingleton<FixtureAtlasSnapshotSource>();
    builder.Services.AddSingleton<IAtlasSnapshotSource>(services => services.GetRequiredService<FixtureAtlasSnapshotSource>());
    builder.Services.AddSingleton<IAtlasCollectorStatusSource>(services => services.GetRequiredService<FixtureAtlasSnapshotSource>());
    builder.Services.AddSingleton<IQueryStoreHistorySource, FixtureQueryStoreHistorySource>();
    builder.Services.AddSingleton<IDatabaseCitySource, FixtureDatabaseCitySource>();
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
app.UseSqlSimCityHttpSecurity();

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
app.MapGet("/api/v1/live", (ILiveIncidentResponseSource source, HttpContext context) =>
{
    context.Response.Headers.CacheControl = "no-store";
    return Results.Ok(source.GetCurrentResponse());
});

var queryStore = app.MapGroup("/api/v1/query-store");
queryStore.MapGet("/queries", async (
    IQueryStoreHistorySource source,
    HttpContext context,
    string? databaseId,
    string? metric,
    int? pageSize,
    string? pageToken,
    CancellationToken cancellationToken) =>
{
    context.Response.Headers.CacheControl = "no-store";
    var selectedMetric = metric ?? "cpu";
    if (selectedMetric is not ("cpu" or "execution" or "executions" or "duration" or "reads" or "waits"))
        return Results.BadRequest(new { error = "metric must be cpu, execution, duration, reads, or waits." });
    var selectedPageSize = pageSize ?? 50;
    if (selectedPageSize is < 1 or > 200)
        return Results.BadRequest(new { error = "pageSize must be between 1 and 200." });
    try
    {
        return Results.Ok(await source.GetQueriesAsync(
            databaseId, selectedMetric, selectedPageSize, pageToken, cancellationToken));
    }
    catch (QueryStorePageTokenException)
    {
        return Results.BadRequest(new { error = "pageToken is malformed or no longer valid." });
    }
    catch (QueryStoreSnapshotChangedException)
    {
        return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
    }
});
queryStore.MapGet("/queries/{familyId}", async (
    IQueryStoreHistorySource source, HttpContext context, string familyId, CancellationToken cancellationToken) =>
{
    context.Response.Headers.CacheControl = "no-store";
    try
    {
        return await source.GetFamilyAsync(familyId, cancellationToken) is { } family
            ? Results.Ok(family) : Results.NotFound();
    }
    catch (QueryStoreSnapshotChangedException)
    {
        return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
    }
});
queryStore.MapGet("/queries/{familyId}/timeline", async (
    IQueryStoreHistorySource source, HttpContext context, string familyId, CancellationToken cancellationToken) =>
{
    context.Response.Headers.CacheControl = "no-store";
    try
    {
        return await source.GetFamilyAsync(familyId, cancellationToken) is { } family
            ? Results.Ok(new { schemaVersion = "1.0", items = family.Runtime })
            : Results.NotFound();
    }
    catch (QueryStoreSnapshotChangedException)
    {
        return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
    }
});
queryStore.MapGet("/queries/{familyId}/plans", async (
    IQueryStoreHistorySource source, HttpContext context, string familyId, CancellationToken cancellationToken) =>
{
    context.Response.Headers.CacheControl = "no-store";
    try
    {
        return await source.GetFamilyAsync(familyId, cancellationToken) is { } family
            ? Results.Ok(new { schemaVersion = "1.0", items = family.Plans })
            : Results.NotFound();
    }
    catch (QueryStoreSnapshotChangedException)
    {
        return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
    }
});
queryStore.MapGet("/plans/{planId}", async (
    IQueryStoreHistorySource source, HttpContext context, string planId, CancellationToken cancellationToken) =>
{
    context.Response.Headers.CacheControl = "no-store";
    return await source.GetPlanAsync(planId, cancellationToken) is { } plan
        ? Results.Ok(plan) : Results.NotFound();
});
queryStore.MapGet("/plans/compare", async (
    IQueryStoreHistorySource source, HttpContext context, string leftPlanId, string rightPlanId,
    CancellationToken cancellationToken) =>
{
    context.Response.Headers.CacheControl = "no-store";
    return await source.ComparePlansAsync(leftPlanId, rightPlanId, cancellationToken) is { } comparison
        ? Results.Ok(comparison)
        : Results.NotFound();
});
queryStore.MapGet("/status", async (
    IQueryStoreHistorySource source, HttpContext context, CancellationToken cancellationToken) =>
{
    context.Response.Headers.CacheControl = "no-store";
    return Results.Ok(await source.GetStatusAsync(cancellationToken));
});
app.MapDatabaseCity();
if (archiveMode || edgeMode)
{
    if (archiveMode)
        app.MapArchiveInfo();
    else
        app.MapGet("/api/v1/archive", () => Results.NotFound());
    app.MapMethods("/hubs/current-snapshot", ["GET", "POST"], () => Results.NotFound());
    app.MapMethods("/hubs/current-snapshot/{**rest}", ["GET", "POST"], () => Results.NotFound());
}
else
{
    app.MapGet("/api/v1/archive", () => Results.NotFound());
    app.MapHub<CurrentSnapshotHub>("/hubs/current-snapshot");
}
app.MapFindings();
app.MapEdgeIngestion();
if (edgeMode)
{
    app.MapGet("/api/v1/edge/source", (EdgeAcquisitionSource source, HttpContext context) =>
    {
        context.Response.Headers.CacheControl = "no-store";
        return Results.Ok(source.Info);
    });
}
else
{
    app.MapGet("/api/v1/edge/source", () => Results.NotFound());
}
app.MapFallbackToFile("index.html");

app.Run();
