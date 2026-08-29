using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;
using SqlSimCity.Api;

namespace SqlSimCity.Api.Tests;

/// <summary>
/// Pins the two ways the share-card work can reach out and damage the rest of the app: by
/// intercepting requests it has no business in, and by widening the SPA fallback.
/// </summary>
public sealed class SocialEndpointTests : IClassFixture<WebApplicationFactory<ApiAssemblyMarker>>
{
    private readonly HttpClient _client;

    public SocialEndpointTests(WebApplicationFactory<ApiAssemblyMarker> factory)
    {
        ArgumentNullException.ThrowIfNull(factory);
        _client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
    }

    /// <summary>
    /// The document rewriter runs ahead of the static handlers, so it sees the liveness probes on
    /// their way past. Answering one with a page is the kind of fault that only shows up as a
    /// container that never becomes ready.
    /// </summary>
    [Theory]
    [InlineData("/healthz")]
    [InlineData("/readyz")]
    public async Task ProbeRoutesAreNotAnsweredWithADocument(string route)
    {
        using var response = await _client.GetAsync(new Uri(route, UriKind.Relative));
        var body = await response.Content.ReadAsStringAsync();

        Assert.DoesNotContain("<html", body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("og:title", body, StringComparison.Ordinal);
    }

    /// <summary>
    /// A fallback registered with <c>MapFallback</c> matches every method, which makes it a valid
    /// routing candidate for a write to a read-only API route and quietly replaces that route's
    /// <c>405</c> with whatever the fallback answers. The repo's read-only-verb guards catch it, but
    /// only obliquely -- they report a 404 and say nothing about why. This one names the cause.
    /// </summary>
    [Theory]
    [InlineData("/api/v1/capabilities")]
    [InlineData("/api/v1/atlas")]
    public async Task TheSpaFallbackDoesNotSwallowMethodRejectionOnApiRoutes(string route)
    {
        using var response = await _client.PostAsync(new Uri(route, UriKind.Relative), content: null);

        Assert.Equal(HttpStatusCode.MethodNotAllowed, response.StatusCode);
    }

    /// <summary>The card is a picture, and is served as one rather than as a download.</summary>
    [Fact]
    public async Task TheCardIsServedAsAPngWithADailyCacheLifetime()
    {
        using var response = await _client.GetAsync(new Uri("/social-card.png", UriKind.Relative));
        var bytes = await response.Content.ReadAsByteArrayAsync();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("image/png", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal<byte[]>([0x89, 0x50, 0x4E, 0x47], [.. bytes.Take(4)]);
        Assert.Contains("max-age=", response.Headers.CacheControl?.ToString() ?? "", StringComparison.Ordinal);
    }

    /// <summary>The card route is read-only like everything else that serves data here.</summary>
    [Fact]
    public async Task TheCardRouteIsGetOnly()
    {
        using var response = await _client.PostAsync(new Uri("/social-card.png", UriKind.Relative), content: null);

        Assert.Equal(HttpStatusCode.MethodNotAllowed, response.StatusCode);
    }

    /// <summary>
    /// An unknown database is a link someone typed wrong, not a fault. It still gets a card, because
    /// a broken image in a preview looks like the site is down.
    /// </summary>
    [Fact]
    public async Task AnUnknownDatabaseStillGetsACardRatherThanAnError()
    {
        using var response = await _client.GetAsync(
            new Uri("/social-card.png?database=no-such-database", UriKind.Relative));
        var bytes = await response.Content.ReadAsByteArrayAsync();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.NotEmpty(bytes);
    }
}
