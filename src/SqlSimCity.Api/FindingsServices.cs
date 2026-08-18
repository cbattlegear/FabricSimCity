using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using SqlSimCity.Collection.QueryStore;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.Findings.Engine;
using SqlSimCity.Findings.Evidence;

namespace SqlSimCity.Api;

/// <summary>
/// Isolated registration and endpoint wiring for the read-only findings surface. Keeping all findings
/// integration in this one file (plus the contracts and the <c>SqlSimCity.Findings</c> library) limits
/// merge conflicts with the parallel database-city branch (requirement 8). No endpoint here mutates any
/// server state; acknowledgment/suppression is entirely client-side presentation state.
/// </summary>
public static class FindingsServices
{
    public static IServiceCollection AddFindings(this IServiceCollection services)
    {
        services.AddSingleton(new FindingsEngine(FindingRules.Default()));
        services.AddSingleton<IFindingsEvidenceProvider>(sp => new SourceBackedFindingsEvidenceProvider(
            sp.GetRequiredService<IAtlasSnapshotSource>(),
            sp.GetRequiredService<IQueryStoreHistorySource>(),
            sp.GetRequiredService<ICapabilitiesSource>(),
            () => sp.GetRequiredService<ILiveIncidentResponseSource>().GetCurrentResponse().Snapshot,
            TimeProvider.System));
        services.AddSingleton<FindingsService>();
        return services;
    }

    public static void MapFindings(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/findings");

        group.MapGet("/", async (
            FindingsService service,
            HttpContext context,
            string? sort,
            string[]? severity,
            string[]? confidence,
            string? ruleId,
            string? databaseId,
            int? pageSize,
            string? pageToken,
            CancellationToken cancellationToken) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            if (!TryParseSort(sort, out var sortMode))
                return Results.BadRequest(new { error = "sort must be severity, impact, or confidence." });
            if (!TryParseEnums<FindingSeverity>(severity, out var severities))
                return Results.BadRequest(new { error = "severity contains an unrecognized value." });
            if (!TryParseEnums<FindingConfidence>(confidence, out var confidences))
                return Results.BadRequest(new { error = "confidence contains an unrecognized value." });
            try
            {
                var evaluation = await service.EvaluateAsync(cancellationToken);
                var page = FindingsQuery.Page(
                    evaluation.Findings, evaluation.Status.GeneratedAt, pageSize, pageToken,
                    sortMode, severities, confidences, ruleId, databaseId);
                return Results.Ok(page);
            }
            catch (FindingsPageTokenException)
            {
                return Results.BadRequest(new { error = "pageToken or a filter value is malformed or out of range." });
            }
            catch (QueryStoreSnapshotChangedException)
            {
                return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
            }
        });

        group.MapGet("/status", async (FindingsService service, HttpContext context, CancellationToken cancellationToken) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            try
            {
                var evaluation = await service.EvaluateAsync(cancellationToken);
                return Results.Ok(evaluation.Status);
            }
            catch (QueryStoreSnapshotChangedException)
            {
                return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
            }
        });

        group.MapGet("/rules/{ruleId}", async (
            FindingsService service, HttpContext context, string ruleId, CancellationToken cancellationToken) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            try
            {
                var evaluation = await service.EvaluateAsync(cancellationToken);
                var rule = evaluation.Status.Rules.FirstOrDefault(r => string.Equals(r.RuleId, ruleId, StringComparison.Ordinal));
                if (rule is null)
                    return Results.NotFound();
                var findings = evaluation.Findings.Where(f => string.Equals(f.RuleId, ruleId, StringComparison.Ordinal)).ToArray();
                return Results.Ok(new { schemaVersion = "1.0", rule, findings });
            }
            catch (QueryStoreSnapshotChangedException)
            {
                return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
            }
        });

        group.MapGet("/export", async (
            FindingsService service, HttpContext context, bool? preview, CancellationToken cancellationToken) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            try
            {
                var evaluation = await service.EvaluateAsync(cancellationToken);
                var source = preview == true
                    ? evaluation.Findings.Take(FindingsQuery.DefaultPageSize).ToArray()
                    : evaluation.Findings;
                var (export, _) = FindingsRedactor.Build(source, evaluation.Status.GeneratedAt, FindingsEngine.EngineVersion);
                return Results.Ok(export);
            }
            catch (QueryStoreSnapshotChangedException)
            {
                return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
            }
        });

        group.MapGet("/{findingId}", async (
            FindingsService service, HttpContext context, string findingId, CancellationToken cancellationToken) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            try
            {
                var evaluation = await service.EvaluateAsync(cancellationToken);
                var finding = evaluation.Findings.FirstOrDefault(f => string.Equals(f.FindingId, findingId, StringComparison.Ordinal));
                return finding is null ? Results.NotFound() : Results.Ok(finding);
            }
            catch (QueryStoreSnapshotChangedException)
            {
                return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
            }
        });
    }

    private static bool TryParseSort(string? value, out FindingsSort sort)
    {
        sort = FindingsSort.SeverityThenImpact;
        if (string.IsNullOrEmpty(value))
            return true;
        switch (value.ToLowerInvariant())
        {
            case "severity": sort = FindingsSort.Severity; return true;
            case "impact": sort = FindingsSort.Impact; return true;
            case "confidence": sort = FindingsSort.Confidence; return true;
            default: return false;
        }
    }

    private static bool TryParseEnums<TEnum>(string[]? values, out List<TEnum> parsed) where TEnum : struct, Enum
    {
        parsed = [];
        if (values is null || values.Length == 0)
            return true;
        if (values.Length > FindingsQuery.MaxFilterValues)
            return false;
        foreach (var value in values)
        {
            if (!Enum.TryParse<TEnum>(value, ignoreCase: true, out var result) || !Enum.IsDefined(result))
                return false;
            parsed.Add(result);
        }
        return true;
    }
}

/// <summary>Computes one deterministic findings evaluation on demand from the registered engine and evidence provider.</summary>
public sealed class FindingsService(FindingsEngine engine, IFindingsEvidenceProvider provider)
{
    public async Task<FindingsEvaluation> EvaluateAsync(CancellationToken cancellationToken)
    {
        var bundle = await provider.GetBundleAsync(cancellationToken).ConfigureAwait(false);
        return engine.Evaluate(bundle);
    }
}
