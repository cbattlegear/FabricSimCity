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
        var unavailableQueryStore = firstDatabase.GetProperty("queryStore");
        Assert.Equal(JsonValueKind.Null, unavailableQueryStore.GetProperty("executionCount").ValueKind);
        Assert.Equal(JsonValueKind.Null, unavailableQueryStore.GetProperty("logicalReads8KiBPages").ValueKind);
        var sampledDatabase = document.RootElement.GetProperty("databases").EnumerateArray()
            .First(database => database.GetProperty("name").GetString() == "sales");
        var queryStore = sampledDatabase.GetProperty("queryStore");
        Assert.Equal(JsonValueKind.String, queryStore.GetProperty("logicalReads8KiBPages").ValueKind);
        Assert.Equal(JsonValueKind.String, queryStore.GetProperty("executionCount").ValueKind);
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

    [Fact]
    public async Task CapabilitiesEndpointReturnsVersionedProfilePerFixtureTargetAndSecurityHeaders()
    {
        using var response = await _client.GetAsync(new Uri("/api/v1/capabilities", UriKind.Relative));
        var snapshot = await response.Content.ReadFromJsonAsync<CapabilitiesSnapshotV1>(JsonOptions);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.NotNull(snapshot);
        Assert.Equal("1", snapshot.SchemaVersion);
        Assert.Equal(5, snapshot.Targets.Count);
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        Assert.Contains("object-src 'none'", response.Headers.GetValues("Content-Security-Policy").Single(),
            StringComparison.Ordinal);

        var managedInstance = snapshot.Targets.Single(t => t.TargetId == "azure-sql-managed-instance");
        Assert.Equal(CapabilityState.Unsupported, managedInstance.OptionalParameterPlanOptimization.State);

        foreach (var target in snapshot.Targets)
        {
            Assert.NotEmpty(target.TargetId);
            Assert.NotEqual(default, target.SourceTimestamp);
        }

        var rawJson = await response.Content.ReadAsStringAsync();
        using var document = JsonDocument.Parse(rawJson);
        var sales = document.RootElement.GetProperty("targets")[0]
            .GetProperty("queryStoreByDatabase")
            .GetProperty("db:atlas-sales");
        Assert.Equal(JsonValueKind.String, sales.GetProperty("maxStorageBytes").ValueKind);
        Assert.Equal("9007199255789568", sales.GetProperty("maxStorageBytes").GetString());
    }

    [Fact]
    public async Task CapabilitiesEndpointOnlySupportsReadOnlyGet()
    {
        using var postResponse = await _client.PostAsync(new Uri("/api/v1/capabilities", UriKind.Relative), content: null);

        Assert.Equal(HttpStatusCode.MethodNotAllowed, postResponse.StatusCode);
    }

    [Fact]
    public async Task CollectorStatusIsReadOnlyAndContainsNoConnectionSecrets()
    {
        using var response = await _client.GetAsync(new Uri("/api/v1/atlas/status", UriKind.Relative));
        var body = await response.Content.ReadAsStringAsync();
        using var post = await _client.PostAsync(new Uri("/api/v1/atlas/status", UriKind.Relative), content: null);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("\"mode\":\"Fixture\"", body, StringComparison.Ordinal);
        Assert.Contains("\"state\":\"Ready\"", body, StringComparison.Ordinal);
        Assert.DoesNotContain("password", body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("connectionString", body, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, post.StatusCode);
    }

    [Fact]
    public async Task QueryStoreHistoryIsPagedReadOnlyAndDisclosesSourceCaveat()
    {
        using var response = await _client.GetAsync(
            new Uri("/api/v1/query-store/queries?metric=duration&pageSize=1", UriKind.Relative));
        var body = await response.Content.ReadAsStringAsync();
        using var document = JsonDocument.Parse(body);
        using var post = await _client.PostAsync(
            new Uri("/api/v1/query-store/queries", UriKind.Relative), content: null);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Single(document.RootElement.GetProperty("items").EnumerateArray());
        Assert.Equal(JsonValueKind.String, document.RootElement.GetProperty("items")[0].GetProperty("executionCount").ValueKind);
        Assert.Contains("no actual operator", body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("query_plan", body, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, post.StatusCode);
    }

    [Fact]
    public async Task PlanApiReturnsNormalizedGraphAndStructuralComparisonOnly()
    {
        using var graphResponse = await _client.GetAsync(
            new Uri("/api/v1/query-store/plans/sales%3A201", UriKind.Relative));
        using var compareResponse = await _client.GetAsync(
            new Uri("/api/v1/query-store/plans/compare?leftPlanId=sales%3A201&rightPlanId=sales%3A202", UriKind.Relative));
        var graph = await graphResponse.Content.ReadAsStringAsync();
        var comparison = await compareResponse.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.OK, graphResponse.StatusCode);
        Assert.Contains("\"nodes\"", graph, StringComparison.Ordinal);
        Assert.DoesNotContain("ShowPlanXML", graph, StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.OK, compareResponse.StatusCode);
        Assert.Contains("not a raw XML line diff", comparison, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("/api/v1/query-store/queries?metric=indexAdvice")]
    [InlineData("/api/v1/query-store/queries?pageSize=0")]
    [InlineData("/api/v1/query-store/queries?pageSize=201")]
    [InlineData("/api/v1/query-store/queries?pageToken=not-base64")]
    public async Task QueryStoreApiRejectsMalformedPagingAndFilters(string path)
    {
        using var response = await _client.GetAsync(new Uri(path, UriKind.Relative));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task QueryStoreStatusIsReadOnlyAndExplicit()
    {
        using var response = await _client.GetAsync(
            new Uri("/api/v1/query-store/status", UriKind.Relative));
        var body = await response.Content.ReadAsStringAsync();
        using var post = await _client.PostAsync(
            new Uri("/api/v1/query-store/status", UriKind.Relative), content: null);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("\"state\":\"Ready\"", body, StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, post.StatusCode);
    }
}
