using System.Globalization;
using System.Net;
using System.Net.Sockets;
using Microsoft.AspNetCore.HttpOverrides;

namespace SqlSimCity.Api;

/// <summary>
/// A CIDR block whose members an operator has declared to be trusted reverse
/// proxies. Stored as a prefix and a length rather than a framework network type
/// so the configured text can be validated, and rejected with a useful message,
/// before any framework type is constructed.
/// </summary>
public sealed record TrustedProxyNetwork(IPAddress Prefix, int PrefixLength)
{
    public override string ToString() =>
        string.Create(CultureInfo.InvariantCulture, $"{Prefix}/{PrefixLength}");
}

/// <summary>
/// Whether SQLSimCity honours <c>X-Forwarded-For</c> and <c>X-Forwarded-Proto</c>,
/// and from which peers.
///
/// Without this, every request behind a reverse proxy arrives from the proxy's
/// own address. The API rate limiter partitions on
/// <c>Connection.RemoteIpAddress</c>, so all callers collapse into a single
/// shared window: one noisy client can exhaust the limit for everyone, and the
/// limit stops describing per-client behaviour at all.
///
/// Honouring the header fixes that, but only if the peer that set it can be
/// trusted. <c>X-Forwarded-For</c> is client-supplied text; anyone who can reach
/// the port directly can name whatever address they like and get a private rate
/// limit bucket per request. So this is off by default, and turning it on without
/// naming the trusted proxies stops startup rather than trusting everyone --
/// there is no safe way to guess which peer is the proxy.
///
/// Only the client address and scheme are forwarded. <c>X-Forwarded-Host</c> is
/// deliberately never honoured: <c>AllowedHosts</c> filters on
/// <c>Request.Host</c>, and letting a header rewrite the value that the host
/// allowlist then checks would quietly weaken a control an operator configured
/// separately. A proxy should pass the real <c>Host</c> instead.
/// </summary>
public sealed class ReverseProxyOptions
{
    public const string SectionName = "ReverseProxy";

    /// <summary>Off by default: the shipped configuration is a direct-exposure one.</summary>
    public bool Enabled { get; init; }

    /// <summary>Exact peer addresses to trust, e.g. the proxy container's address.</summary>
    public IReadOnlyList<IPAddress> KnownProxies { get; init; } = [];

    /// <summary>CIDR blocks to trust, e.g. a Docker bridge network.</summary>
    public IReadOnlyList<TrustedProxyNetwork> KnownNetworks { get; init; } = [];

    /// <summary>
    /// How many entries to consume from the right of <c>X-Forwarded-For</c>, which
    /// is the number of trusted proxies the request passes through. One is the
    /// common single-proxy case; raising it means trusting that many hops to have
    /// appended honestly.
    /// </summary>
    public int ForwardLimit { get; init; } = 1;

    /// <summary>
    /// Reads the section, accepting both an environment-friendly delimited scalar
    /// (<c>ReverseProxy__KnownProxies=10.0.0.5;10.0.0.6</c>) and a JSON array, so
    /// the same deployment can be expressed in <c>compose.yaml</c> or in
    /// <c>appsettings.json</c> without a second spelling to remember.
    /// </summary>
    public static ReverseProxyOptions FromConfiguration(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        var section = configuration.GetSection(SectionName);

        return new ReverseProxyOptions
        {
            Enabled = section.GetValue<bool?>(nameof(Enabled)) ?? false,
            KnownProxies = [.. ReadList(section, nameof(KnownProxies)).Select(ParseProxy)],
            KnownNetworks = [.. ReadList(section, nameof(KnownNetworks)).Select(ParseNetwork)],
            ForwardLimit = section.GetValue<int?>(nameof(ForwardLimit)) ?? 1,
        };
    }

    public void Validate()
    {
        if (ForwardLimit is < 1 or > 16)
            throw new InvalidOperationException(
                $"{SectionName}:{nameof(ForwardLimit)} must be between 1 and 16; it is the number of " +
                $"trusted proxies a request passes through, and '{ForwardLimit.ToString(CultureInfo.InvariantCulture)}' " +
                "is not a plausible chain length.");

        if (!Enabled) return;

        if (KnownProxies.Count == 0 && KnownNetworks.Count == 0)
            throw new InvalidOperationException(
                $"{SectionName}:{nameof(Enabled)} is true but neither {SectionName}:{nameof(KnownProxies)} " +
                $"nor {SectionName}:{nameof(KnownNetworks)} names an address. Forwarded headers are only as " +
                "trustworthy as the peer that sets them: with no allowlist, anyone who can reach this port could " +
                "choose their own client address and take a private rate-limit bucket per request, which is worse " +
                "than the shared bucket this setting exists to fix. Name the reverse proxy's address (the peer " +
                $"address SQLSimCity actually sees, which behind Docker is the gateway or container address, not " +
                $"the browser's), or leave {SectionName}:{nameof(Enabled)} unset.");
    }

