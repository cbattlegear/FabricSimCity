using System.Text;
using Microsoft.AspNetCore.Http.Extensions;
using Microsoft.Extensions.FileProviders;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Api.Social;

/// <summary>
/// Serves the share card, and rewrites the app's document head so links describe what they open.
/// </summary>
public static class SocialEndpoints
{
    /// <summary>Path the card is served from, and the one <see cref="SocialMetadata.CardPath"/> writes.</summary>
    public const string CardRoute = "/social-card.png";

    /// <summary>
    /// Inserts the document rewriter. Must run before the static file handlers it shadows.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Only <c>/</c> and <c>/index.html</c> are taken here. Matching more broadly -- anything without
    /// a file extension, say -- would swallow <c>/healthz</c> and <c>/readyz</c> and answer a
    /// container's liveness probe with a page. That is not a limitation in practice: the app routes
    /// entirely by query string, so every link worth previewing is <c>/</c> with a <c>?view=</c> on
    /// the end.
    /// </para>
    /// <para>
    /// Deep paths keep falling through to <c>MapFallbackToFile</c> untouched, and deliberately so.
    /// A fallback registered with <c>MapFallback</c> matches <em>every</em> method, which makes it a
    /// valid candidate for a <c>POST</c> to a read-only API route and turns that route's
    /// <c>405 Method Not Allowed</c> into whatever the fallback answers. Six of this repo's
    /// read-only-verb guards catch exactly that, which is how the first version of this was found.
    /// </para>
    /// <para>
    /// This costs the document the pre-compressed, ETagged path that <c>MapStaticAssets</c> gives it,
    /// which is deliberate and cheap: the file is about a kilobyte, its content now varies by URL so a
    /// shared ETag would be wrong anyway, and the response still passes through the compression
    /// middleware above. Every fingerprinted asset it references is untouched and still served from
    /// the manifest.
    /// </para>
    /// </remarks>
    public static IApplicationBuilder UseSqlSimCitySocialDocument(this WebApplication app)
    {
        ArgumentNullException.ThrowIfNull(app);
        return app.Use(async (context, next) =>
        {
            var path = context.Request.Path.Value ?? "/";
            var isDocument = path is "/" or "/index.html"
                && (HttpMethods.IsGet(context.Request.Method) || HttpMethods.IsHead(context.Request.Method));
            if (!isDocument || !await TryWriteDocumentAsync(context))
            {
                await next();
            }
        });
    }

    /// <summary>Serves the rendered card.</summary>
    public static void MapSocialCard(this WebApplication app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.MapGet(CardRoute, async (
            HttpContext context,
            SocialCardCache cache,
            CancellationToken cancellationToken) =>
        {
            var requested = context.Request.Query["database"].ToString();
            var database = string.IsNullOrWhiteSpace(requested) ? null : requested;
            var png = await cache.GetAsync(database, cancellationToken);

            // Long enough that the daily redraw is what changes the picture rather than traffic, and
            // stale-while-revalidate so the one request that crosses midnight is still served at once.
            context.Response.Headers.CacheControl = "public, max-age=21600, stale-while-revalidate=86400";
            return Results.File(png, "image/png");
        });
    }

