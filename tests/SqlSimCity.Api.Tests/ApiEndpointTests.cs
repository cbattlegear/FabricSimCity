using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc.Testing;
using SqlSimCity.Api;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Api.Tests;

public sealed class ApiEndpointTests : IClassFixture<WebApplicationFactory<ApiAssemblyMarker>>
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

    private readonly HttpClient _client;

    public ApiEndpointTests(WebApplicationFactory<ApiAssemblyMarker> factory)
    {
        _client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
    }

    [Fact]
    public async Task AtlasEndpointReturnsVersionedFixtureAndSecurityHeaders()
    {
        using var response = await _client.GetAsync(new Uri("/api/v1/atlas", UriKind.Relative));
        var snapshot = await response.Content.ReadFromJsonAsync<AtlasSnapshotV1>(JsonOptions);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.NotNull(snapshot);
        Assert.Equal("1.0", snapshot.SchemaVersion);
        Assert.Equal(8, snapshot.Databases.Count);
        var rawJson = await response.Content.ReadAsStringAsync();
        using var document = JsonDocument.Parse(rawJson);
        var firstDatabase = document.RootElement.GetProperty("databases")[0];
        Assert.Equal(JsonValueKind.String, firstDatabase.GetProperty("allocated").GetProperty("bytes").ValueKind);
        var queryStore = firstDatabase.GetProperty("queryStore");
        Assert.True(queryStore.TryGetProperty("logicalReads8KiBPages", out _));
        Assert.True(queryStore.TryGetProperty("averageDurationMicroseconds", out _));
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        Assert.Contains("object-src 'none'", response.Headers.GetValues("Content-Security-Policy").Single(),
            StringComparison.Ordinal);
        Assert.False(response.Headers.Contains("Access-Control-Allow-Origin"));
    }

    [Theory]
    [InlineData("/healthz", "healthy")]
    [InlineData("/readyz", "ready")]
    public async Task ProbeResponsesContainOnlyGenericStatus(string path, string expected)
    {
        using var response = await _client.GetAsync(new Uri(path, UriKind.Relative));
        var body = await response.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal($"{{\"status\":\"{expected}\"}}", body);
        Assert.DoesNotContain("fixture-target", body, StringComparison.OrdinalIgnoreCase);
    }
}