    /// <summary>A short operator-readable summary of what is trusted, for the startup log.</summary>
    public string DescribeTrust()
    {
        var parts = new List<string>();
        if (KnownProxies.Count > 0)
            parts.Add(string.Join(", ", KnownProxies.Select(proxy => proxy.ToString())));
        if (KnownNetworks.Count > 0)
            parts.Add(string.Join(", ", KnownNetworks.Select(network => network.ToString())));
        return parts.Count == 0 ? "nothing" : string.Join(", ", parts);
    }

    private static string[] ReadList(IConfigurationSection section, string key)
    {
        var child = section.GetSection(key);
        if (!string.IsNullOrWhiteSpace(child.Value))
        {
            return child.Value.Split(
                [';', ','],
                StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        }

        return [.. child.GetChildren()
            .Select(entry => entry.Value)
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Select(value => value!.Trim())];
    }

    private static IPAddress ParseProxy(string value)
    {
        if (!IPAddress.TryParse(value, out var address))
            throw new InvalidOperationException(
                $"{SectionName}:{nameof(KnownProxies)} contains '{value}', which is not an IP address. " +
                "List peer addresses such as '172.18.0.2' or '::1', separated by semicolons or commas; " +
                $"use {SectionName}:{nameof(KnownNetworks)} for CIDR blocks.");
        return address;
    }

    private static TrustedProxyNetwork ParseNetwork(string value)
    {
        var separator = value.IndexOf('/', StringComparison.Ordinal);
        if (separator < 0)
            throw new InvalidOperationException(
                $"{SectionName}:{nameof(KnownNetworks)} contains '{value}', which is not CIDR notation. " +
                "Write a prefix and a length, such as '172.18.0.0/16'.");

        var prefixText = value[..separator];
        var lengthText = value[(separator + 1)..];

        if (!IPAddress.TryParse(prefixText, out var prefix))
            throw new InvalidOperationException(
                $"{SectionName}:{nameof(KnownNetworks)} contains '{value}', whose prefix '{prefixText}' " +
                "is not an IP address.");

        var maximumLength = prefix.AddressFamily == AddressFamily.InterNetworkV6 ? 128 : 32;
        if (!int.TryParse(lengthText, NumberStyles.None, CultureInfo.InvariantCulture, out var length) ||
            length < 0 || length > maximumLength)
        {
            throw new InvalidOperationException(
                $"{SectionName}:{nameof(KnownNetworks)} contains '{value}', whose prefix length must be a " +
                $"whole number between 0 and {maximumLength.ToString(CultureInfo.InvariantCulture)} for this " +
                "address family.");
        }

        // A prefix carrying host bits is ambiguous: '10.1.2.3/16' could mean the single
        // host or the whole block. Rather than silently pick one, say which network was
        // probably meant and let the operator confirm it.
        var masked = Mask(prefix, length);
        if (!masked.Equals(prefix))
        {
            throw new InvalidOperationException(
                $"{SectionName}:{nameof(KnownNetworks)} contains '{value}', which sets bits below its prefix " +
                $"length. Write the network address -- '{masked}/{length.ToString(CultureInfo.InvariantCulture)}' " +
                $"-- if that is the block you mean, or list '{prefixText}' under " +
                $"{SectionName}:{nameof(KnownProxies)} if you meant that one host.");
        }

        return new TrustedProxyNetwork(prefix, length);
    }

    private static IPAddress Mask(IPAddress address, int prefixLength)
    {
        var bytes = address.GetAddressBytes();
        for (var index = 0; index < bytes.Length; index++)
        {
            var bitsInThisByte = prefixLength - (index * 8);
            if (bitsInThisByte >= 8) continue;
            bytes[index] = bitsInThisByte <= 0
                ? (byte)0
                : (byte)(bytes[index] & (0xFF << (8 - bitsInThisByte)));
        }

        return new IPAddress(bytes);
    }
}

/// <summary>
/// Per-application state for the one-time misconfiguration warning. Held in DI
/// rather than a static field so each host in a test process reports
/// independently.
/// </summary>
internal sealed class ReverseProxyDiagnostics
{
    private int _untrustedPeerReported;

    public bool TryClaimUntrustedPeerReport() =>
        Interlocked.Exchange(ref _untrustedPeerReported, 1) == 0;
}

public static class ReverseProxyExtensions
{
    private const string OriginalPeerItemKey = "SqlSimCity.ReverseProxy.OriginalPeer";
    private const string OriginalForwardedForItemKey = "SqlSimCity.ReverseProxy.OriginalForwardedFor";

