using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Api;

internal static class DatabaseCityEndpoints
{
    public static void MapDatabaseCity(this WebApplication app)
    {
        app.MapGet("/api/v1/database-city", async (
            IDatabaseCitySource source,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            return Results.Ok(await source.GetSummariesAsync(cancellationToken));
        });

        app.MapGet("/api/v1/database-city/{**databaseId}", async (
            IDatabaseCitySource source,
            HttpContext context,
            string databaseId,
            string? metric,
            int? pageSize,
            string? pageToken,
            CancellationToken cancellationToken) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            var canonicalDatabaseId = NormalizeDatabaseIdForRoute(databaseId);
            if (!IsValidDatabaseId(canonicalDatabaseId))
                return Results.BadRequest(new { error = "databaseId is malformed." });
            if (!TryMetric(metric, out var selectedMetric))
                return Results.BadRequest(new { error = "metric must be cpu, duration, reads, or executions." });
            var selectedPageSize = pageSize ?? 24;
            if (selectedPageSize is < 1 or > 50)
                return Results.BadRequest(new { error = "pageSize must be between 1 and 50." });

            try
            {
                return await source.GetDatabaseAsync(
                    canonicalDatabaseId, selectedMetric, selectedPageSize, pageToken, cancellationToken) is { } city
                    ? Results.Ok(city)
                    : Results.NotFound();
            }
            catch (DatabaseCityPageTokenException)
            {
                return Results.BadRequest(new { error = "pageToken is malformed or does not match this request." });
            }
        });
    }

    internal static bool IsValidDatabaseId(string value)
    {
        if (value.Length is < 1 or > 2048)
            return false;
        for (var index = 0; index < value.Length; index++)
        {
            var character = value[index];
            if (char.IsAsciiLetterOrDigit(character) || character is '-' or '_' or '.' or '~' or ':' or '/')
                continue;
            if (character != '%' ||
                index + 2 >= value.Length ||
                !Uri.IsHexDigit(value[index + 1]) ||
                !Uri.IsHexDigit(value[index + 2]))
                return false;
            index += 2;
        }
        return true;
    }

    internal static string NormalizeDatabaseIdForRoute(string value)
    {
        foreach (var marker in new[] { "database", "resource" })
        {
            var encodedMarker = $"%2F{marker}%2F";
            var index = value.IndexOf(encodedMarker, StringComparison.OrdinalIgnoreCase);
            if (index >= 0)
                return string.Concat(value.AsSpan(0, index), $"/{marker}/", value.AsSpan(index + encodedMarker.Length));
        }
        return value;
    }

    private static bool TryMetric(string? value, out DatabaseCityMetric metric)
    {
        switch (value?.ToLowerInvariant() ?? "cpu")
        {
            case "cpu":
                metric = DatabaseCityMetric.Cpu;
                return true;
            case "duration":
                metric = DatabaseCityMetric.Duration;
                return true;
            case "reads":
                metric = DatabaseCityMetric.Reads;
                return true;
            case "execution":
            case "executions":
                metric = DatabaseCityMetric.Executions;
                return true;
            default:
                metric = default;
                return false;
        }
    }
}
