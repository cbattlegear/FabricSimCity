using System.Globalization;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Server.Kestrel.Core;

namespace SqlSimCity.Api;

public sealed class HttpSecurityOptions
{
    public const string SectionName = "HttpSecurity";

    public long MaxRequestBodyBytes { get; init; } = 64 * 1024;
    public int ApiPermitLimit { get; init; } = 600;
    public int ApiWindowSeconds { get; init; } = 60;

    public void Validate()
    {
        if (MaxRequestBodyBytes is < 1 or > 1024 * 1024)
            throw new InvalidOperationException(
                $"{SectionName}:MaxRequestBodyBytes must be between 1 byte and 1 MiB.");
        if (ApiPermitLimit is < 1 or > 10_000)
            throw new InvalidOperationException(
                $"{SectionName}:ApiPermitLimit must be between 1 and 10000.");
        if (ApiWindowSeconds is < 1 or > 3_600)
            throw new InvalidOperationException(
                $"{SectionName}:ApiWindowSeconds must be between 1 and 3600.");
    }
}

public static class HttpSecurityExtensions
{
    public static IServiceCollection AddSqlSimCityHttpSecurity(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        var section = configuration.GetSection(HttpSecurityOptions.SectionName);
        var options = new HttpSecurityOptions
        {
            MaxRequestBodyBytes = section.GetValue<long?>(
                nameof(HttpSecurityOptions.MaxRequestBodyBytes)) ?? 64 * 1024,
            ApiPermitLimit = section.GetValue<int?>(
                nameof(HttpSecurityOptions.ApiPermitLimit)) ?? 600,
            ApiWindowSeconds = section.GetValue<int?>(
                nameof(HttpSecurityOptions.ApiWindowSeconds)) ?? 60,
        };
        options.Validate();

        services.AddSingleton(options);
        services.Configure<KestrelServerOptions>(kestrel =>
            kestrel.Limits.MaxRequestBodySize = options.MaxRequestBodyBytes);
        services.AddRateLimiter(rateLimiter =>
        {
            rateLimiter.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            rateLimiter.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
                RateLimitPartition.GetFixedWindowLimiter(
                    context.Connection.RemoteIpAddress?.ToString() ?? "unknown-client",
                    _ => new FixedWindowRateLimiterOptions
                    {
                        AutoReplenishment = true,
                        PermitLimit = options.ApiPermitLimit,
                        QueueLimit = 0,
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        Window = TimeSpan.FromSeconds(options.ApiWindowSeconds),
                    }));
            rateLimiter.OnRejected = async (context, cancellationToken) =>
            {
                if (context.Lease.TryGetMetadata(
                        MetadataName.RetryAfter, out var retryAfter))
                {
                    context.HttpContext.Response.Headers.RetryAfter =
                        Math.Ceiling(retryAfter.TotalSeconds)
                            .ToString(CultureInfo.InvariantCulture);
                }

                await context.HttpContext.Response.WriteAsJsonAsync(
                    new { error = "API request rate limit exceeded." },
                    cancellationToken);
            };
        });
        return services;
    }

    public static WebApplication UseSqlSimCityHttpSecurity(this WebApplication app)
    {
        var options = app.Services.GetRequiredService<HttpSecurityOptions>();
        app.Use(async (context, next) =>
        {
            if (context.Request.ContentLength is { } contentLength &&
                contentLength > options.MaxRequestBodyBytes)
            {
                context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
                return;
            }

            await next();
        });
        app.UseWhen(
            context => context.Request.Path.StartsWithSegments("/api"),
            branch => branch.UseRateLimiter());
        return app;
    }
}