    private static readonly Action<ILogger, string, int, Exception?> LogTrustConfigured =
        LoggerMessage.Define<string, int>(
            LogLevel.Information, new EventId(34, "ForwardedHeadersTrustConfigured"),
            "Forwarded headers are honoured from {TrustedPeers}, consuming up to {ForwardLimit} entry or " +
            "entries from the right of X-Forwarded-For. Requests from any other peer keep their real " +
            "connection address. Client addresses recorded from this point on are asserted by that proxy, " +
            "not observed by this process.");

    private static readonly Action<ILogger, string, Exception?> LogUntrustedForwardedFor =
        LoggerMessage.Define<string>(
            LogLevel.Warning, new EventId(35, "ForwardedHeadersFromUntrustedPeer"),
            "A request carried X-Forwarded-For but arrived from {PeerAddress}, which is not in " +
            "ReverseProxy:KnownProxies or ReverseProxy:KnownNetworks, so the header was ignored and the " +
            "API rate limit is still shared across every client behind that peer. If that address is the " +
            "reverse proxy, add it; if it is not, a client is sending the header directly and it is " +
            "correctly being ignored. Reported once per process.");

    public static IServiceCollection AddSqlSimCityReverseProxy(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        var options = ReverseProxyOptions.FromConfiguration(configuration);
        options.Validate();

        services.AddSingleton(options);
        services.AddSingleton<ReverseProxyDiagnostics>();
        return services;
    }

    /// <summary>
    /// Must run before the rate limiter, and therefore before
    /// <see cref="HttpSecurityExtensions.UseSqlSimCityHttpSecurity"/>: the limiter
    /// reads <c>Connection.RemoteIpAddress</c>, so the address has to be the
    /// forwarded one by the time it partitions. A no-op when disabled, which keeps
    /// the default deployment byte-for-byte the pipeline it was before.
    /// </summary>
    public static WebApplication UseSqlSimCityReverseProxy(this WebApplication app)
    {
        ArgumentNullException.ThrowIfNull(app);
        var options = app.Services.GetRequiredService<ReverseProxyOptions>();
        if (!options.Enabled) return app;

        var forwarded = new ForwardedHeadersOptions
        {
            ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
            ForwardLimit = options.ForwardLimit,
        };

        // The framework trusts loopback by default. Clear it so the configured list is
        // the whole truth: an operator reading their own configuration should not have
        // to know about an implicit entry they never wrote.
        forwarded.KnownProxies.Clear();
        forwarded.KnownIPNetworks.Clear();
        foreach (var proxy in options.KnownProxies)
            forwarded.KnownProxies.Add(proxy);
        foreach (var network in options.KnownNetworks)
            forwarded.KnownIPNetworks.Add(
                new System.Net.IPNetwork(network.Prefix, network.PrefixLength));

        var logger = app.Services
            .GetRequiredService<ILoggerFactory>()
            .CreateLogger("SqlSimCity.Api.ReverseProxy");
        var diagnostics = app.Services.GetRequiredService<ReverseProxyDiagnostics>();
        LogTrustConfigured(logger, options.DescribeTrust(), options.ForwardLimit, null);

        app.Use(async (context, next) =>
        {
            context.Items[OriginalPeerItemKey] = context.Connection.RemoteIpAddress;
            context.Items[OriginalForwardedForItemKey] =
                context.Request.Headers["X-Forwarded-For"].ToString();
            await next();
        });

        app.UseForwardedHeaders(forwarded);

        app.Use(async (context, next) =>
        {
            ReportUntrustedForwardedFor(context, logger, diagnostics);
            await next();
        });

        return app;
    }

    /// <summary>
    /// An ignored <c>X-Forwarded-For</c> looks exactly like a working deployment from
    /// the outside -- the app answers normally, and the only symptom is that rate
    /// limiting silently stays global. Say so once rather than letting a misconfigured
    /// allowlist pass for a configured one.
    /// </summary>
    private static void ReportUntrustedForwardedFor(
        HttpContext context,
        ILogger logger,
        ReverseProxyDiagnostics diagnostics)
    {
        if (context.Items[OriginalForwardedForItemKey] is not string original ||
            string.IsNullOrEmpty(original))
        {
            return;
        }

        // The middleware consumes the entries it applies, so an unchanged header and an
        // unchanged peer together mean nothing was trusted.
        if (!string.Equals(
                context.Request.Headers["X-Forwarded-For"].ToString(),
                original,
                StringComparison.Ordinal))
        {
            return;
        }

        var peer = context.Items[OriginalPeerItemKey] as IPAddress;
        if (peer is null || !peer.Equals(context.Connection.RemoteIpAddress)) return;

        if (diagnostics.TryClaimUntrustedPeerReport())
            LogUntrustedForwardedFor(logger, peer.ToString(), null);
    }
}
