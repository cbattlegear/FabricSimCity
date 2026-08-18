using SqlSimCity.Contracts.V1;
using SqlSimCity.Findings.Engine;

namespace SqlSimCity.Findings.Rules;

/// <summary>
/// Surfaces material warnings normalized from a compiled Showplan (missing-index suggestions, spills,
/// no-join-predicate, and similar) as advisory pointers. These are optimizer estimates on a compiled
/// plan, never actual-execution evidence, so they are always advisory and clearly caveated.
/// </summary>
public sealed class ShowplanAdvisoryRule : IFindingRule
{
    private static readonly HashSet<string> MaterialWarnings = new(StringComparer.OrdinalIgnoreCase)
    {
        "MissingIndex", "MissingIndexGroup", "SpillToTempDb", "HashSpill", "SortSpill",
        "NoJoinPredicate", "UnmatchedIndexes", "PlanAffectingConvert", "ColumnsWithNoStatistics",
        "MemoryGrantWarning", "FullUpdate", "Wait",
    };

    public string RuleId => "showplan-advisory";
    public string RuleVersion => "1";
    public string Title => "Material Showplan warning";
    public string Description =>
        "A compiled plan carries a material normalized Showplan warning (missing index, spill, no join predicate, plan-affecting convert, and similar); advisory only.";
    public RuleSupportStatus Support => RuleSupportStatus.Supported;

    public RuleResult Evaluate(FindingsEvidenceBundle bundle)
    {
        if (bundle.Plans.Count == 0)
            return RuleResult.NotEvaluated("No normalized Showplans were loaded to inspect for warnings.");

        var findings = new List<FindingV1>();
        var anyWarning = false;

        foreach (var plan in bundle.Plans)
        {
            var warnings = plan.Nodes
                .SelectMany(node => node.Warnings.Select(w => (node.NodeId, w.Kind, w.Detail)))
                .ToArray();
            if (warnings.Length > 0)
                anyWarning = true;

            var material = warnings.Where(w => MaterialWarnings.Contains(w.Kind)).ToArray();
            if (material.Length == 0)
                continue;

            var kinds = string.Join(", ", material.Select(w => w.Kind).Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(k => k, StringComparer.Ordinal));
            var scope = new FindingScopeV1(bundle.TargetId, null, null, plan.PlanId, $"Plan {plan.PlanId}")
            { ResourceId = plan.PlanId };
            findings.Add(FindingFactory.Create(
                this,
                scope,
                $"Plan {plan.PlanId}: {kinds}",
                new ObservedWindowV1(plan.Evidence.ObservedAt, plan.Evidence.FreshUntil, "Compiled Showplan", plan.RuntimeOverlayCaveat),
                FindingSeverity.Advisory,
                new MeasuredImpactV1(FindingImpactDimension.None, null, "n/a",
                    "Optimizer-estimated Showplan warning; no measured runtime magnitude is attributed to it."),
                RuleEvidence.Downgrade(FindingConfidence.Medium, plan.Evidence.Status),
                material.Select(w => new FindingEvidenceRefV1(FindingEvidenceKind.QueryStorePlan, plan.PlanId,
                    $"Node {w.NodeId}: {w.Kind}", w.Detail is { Length: > 0 } detail ? detail : $"Normalized Showplan warning '{w.Kind}'.")).ToArray(),
                ["This is an optimizer estimate on a compiled plan, not actual-execution evidence.", plan.RuntimeOverlayCaveat],
                ["A missing-index suggestion is a narrow, single-query estimate and may duplicate or conflict with existing indexes.",
                 "A spill warning can be caused by a one-off skewed parameter rather than a chronic issue."],
                ["Validate any missing-index suggestion against existing indexes and the whole workload before acting.",
                 "For spills, check the memory grant and cardinality estimates for the operator."],
                "Read-only recommendation: treat Showplan warnings as leads to validate, not directives; SQLSimCity never creates indexes or changes the server.",
                RuleEvidence.From(plan.Evidence)));
        }

        if (findings.Count > 0)
            return RuleResult.Firing($"{findings.Count} plan(s) carry a material Showplan warning.", findings);
        return anyWarning
            ? RuleResult.NotEvaluated("Showplan warnings were present but none were in the material set.")
            : RuleResult.NotEvaluated("No loaded Showplan carried a warning.");
    }
}

/// <summary>
/// Explicitly-disclosed unsupported rule: attributing tempdb contention to a specific query requires a
/// correlation between tempdb allocation and a request that the current versioned contracts do not
/// provide. It is surfaced so the coverage boundary is visible, and it never fabricates a finding.
/// </summary>
public sealed class TempdbAttributionRule : IFindingRule
{
    public string RuleId => "tempdb-attribution";
    public string RuleVersion => "1";
    public string Title => "tempdb contention attribution (unsupported)";
    public string Description =>
        "Attributing tempdb space/latch contention to a specific query is not supported: the current contracts expose tempdb usage per session/task but not a defensible causal link to a Query Store family.";
    public RuleSupportStatus Support => RuleSupportStatus.Unsupported;

    public RuleResult Evaluate(FindingsEvidenceBundle bundle) =>
        RuleResult.NotEvaluated("Unsupported: tempdb-to-query attribution is not derivable from the current contracts.");
}

/// <summary>
/// Explicitly-disclosed unsupported rule: assigning whole-query cost to individual operators or tables
/// requires actual per-operator runtime, which a compiled Query Store plan does not contain. Keeping it
/// unsupported enforces the "no whole-query cost assigned to every table" guard.
/// </summary>
public sealed class PerOperatorAttributionRule : IFindingRule
{
    public string RuleId => "per-operator-attribution";
    public string RuleVersion => "1";
    public string Title => "Per-operator cost attribution (unsupported)";
    public string Description =>
        "Assigning a query's measured runtime to individual operators or tables is not supported: compiled Query Store plans carry only estimated operator costs, never actual per-operator timing.";
    public RuleSupportStatus Support => RuleSupportStatus.Unsupported;

    public RuleResult Evaluate(FindingsEvidenceBundle bundle) =>
        RuleResult.NotEvaluated("Unsupported: per-operator actual timing does not exist in compiled Query Store plans.");
}
