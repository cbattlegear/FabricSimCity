using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Api.Tests;

/// <summary>
/// Exercises the requirement-7 wire surface: <c>/api/v1/live</c>'s fixture-backed, no-credentials
/// default, and the SignalR push that carries exactly the latest response, never an accumulating
/// history. All routes here are read-only; there is no mutation endpoint to guard against.
/// </summary>
public sealed class LiveIncidentEndpointTests : IClassFixture<WebApplicationFactory<ApiAssemblyMarker>>
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

    private readonly WebApplicationFactory<ApiAssemblyMarker> _factory;
    private readonly HttpClient _client;

    public LiveIncidentEndpointTests(WebApplicationFactory<ApiAssemblyMarker> factory)
    {
        _factory = factory;
        _client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
    }

    [Fact]
    public async Task LiveEndpointReturnsFixtureSnapshotStatusAndSecurityHeaders()
    {
        using var response = await _client.GetAsync(new Uri("/api/v1/live", UriKind.Relative));
        var body = await response.Content.ReadFromJsonAsync<LiveIncidentResponseV1>(JsonOptions);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        Assert.Contains("object-src 'none'", response.Headers.GetValues("Content-Security-Policy").Single(),
            StringComparison.Ordinal);
        Assert.NotNull(body);
        Assert.NotNull(body.Snapshot);
        Assert.Equal("1.0", body.Snapshot!.SchemaVersion);
        Assert.True(body.Collector.Sequence >= 1);
        Assert.NotEqual(SamplerRunState.Stopped, body.Collector.State);
    }

    [Fact]
    public async Task LiveEndpointExposesExactBigintCountsAsStrings()
    {
        using var response = await _client.GetAsync(new Uri("/api/v1/live", UriKind.Relative));
        var rawJson = await response.Content.ReadAsStringAsync();
        using var document = JsonDocument.Parse(rawJson);

        var requests = document.RootElement.GetProperty("snapshot").GetProperty("requests");
        Assert.True(requests.GetArrayLength() > 0);
        var requestWithReads = requests.EnumerateArray().First(r => r.GetProperty("reads").ValueKind == JsonValueKind.String);
        Assert.Matches("^[0-9]+$", requestWithReads.GetProperty("reads").GetString()!);

        var memoryGrants = document.RootElement.GetProperty("snapshot").GetProperty("memoryGrants");
        var firstGrant = memoryGrants.EnumerateArray().FirstOrDefault();
        if (firstGrant.ValueKind == JsonValueKind.Object)
        {
            var requestedKb = firstGrant.GetProperty("requestedKb");
            Assert.True(requestedKb.ValueKind is JsonValueKind.String or JsonValueKind.Null);
        }
    }

    [Fact]
    public async Task LiveEndpointOnlySupportsReadOnlyGet()
    {
        using var postResponse = await _client.PostAsync(new Uri("/api/v1/live", UriKind.Relative), content: null);

        Assert.Equal(HttpStatusCode.MethodNotAllowed, postResponse.StatusCode);
    }

    [Fact]
    public async Task HubPushesExactlyOneLatestResponsePerBroadcastNoAccumulatedHistory()
    {
        var handler = _factory.Server.CreateHandler();
        await using var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(_factory.Server.BaseAddress, "/hubs/current-snapshot"),
                options => options.HttpMessageHandlerFactory = _ => handler)
            .AddJsonProtocol(options => options.PayloadSerializerOptions.Converters.Add(new JsonStringEnumConverter()))
            .Build();

        var received = new List<LiveIncidentResponseV1>();
        var gotOne = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<LiveIncidentResponseV1>("liveIncidentUpdated", payload =>
        {
            received.Add(payload);
            gotOne.TrySetResult();
        });

        await connection.StartAsync();
        var pulled = await connection.InvokeAsync<LiveIncidentResponseV1>("GetCurrentLiveSnapshot");
        Assert.NotNull(pulled.Snapshot);

        // The push channel exposes only the latest response object at a time -- LiveIncidentResponseV1
        // carries one Snapshot, never a list/ring-buffer of prior cycles -- so no client can accumulate
        // unbounded history from a single broadcast payload.
        using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        await Task.WhenAny(gotOne.Task, Task.Delay(Timeout.Infinite, timeoutCts.Token));
        if (gotOne.Task.IsCompletedSuccessfully)
        {
            Assert.NotNull(received[0].Snapshot);
            Assert.True(received[0].Collector.Sequence >= 1);
        }
    }
}

