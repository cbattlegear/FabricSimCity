using SqlSimCity.Contracts.V1;
using SqlSimCity.Findings.Engine;

namespace SqlSimCity.Findings.Rules;

/// <summary>
/// Reports databases whose Query Store cannot currently provide trustworthy historical evidence:
/// disabled, read-only, in error, nearly full, or permission-denied/stale. This is an evidence-gap
/// finding, not a performance diagnosis -- it exists so a reader never mistakes "no history" for
/// "no problem". System databases where Query Store is legitimately unsupported are excluded.
/// </summary>
public sealed class QueryStoreHealthRule : IFindingRule
{
    public string RuleId => "query-store-health";
    public string RuleVersion => "1";
    public string Title => "Query Store cannot provide evidence";
    public string Description =>
        "Flags databases whose Query Store is disabled, read-only, in error, nearly full, permission-denied, or stale, so an evidence gap is never read as a healthy result.";
    public RuleSupportStatus Support => RuleSupportStatus.Supported;

    public RuleResult Evaluate(FindingsEvidenceBundle bundle)
    {
        if (bundle.Atlas is not { } atlas || atlas.Databases.Count == 0)
            return RuleResult.NotEvaluated("No atlas snapshot with database Query Store health was available.");

        var findings = new List<FindingV1>();
        foreach (var database in atlas.Databases)
        {
            var condition = Classify(database.QueryStore);
            if (condition is null)
                continue;

            var (title, severity, confidence, recommendation, nextChecks) = condition.Value;
            var scope = new FindingScopeV1(atlas.Target.TargetId, database.DatabaseId, null, null, database.Name);
            findings.Add(FindingFactory.Create(
                this,
                scope,
                $"{database.Name}: {title}",
                RuleEvidence.QueryStoreWindow(
                    database.QueryStore.WindowStart, database.QueryStore.WindowEnd,
                    "This describes Query Store availability, not a measured query problem."),
                severity,
                new MeasuredImpactV1(FindingImpactDimension.None, null, "n/a",
                    "Configuration/availability state; no numeric performance magnitude is claimed."),
                confidence,
                [
                    new FindingEvidenceRefV1(FindingEvidenceKind.AtlasDatabase, database.DatabaseId, database.Name,
                        $"Query Store capability {database.QueryStore.Capability}, health {database.QueryStore.Health}: {database.QueryStore.Reason}"),
                ],
                [
                    "Query Store availability is a precondition for the history-based rules; while it holds, those rules cannot evaluate this database.",
                    RuleEvidence.CompiledPlanCaveat,
                ],
                [
                    "The database may be intentionally configured this way; this finding does not assert misconfiguration.",
                ],
                nextChecks,
                recommendation,
                RuleEvidence.From(database.QueryStore.Evidence)));
        }

        return findings.Count == 0
            ? RuleResult.NotEvaluated("Every database with an atlas record has readable, healthy Query Store.")
            : RuleResult.Firing($"{findings.Count} database(s) cannot currently provide Query Store evidence.", findings);
    }

    private static (string Title, FindingSeverity Severity, FindingConfidence Confidence, string Recommendation, string[] NextChecks)? Classify(QueryStoreHistoryV1 queryStore)
    {
        // A genuinely unsupported system database is expected, not a finding.
        if (queryStore.Capability == QueryStoreCapability.Unsupported)
            return null;

        if (queryStore.Capability == QueryStoreCapability.Disabled)
            return ("Query Store is disabled", FindingSeverity.Notable, FindingConfidence.High,
                "Read-only recommendation: consider enabling Query Store to retain execution history; SQLSimCity never changes server state.",
                ["Confirm whether Query Store is expected to be off for this database.",
                 "If enabling, review the storage cap and capture mode before turning it on."]);

        if (queryStore.Capability == QueryStoreCapability.PermissionDenied)
            return ("Query Store is not readable by this principal", FindingSeverity.Advisory, FindingConfidence.Medium,
                "Read-only recommendation: grant the collector the least-privilege read access documented in the README; no grant is executed here.",
                ["Verify the collector login's database-scoped permissions.",
                 "Re-run once permissions are in place to see history-based findings for this database."]);

        if (queryStore.Health == QueryStoreHealth.Error)
            return ("Query Store is in an error state", FindingSeverity.Notable, FindingConfidence.High,
                "Read-only recommendation: investigate the Query Store error state; it is not capturing new data.",
                ["Check the database's Query Store actual_state and any error reason.",
                 "History from before the error may still be readable but will not advance."]);

        if (IsNearlyFull(queryStore))
            return ("Query Store storage is nearly full", FindingSeverity.Notable, FindingConfidence.High,
                "Read-only recommendation: review the Query Store size and cleanup policy before it flips to read-only.",
                ["Compare current vs max Query Store storage.",
                 "A full store stops capturing new executions and silently narrows future evidence."]);

        if (queryStore.Health == QueryStoreHealth.ReadOnly)
            return ("Query Store is read-only", FindingSeverity.Advisory, FindingConfidence.High,
                "Read-only recommendation: new executions are not being captured while read-only; review why.",
                ["Determine whether the read-only state is due to a full store, an explicit setting, or a readable secondary.",
                 "Existing history remains valid but will not include recent executions."]);

        if (queryStore.Health == QueryStoreHealth.Stale || queryStore.Evidence.Status == DataStatus.Stale)
            return ("Query Store history is stale", FindingSeverity.Advisory, FindingConfidence.Medium,
                "Read-only recommendation: treat this database's history as older than its freshness window.",
                ["Confirm the collector is currently connected to this target.",
                 "Recent regressions may not yet be reflected in stale aggregates."]);

        return null;
    }

    private static bool IsNearlyFull(QueryStoreHistoryV1 queryStore)
    {
        if (!FindingImpact.TryParse(queryStore.CurrentStorageBytes, out var current) ||
            !FindingImpact.TryParse(queryStore.MaxStorageBytes, out var max) || max <= 0)
            return false;
        return current / max >= 0.9m;
    }
}
