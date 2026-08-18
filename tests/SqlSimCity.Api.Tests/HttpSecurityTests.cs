using System.Net;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace SqlSimCity.Api.Tests;

public sealed class HttpSecurityTests
{
    [Fact]
    public async Task DefaultHostAllowlistRejectsAnUnlistedHost()
    {
        await using var factory = new WebApplicationFactory<ApiAssemblyMarker>();
        using var client = factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/healthz");
        request.Headers.Host = "attacker.example";

        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.DoesNotContain("attacker.example", await response.Content.ReadAsStringAsync(),
            StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task OperatorCanExplicitlyAllowAReverseProxyHost()
    {
        await using var factory = FactoryWith(new Dictionary<string, string?>
        {
            ["AllowedHosts"] = "sqlsimcity.internal",
        });
        using var client = factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/healthz");
        request.Headers.Host = "sqlsimcity.internal";

        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task OversizedRequestBodyIsRejectedBeforeSignalRParsesIt()
    {
        await using var factory = FactoryWith(new Dictionary<string, string?>
        {
            ["HttpSecurity:MaxRequestBodyBytes"] = "8",
        });
        using var client = factory.CreateClient();
        using var content = new ByteArrayContent(new byte[9]);

        using var response = await client.PostAsync(
            "/hubs/current-snapshot/negotiate?negotiateVersion=1", content);

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
    }

    [Fact]
    public async Task ApiRateLimitIsBoundedPerClient()
    {
        await using var factory = FactoryWith(new Dictionary<string, string?>
        {
            ["HttpSecurity:ApiPermitLimit"] = "2",
            ["HttpSecurity:ApiWindowSeconds"] = "60",
        });
        using var client = factory.CreateClient();

        using var first = await client.GetAsync("/api/v1/atlas");
        using var second = await client.GetAsync("/api/v1/atlas");
        using var rejected = await client.GetAsync("/api/v1/atlas");

        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, rejected.StatusCode);
        Assert.DoesNotContain("127.0.0.1", await rejected.Content.ReadAsStringAsync(),
            StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("HttpSecurity:MaxRequestBodyBytes", "0")]
    [InlineData("HttpSecurity:ApiPermitLimit", "0")]
    [InlineData("HttpSecurity:ApiWindowSeconds", "0")]
    public void InvalidBoundsFailBeforeTheHostServes(string key, string value)
    {
        using var factory = FactoryWith(new Dictionary<string, string?> { [key] = value });

        Assert.ThrowsAny<Exception>(() => factory.CreateClient());
    }

    private static WebApplicationFactory<ApiAssemblyMarker> FactoryWith(
        IReadOnlyDictionary<string, string?> values) =>
        new WebApplicationFactory<ApiAssemblyMarker>().WithWebHostBuilder(builder =>
        {
            foreach (var (key, value) in values)
                builder.UseSetting(key, value);
        });
}
