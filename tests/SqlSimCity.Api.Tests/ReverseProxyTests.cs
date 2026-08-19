using System.Collections.Concurrent;
using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace SqlSimCity.Api.Tests;

public sealed class ReverseProxyOptionsTests
{
    private static readonly string[] ExpectedDelimitedProxies = ["10.0.0.5", "10.0.0.6"];
    private static readonly string[] ExpectedArrayProxies = ["172.18.0.2", "::1"];

    [Fact]
    public void ForwardedHeadersAreIgnoredUnlessTurnedOn()
    {
        var options = Build([]);

        Assert.False(options.Enabled);
        Assert.Empty(options.KnownProxies);
        Assert.Empty(options.KnownNetworks);
        Assert.Equal("nothing", options.DescribeTrust());
    }

    [Fact]
    public void TurningItOnWithoutNamingAProxyIsRefused()
    {
        var options = Build(new Dictionary<string, string?>
        {
            ["ReverseProxy:Enabled"] = "true",
        });

        var error = Assert.Throws<InvalidOperationException>(options.Validate);

        Assert.Contains("KnownProxies", error.Message, StringComparison.Ordinal);
        Assert.Contains("KnownNetworks", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("10.0.0.5;10.0.0.6")]
    [InlineData("10.0.0.5,10.0.0.6")]
    [InlineData(" 10.0.0.5 ; 10.0.0.6 ")]
    public void ProxiesCanBeGivenAsOneDelimitedEnvironmentValue(string value)
    {
        var options = Build(new Dictionary<string, string?>
        {
            ["ReverseProxy:KnownProxies"] = value,
        });

        Assert.Equal(
            ExpectedDelimitedProxies,
            options.KnownProxies.Select(proxy => proxy.ToString()));
    }

    [Fact]
    public void ProxiesCanAlsoBeGivenAsAConfigurationArray()
    {
        var options = Build(new Dictionary<string, string?>
        {
            ["ReverseProxy:KnownProxies:0"] = "172.18.0.2",
            ["ReverseProxy:KnownProxies:1"] = "::1",
        });

        Assert.Equal(
            ExpectedArrayProxies,
            options.KnownProxies.Select(proxy => proxy.ToString()));
    }

    [Fact]
    public void NetworksParseAsCidrAndDescribeThemselvesBack()
    {
        var options = Build(new Dictionary<string, string?>
        {
            ["ReverseProxy:Enabled"] = "true",
            ["ReverseProxy:KnownNetworks"] = "172.18.0.0/16;fd00::/8",
        });
        options.Validate();

        Assert.Equal("172.18.0.0/16, fd00::/8", options.DescribeTrust());
    }

    [Fact]
    public void AnAddressThatIsNotAnAddressNamesTheOffendingValue()
    {
        var error = Assert.Throws<InvalidOperationException>(() => Build(new Dictionary<string, string?>
        {
            ["ReverseProxy:KnownProxies"] = "proxy.internal",
        }));

        Assert.Contains("proxy.internal", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("172.18.0.0")]
    [InlineData("172.18.0.0/nope")]
    [InlineData("172.18.0.0/33")]
    [InlineData("nope/16")]
    public void ANetworkThatIsNotCidrNamesTheOffendingValue(string value)
    {
        var error = Assert.Throws<InvalidOperationException>(() => Build(new Dictionary<string, string?>
        {
            ["ReverseProxy:KnownNetworks"] = value,
        }));

        Assert.Contains(value, error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void APrefixWithHostBitsSaysWhichNetworkWasProbablyMeant()
    {
        var error = Assert.Throws<InvalidOperationException>(() => Build(new Dictionary<string, string?>
        {
            ["ReverseProxy:KnownNetworks"] = "172.18.4.7/16",
        }));

        Assert.Contains("172.18.0.0/16", error.Message, StringComparison.Ordinal);
        Assert.Contains("KnownProxies", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("17")]
    public void AnImplausibleProxyChainLengthIsRefused(string value)
    {
        var options = Build(new Dictionary<string, string?>
        {
            ["ReverseProxy:ForwardLimit"] = value,
        });

        var error = Assert.Throws<InvalidOperationException>(options.Validate);

        Assert.Contains("ForwardLimit", error.Message, StringComparison.Ordinal);
    }

    private static ReverseProxyOptions Build(IEnumerable<KeyValuePair<string, string?>> values) =>
        ReverseProxyOptions.FromConfiguration(
            new ConfigurationBuilder().AddInMemoryCollection(values).Build());
}

public sealed class ReverseProxyPipelineTests
{
    private const string ClientA = "203.0.113.10";
    private const string ClientB = "203.0.113.11";
    private const string ProxyPeer = "172.18.0.9";

    [Fact]
    public async Task WithoutTheSettingEveryClientBehindAProxySharesOneRateLimitBucket()
    {
        var probe = new PeerProbe(IPAddress.Parse(ProxyPeer));
        await using var factory = FactoryWith(probe, new Dictionary<string, string?>
        {
            ["HttpSecurity:ApiPermitLimit"] = "2",
        });
        using var client = factory.CreateClient();

        Assert.Equal(HttpStatusCode.OK, await GetAsync(client, ClientA));
        Assert.Equal(HttpStatusCode.OK, await GetAsync(client, ClientB));
        var third = await GetAsync(client, "203.0.113.12");

        Assert.Equal(HttpStatusCode.TooManyRequests, third);
        Assert.All(probe.Observed, observed => Assert.Equal(ProxyPeer, observed.Address));
    }

    [Fact]
    public async Task ATrustedProxysForwardedAddressGivesEachClientItsOwnBucket()
    {
        var probe = new PeerProbe(IPAddress.Parse(ProxyPeer));
        await using var factory = FactoryWith(probe, TrustingProxyPeer(new Dictionary<string, string?>
        {
            ["HttpSecurity:ApiPermitLimit"] = "2",
        }));
        using var client = factory.CreateClient();

        Assert.Equal(HttpStatusCode.OK, await GetAsync(client, ClientA));
        Assert.Equal(HttpStatusCode.OK, await GetAsync(client, ClientA));
        var exhausted = await GetAsync(client, ClientA);
        var otherClient = await GetAsync(client, ClientB);

        Assert.Equal(HttpStatusCode.TooManyRequests, exhausted);
        Assert.Equal(HttpStatusCode.OK, otherClient);
        Assert.Contains(probe.Observed, observed => observed.Address == ClientA);
        Assert.Contains(probe.Observed, observed => observed.Address == ClientB);
    }

    [Fact]
    public async Task ATrustedProxyCanAlsoCorrectTheRequestScheme()
    {
        var probe = new PeerProbe(IPAddress.Parse(ProxyPeer));
        await using var factory = FactoryWith(probe, TrustingProxyPeer([]));
        using var client = factory.CreateClient();

        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/v1/atlas");
        request.Headers.TryAddWithoutValidation("X-Forwarded-For", ClientA);
        request.Headers.TryAddWithoutValidation("X-Forwarded-Proto", "https");
        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("https", Assert.Single(probe.Observed).Scheme);
    }

    [Fact]
    public async Task AClientThatSetsTheHeaderItselfCannotChooseItsOwnBucket()
    {
        var probe = new PeerProbe(IPAddress.Parse("198.51.100.7"));
        await using var factory = FactoryWith(probe, TrustingProxyPeer(new Dictionary<string, string?>
        {
            ["HttpSecurity:ApiPermitLimit"] = "2",
        }));
        using var client = factory.CreateClient();

        Assert.Equal(HttpStatusCode.OK, await GetAsync(client, ClientA));
        Assert.Equal(HttpStatusCode.OK, await GetAsync(client, ClientB));
        var third = await GetAsync(client, "203.0.113.12");

        Assert.Equal(HttpStatusCode.TooManyRequests, third);
        Assert.All(probe.Observed, observed => Assert.Equal("198.51.100.7", observed.Address));
    }

    [Fact]
    public async Task AnIgnoredForwardedHeaderIsReportedRatherThanPassingForConfigured()
    {
        var probe = new PeerProbe(IPAddress.Parse("198.51.100.7"));
        var log = new CapturingLoggerProvider();
        await using var factory = FactoryWith(probe, TrustingProxyPeer([]), log);
        using var client = factory.CreateClient();

        await GetAsync(client, ClientA);
        await GetAsync(client, ClientB);

        var warning = Assert.Single(log.Warnings, entry => entry.Contains("198.51.100.7", StringComparison.Ordinal));
        Assert.Contains("KnownProxies", warning, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ATrustedDeploymentDoesNotReportAMisconfiguration()
    {
        var probe = new PeerProbe(IPAddress.Parse(ProxyPeer));
        var log = new CapturingLoggerProvider();
        await using var factory = FactoryWith(probe, TrustingProxyPeer([]), log);
        using var client = factory.CreateClient();

        await GetAsync(client, ClientA);

        Assert.DoesNotContain(log.Warnings, entry => entry.Contains("X-Forwarded-For but arrived", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TurningItOnWithoutNamingAProxyStopsTheHostBeforeItServes()
    {
        var probe = new PeerProbe(IPAddress.Loopback);
        await using var factory = FactoryWith(probe, new Dictionary<string, string?>
        {
            ["ReverseProxy:Enabled"] = "true",
        });

        Assert.ThrowsAny<Exception>(() => factory.CreateClient());
    }

    private static Dictionary<string, string?> TrustingProxyPeer(Dictionary<string, string?> values)
    {
        values["ReverseProxy:Enabled"] = "true";
        values["ReverseProxy:KnownProxies"] = ProxyPeer;
        return values;
    }

    private static async Task<HttpStatusCode> GetAsync(HttpClient client, string forwardedFor)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/v1/atlas");
        request.Headers.TryAddWithoutValidation("X-Forwarded-For", forwardedFor);
        using var response = await client.SendAsync(request);
        return response.StatusCode;
    }

    private static WebApplicationFactory<ApiAssemblyMarker> FactoryWith(
        PeerProbe probe,
        IReadOnlyDictionary<string, string?> values,
        CapturingLoggerProvider? log = null) =>
        new WebApplicationFactory<ApiAssemblyMarker>().WithWebHostBuilder(builder =>
        {
            foreach (var (key, value) in values)
                builder.UseSetting(key, value);
            builder.ConfigureTestServices(services =>
                services.AddSingleton<IStartupFilter>(probe));
            if (log is not null)
                builder.ConfigureLogging(logging => logging.AddProvider(log));
        });

    /// <summary>
    /// Stands in for the connection a reverse proxy would open. Startup-filter
    /// middleware runs ahead of everything <c>Program.cs</c> registers, so this sets
    /// the peer address before forwarded-header processing sees it, then reads back
    /// the address and scheme the rest of the pipeline actually used.
    /// </summary>
    private sealed class PeerProbe(IPAddress peer) : IStartupFilter
    {
        public ConcurrentQueue<(string Address, string Scheme)> Observed { get; } = new();

        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => builder =>
        {
            builder.Use(async (context, nextMiddleware) =>
            {
                context.Connection.RemoteIpAddress = peer;
                await nextMiddleware();
                Observed.Enqueue((
                    context.Connection.RemoteIpAddress?.ToString() ?? "none",
                    context.Request.Scheme));
            });
            next(builder);
        };
    }

    private sealed class CapturingLoggerProvider : ILoggerProvider
    {
        private readonly ConcurrentQueue<string> _warnings = new();

        public IReadOnlyCollection<string> Warnings => _warnings;

        public ILogger CreateLogger(string categoryName) => new Capturing(_warnings);

        public void Dispose() { }

        private sealed class Capturing(ConcurrentQueue<string> warnings) : ILogger
        {
            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

            public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Warning;

            public void Log<TState>(
                LogLevel logLevel,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
            {
                ArgumentNullException.ThrowIfNull(formatter);
                if (logLevel >= LogLevel.Warning)
                    warnings.Enqueue(formatter(state, exception));
            }
        }
    }
}
