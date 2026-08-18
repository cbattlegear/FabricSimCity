using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Mvc.Testing;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Api.Tests;

public sealed class FindingsEndpointTests : IClassFixture<WebApplicationFactory<ApiAssemblyMarker>>
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

    private readonly HttpClient _client;

    public FindingsEndpointTests(WebApplicationFactory<ApiAssemblyMarker> factory)
    {
        _client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
    }

    [Fact]
    public async Task FindingsListIsVersionedNoStoreAndSeverityOrdered()
    {
        using var response = await _client.GetAsync(new Uri("/api/v1/findings", UriKind.Relative));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());

        var page = await response.Content.ReadFromJsonAsync<FindingsPageV1>(JsonOptions);
        Assert.NotNull(page);
        Assert.Equal("1.0", page.SchemaVersion);
        Assert.True(page.TotalCount >= 5, "expected the fixture atlas/Query Store to produce findings");

        for (var i = 1; i < page.Items.Count; i++)
            Assert.True((int)page.Items[i - 1].Severity >= (int)page.Items[i].Severity);

        // Impact magnitudes cross the wire as strings, never numbers.
        var raw = await _client.GetStringAsync(new Uri("/api/v1/findings", UriKind.Relative));
        using var document = JsonDocument.Parse(raw);
        var firstImpact = document.RootElement.GetProperty("items")[0].GetProperty("impact").GetProperty("magnitude");
        Assert.True(firstImpact.ValueKind is JsonValueKind.String or JsonValueKind.Null);
    }

    [Fact]
    public async Task StatusDisclosesSupportedAndUnsupportedRules()
    {
        var status = await _client.GetFromJsonAsync<FindingsEngineStatusV1>(new Uri("/api/v1/findings/status", UriKind.Relative), JsonOptions);
        Assert.NotNull(status);
        Assert.Contains(status.Rules, r => r.Support == RuleSupportStatus.Unsupported);
        Assert.Contains(status.Rules, r => r.RuleId == "forced-plan-failure" && r.Outcome == FindingStatus.Firing);
        Assert.Equal(status.RuleCount, status.Rules.Count);
    }

    [Fact]
    public async Task ExportIsRedactedAndOmitsSensitiveText()
    {
        var raw = await _client.GetStringAsync(new Uri("/api/v1/findings/export", UriKind.Relative));
        Assert.DoesNotContain("<ShowPlanXML", raw, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("password=", raw, StringComparison.OrdinalIgnoreCase);

        var export = JsonSerializer.Deserialize<FindingsExportV1>(raw, JsonOptions);
        Assert.NotNull(export);
        Assert.Equal(0, export.RedactedFieldCount);
        Assert.NotEmpty(export.Findings);
    }

    [Fact]
    public async Task InvalidPageTokenReturnsBadRequest()
    {
        using var response = await _client.GetAsync(new Uri("/api/v1/findings?pageToken=not-valid!!", UriKind.Relative));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task FilterByRuleReturnsOnlyThatRule()
    {
        var page = await _client.GetFromJsonAsync<FindingsPageV1>(
            new Uri("/api/v1/findings?ruleId=query-store-health", UriKind.Relative), JsonOptions);
        Assert.NotNull(page);
        Assert.NotEmpty(page.Items);
        Assert.All(page.Items, f => Assert.Equal("query-store-health", f.RuleId));
    }

    [Fact]
    public async Task SingleFindingResolvesByDeterministicId()
    {
        var page = await _client.GetFromJsonAsync<FindingsPageV1>(new Uri("/api/v1/findings", UriKind.Relative), JsonOptions);
        var id = page!.Items[0].FindingId;
        var finding = await _client.GetFromJsonAsync<FindingV1>(new Uri($"/api/v1/findings/{id}", UriKind.Relative), JsonOptions);
        Assert.NotNull(finding);
        Assert.Equal(id, finding.FindingId);

        using var missing = await _client.GetAsync(new Uri("/api/v1/findings/deadbeef", UriKind.Relative));
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
    }

    [Fact]
    public async Task FindingsEndpointsAreGetOnly()
    {
        using var post = await _client.PostAsync(new Uri("/api/v1/findings", UriKind.Relative), content: null);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, post.StatusCode);
    }
}
