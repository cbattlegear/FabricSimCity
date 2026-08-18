using System.Globalization;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Findings.Engine;

namespace SqlSimCity.Findings.Rules;

/// <summary>
/// Reports plans that are explicitly forced (a plan guide / forced plan) but whose forcing has failed
/// at least once, so the engine is silently falling back to normal optimization. This is a concrete,
/// non-folklore fact taken directly from Query Store's own force-failure counters.
/// </summary>
public sealed class ForcedPlanFailureRule : IFindingRule
{
    public string RuleId => "forced-plan-failure";
    public string RuleVersion => "1";
    public string Title => "Forced plan is failing to apply";
    public string Description =>
        "A plan is marked as forced but Query Store reports one or more force failures, so forcing is not actually taking effect.";
    public RuleSupportStatus Support => RuleSupportStatus.Supported;

    public RuleResult Evaluate(FindingsEvidenceBundle bundle)
    {
        if (bundle.Families.Count == 0)
            return RuleResult.NotEvaluated("No Query Store families were loaded to inspect for forced plans.");

        var findings = new List<FindingV1>();
        var anyForced = false;

        foreach (var family in bundle.Families)
        {
            foreach (var plan in family.Plans)
            {
                if (!plan.IsForced)
                    continue;
                anyForced = true;
                var failures = FindingImpact.Parse(plan.ForceFailureCount);
                if (failures <= 0)
                    continue;

                var scope = new FindingScopeV1(bundle.TargetId, family.Family.DatabaseId, family.Family.FamilyId, plan.PlanId,
                    family.Family.FamilyId);
                findings.Add(FindingFactory.Create(
                    this,
                    scope,
                    $"Forced plan {plan.PlanId} is failing to apply",
                    RuleEvidence.QueryStoreWindow(family.Family.FirstObservedAt, plan.LastExecutionAt, RuleEvidence.CompiledPlanCaveat),
                    FindingSeverity.Notable,
                    new MeasuredImpactV1(FindingImpactDimension.None, plan.ForceFailureCount, "force failures",
                        $"Query Store recorded {plan.ForceFailureCount} force failure(s); last reason: {plan.LastForceFailureReason ?? "unspecified"}."),
                    RuleEvidence.Downgrade(FindingConfidence.High, family.Family.Evidence.Status),
                    [
                        new FindingEvidenceRefV1(FindingEvidenceKind.QueryStorePlan, plan.PlanId, "Forced plan",
                            $"Forcing type {plan.ForcingType ?? "unspecified"}, {plan.ForceFailureCount} failure(s), last reason {plan.LastForceFailureReason ?? "unspecified"}."),
                        new FindingEvidenceRefV1(FindingEvidenceKind.QueryStoreFamily, family.Family.FamilyId, family.Family.FamilyId,
                            "The family whose plan is forced."),
                    ],
                    ["Force failures mean the optimizer could not honor the forced plan and used a different plan instead.", RuleEvidence.CompiledPlanCaveat],
                    ["The forced plan may reference an object/index that changed, making forcing no longer valid.",
                     "The failure reason may be transient rather than structural."],
                    ["Review the last force-failure reason in the Query Store tab.",
                     "Decide whether to re-force, drop the forcing, or fix the underlying object/index."],
                    "Read-only recommendation: review or remove the failing forced plan; SQLSimCity never changes plan forcing.",
                    RuleEvidence.From(family.Family.Evidence)));
            }
        }

        if (findings.Count > 0)
            return RuleResult.Firing($"{findings.Count} forced plan(s) are failing to apply.", findings);
        return anyForced
            ? RuleResult.NotEvaluated("Forced plans were present but none reported a force failure.")
            : RuleResult.NotEvaluated("No forced plans were present in the loaded families.");
    }
}

/// <summary>
/// Reports a family whose workload is spread across an unusually large number of distinct compiled
/// plans (plan instability / recompilation churn), excluding the by-design multiple variants of a
/// parameter-sensitive or optional-parameter family, which are counted through their dispatcher.
/// </summary>
public sealed class PlanInstabilityRule : IFindingRule
{
    private const int PlanCountThreshold = 5;
    private const decimal MinExecutionsPerPlan = 5m;

    public string RuleId => "plan-instability";
    public string RuleVersion => "1";
    public string Title => "Family has many distinct plans";
    public string Description =>
        "A single query family is executing across many distinct compiled plans, excluding by-design PSP/OPPO variants, which can indicate plan instability or recompilation churn.";
    public RuleSupportStatus Support => RuleSupportStatus.Supported;

    public RuleResult Evaluate(FindingsEvidenceBundle bundle)
    {
        if (bundle.Families.Count == 0)
            return RuleResult.NotEvaluated("No Query Store families were loaded.");

        var findings = new List<FindingV1>();
        foreach (var family in bundle.Families)
        {
            var executed = FamilyRuntime.AggregateByPlan(family.Runtime)
                .Where(a => a.ExecutionCount >= MinExecutionsPerPlan)
                .Select(a => a.PlanId)
                .ToHashSet(StringComparer.Ordinal);

            // Count independent plans only: exclude PSP/OPPO variants and dispatchers, which are expected to be plural.
            var independent = family.Plans
                .Where(plan => executed.Contains(plan.PlanId))
                .Where(plan => plan.Optimization == QueryOptimizationKind.None && plan.PlanType == QueryPlanType.Compiled)
                .Select(plan => plan.PlanId)
                .Distinct(StringComparer.Ordinal)
                .Count();

            if (independent < PlanCountThreshold)
                continue;

            var scope = new FindingScopeV1(bundle.TargetId, family.Family.DatabaseId, family.Family.FamilyId, null,
                family.Family.FamilyId);
            findings.Add(FindingFactory.Create(
                this,
                scope,
                $"Family {family.Family.FamilyId} has {independent} distinct plans",
                RuleEvidence.QueryStoreWindow(FamilyRuntime.EarliestInterval(family), FamilyRuntime.LatestInterval(family), RuleEvidence.CompiledPlanCaveat),
                FindingSeverity.Notable,
                new MeasuredImpactV1(FindingImpactDimension.PlanCount, independent.ToString(CultureInfo.InvariantCulture), "distinct compiled plans",
                    "Distinct non-variant compiled plans with executions in the loaded window."),
                RuleEvidence.Downgrade(FindingConfidence.Medium, family.Family.Evidence.Status),
                [new FindingEvidenceRefV1(FindingEvidenceKind.QueryStoreFamily, family.Family.FamilyId, family.Family.FamilyId,
                    $"{independent} distinct compiled plans executed for one query family.")],
                ["PSP/OPPO variants and dispatchers are excluded from this count.", RuleEvidence.CompiledPlanCaveat],
                ["A schema/index change or statistics updates during the window can legitimately produce several plans.",
                 "Explicit RECOMPILE hints produce many plans by design."],
                ["Review whether the plans differ structurally in the Query Store tab.",
                 "Check for RECOMPILE hints, changing predicates, or frequent statistics updates."],
                "Read-only recommendation: investigate the cause of plan churn before considering a plan guide; SQLSimCity never changes the server.",
                RuleEvidence.From(family.Family.Evidence)));
        }

        return findings.Count > 0
            ? RuleResult.Firing($"{findings.Count} family/families show plan instability.", findings)
            : RuleResult.NotEvaluated("No family exceeded the distinct-plan threshold with sufficient executions.");
    }
}