    private static async Task<bool> TryWriteDocumentAsync(HttpContext context)
    {
        var templates = context.RequestServices.GetService<SocialDocumentTemplate>();
        var template = templates?.Read();
        if (template is null) return false;

        var atlas = SafeAtlas(context.RequestServices.GetService<IAtlasSnapshotSource>());
        var query = context.Request.Query.ToDictionary(
            pair => pair.Key,
            pair => (string?)pair.Value.ToString(),
            StringComparer.OrdinalIgnoreCase);

        var clock = context.RequestServices.GetService<TimeProvider>() ?? TimeProvider.System;
        var metadata = SocialMetadata.Compose(
            context.Request.Path.Value ?? "/",
            query,
            atlas,
            SocialSeed.For(query, clock.GetUtcNow()));

        var origin = $"{context.Request.Scheme}://{context.Request.Host}";
        var html = SocialDocument.Render(
            template,
            metadata,
            context.Request.GetEncodedUrl(),
            origin + metadata.CardPath);

        // The document now differs by URL, so it must never be stored by a shared cache under a key
        // that ignores the query string.
        context.Response.Headers.CacheControl = "no-cache";
        context.Response.ContentType = "text/html; charset=utf-8";
        var bytes = Encoding.UTF8.GetBytes(html);
        context.Response.ContentLength = bytes.Length;
        if (!HttpMethods.IsHead(context.Request.Method))
        {
            await context.Response.Body.WriteAsync(bytes, context.RequestAborted);
        }

        return true;
    }

    /// <summary>
    /// Reads the atlas without letting a collector problem take the page down with it.
    /// </summary>
    /// <remarks>
    /// The snapshot is only used to turn a database id into a nicer name. That is not worth a failed
    /// document, so a throwing source degrades to the id-parsing fallback in
    /// <see cref="SocialMetadata.ResolveDatabaseName"/>.
    /// </remarks>
    private static AtlasSnapshotV1? SafeAtlas(IAtlasSnapshotSource? source)
    {
        if (source is null) return null;
        try
        {
            return source.GetCurrent();
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            return null;
        }
    }
}

/// <summary>
/// Holds the built <c>index.html</c>, read once.
/// </summary>
/// <remarks>
/// The file is part of the published output and cannot change while the process runs, so re-reading
/// it per request would buy nothing. It is read lazily rather than at startup because the API is
/// runnable without a web build present -- that is the API-only development flow -- and a missing
/// file has to mean "leave the request alone", not "fail to start".
/// </remarks>
public sealed class SocialDocumentTemplate(IWebHostEnvironment environment)
{
    private readonly Lock gate = new();
    private string? cached;
    private bool attempted;

    public string? Read()
    {
        lock (gate)
        {
            if (attempted) return cached;
            attempted = true;
            try
            {
                var file = environment.WebRootFileProvider.GetFileInfo("index.html");
                if (!file.Exists || file.IsDirectory) return cached = null;
                using var stream = file.CreateReadStream();
                using var reader = new StreamReader(stream, Encoding.UTF8);
                return cached = reader.ReadToEnd();
            }
            catch (IOException)
            {
                return cached = null;
            }
        }
    }
}

/// <summary>
/// Chooses the saying for a link: stable for that link on that day, and different tomorrow.
/// </summary>
/// <remarks>
/// A preview client fetches a URL more than once and several readers may fetch the same one, so a
/// line that changed per request would read as instability rather than as variety. Folding the day in
/// gives the variety back on the timescale the card image already refreshes on.
/// </remarks>
public static class SocialSeed
{
    public static long For(IReadOnlyDictionary<string, string?> query, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(query);
        query.TryGetValue("database", out var database);
        query.TryGetValue("view", out var view);
        return For($"{view}|{database}", now);
    }

    public static long For(string key, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(key);
        var day = DayNumber(now);

        // FNV-1a, 64-bit. Not a hash with any security property and not asked to be one; it is here
        // because it is short, stable across processes and platforms, and String.GetHashCode is
        // explicitly none of those -- it is randomised per process, so it would have given a different
        // saying on every restart.
        var hash = 14695981039346656037UL;
        foreach (var value in Encoding.UTF8.GetBytes(key))
        {
            hash = (hash ^ value) * 1099511628211UL;
        }

        hash = (hash ^ (ulong)day) * 1099511628211UL;
        return (long)(hash & long.MaxValue);
    }

    /// <summary>Whole days since the Unix epoch, in UTC.</summary>
    public static long DayNumber(DateTimeOffset now) => now.ToUniversalTime().Date.Ticks / TimeSpan.TicksPerDay;
}
