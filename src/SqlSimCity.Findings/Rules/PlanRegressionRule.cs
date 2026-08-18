using System.Globalization;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Findings.Engine;

namespace SqlSimCity.Findings.Rules;

/// <summary>
/// Detects a same-family plan regression: within one comparable slice (same replica group, epoch, and
/// Regular execution type) the more recently executed plan runs materially slower per execution than an
/// earlier, better plan for which there is enough execution evidence. The finding's impact is the total
/// extra duration attributable to running the worse plan, so families are ranked by absolute measured
/// impact rather than by percentage alone (requirement 4).
/// </summary>
public sealed class PlanRegressionRule : IFindingRule
{
    private const decimal MinimumExecutions = 30m;
    private const decimal MaterialityRatio = 1.5m;
    private const decimal StrongEvidenceExecutions = 100m;

    public string RuleId => "plan-regression";
    public string RuleVersion => "1";
    public string Title => "Same-family plan regression";
    public string Description =>
        "Within comparable Query Store windows, a more recent plan runs materially slower per execution than an earlier plan with sufficient evidence; ranked by total measured extra duration.";
    public RuleSupportStatus Support => RuleSupportStatus.Supported;

    public RuleResult Evaluate(FindingsEvidenceBundle bundle)
    {
        if (bundle.Families.Count == 0)
            return RuleResult.NotEvaluated("No Query Store families were loaded to compare plans within.");

        var findings = new List<FindingV1>();
        var anyComparable = false;

        foreach (var family in bundle.Families)
        {
            var candidate = BestCandidate(family, ref anyComparable);
            if (candidate is null)
                continue;

            findings.Add(BuildFinding(bundle.TargetId, family, candidate));
        }

        if (findings.Count > 0)
            return RuleResult.Firing($"{findings.Count} family/families show a measured same-family plan regression.", findings);

        return anyComparable
            ? RuleResult.Insufficient("Comparable plan pairs existed but none met the minimum-evidence and materiality thresholds.")
            : RuleResult.NotEvaluated("No family had two comparable plans with Regular executions in the same replica/epoch slice.");
    }

    private static RegressionCandidate? BestCandidate(QueryFamilyDetailV1 family, ref bool anyComparable)
    {
        var lastExecution = family.Plans.ToDictionary(plan => plan.PlanId, plan => plan.LastExecutionAt, StringComparer.Ordinal);
        RegressionCandidate? best = null;

        foreach (var slice in FamilyRuntime.ComparableRegularSlices(family))
        {
            var qualifying = FamilyRuntime.AggregateByPlan(slice)
                .Where(aggregate => aggregate.ExecutionCount >= MinimumExecutions)
                .ToArray();
            if (qualifying.Length < 2)
                continue;

            anyComparable = true;
            var baseline = qualifying.OrderBy(a => a.AverageDurationMicroseconds).ThenBy(a => a.PlanId, StringComparer.Ordinal).First();
            var regressed = qualifying.OrderByDescending(a => a.AverageDurationMicroseconds).ThenBy(a => a.PlanId, StringComparer.Ordinal).First();
            if (string.Equals(baseline.PlanId, regressed.PlanId, StringComparison.Ordinal))
                continue;

            if (baseline.AverageDurationMicroseconds <= 0)
                continue;
            if (regressed.AverageDurationMicroseconds < baseline.AverageDurationMicroseconds * MaterialityRatio)
                continue;

            // A regression means the workload moved TO the slower plan more recently.
            if (!lastExecution.TryGetValue(regressed.PlanId, out var regressedAt) ||
                !lastExecution.TryGetValue(baseline.PlanId, out var baselineAt) ||
                regressedAt <= baselineAt)
                continue;

            var extraPerExecution = regressed.AverageDurationMicroseconds - baseline.AverageDurationMicroseconds;
            var totalImpact = extraPerExecution * regressed.ExecutionCount;
            if (best is null || totalImpact > best.TotalImpactMicroseconds)
                best = new RegressionCandidate(slice.Key.Replica, slice.Key.Epoch, baseline, regressed, totalImpact);
        }

        return best;
    }

    private FindingV1 BuildFinding(string targetId, QueryFamilyDetailV1 family, RegressionCandidate candidate)
    {
        var status = family.Family.Evidence.Status;
        var strong = candidate.Baseline.ExecutionCount >= StrongEvidenceExecutions &&
                     candidate.Regressed.ExecutionCount >= StrongEvidenceExecutions;
        var confidence = RuleEvidence.Downgrade(strong ? FindingConfidence.High : FindingConfidence.Medium, status);

        var scope = new FindingScopeV1(
            targetId,
            family.Family.DatabaseId, family.Family.FamilyId, candidate.Regressed.PlanId,
            family.Family.FamilyId);

        return FindingFactory.Create(
            this,
            scope,
            $"Plan regression in family {family.Family.FamilyId}",
            RuleEvidence.QueryStoreWindow(FamilyRuntime.EarliestInterval(family), FamilyRuntime.LatestInterval(family), RuleEvidence.CompiledPlanCaveat),
            FindingSeverity.Serious,
            new MeasuredImpactV1(
                FindingImpactDimension.DurationMicroseconds,
                FindingImpact.Format(candidate.TotalImpactMicroseconds),
                "microseconds",
                $"(avg {Round(candidate.Regressed.AverageDurationMicroseconds)} - {Round(candidate.Baseline.AverageDurationMicroseconds)}) x {FindingImpact.Format(candidate.Regressed.ExecutionCount)} regressed executions in replica '{candidate.Replica}', epoch '{candidate.Epoch}'."),
            confidence,
            [
                new FindingEvidenceRefV1(FindingEvidenceKind.QueryStoreFamily, family.Family.FamilyId,
                    family.Family.FamilyId, $"Family with {family.Plans.Count} plans; comparison scoped to replica '{candidate.Replica}', epoch '{candidate.Epoch}', Regular executions."),
                new FindingEvidenceRefV1(FindingEvidenceKind.QueryStorePlan, candidate.Baseline.PlanId, "Faster (baseline) plan",
                    $"Average duration {Round(candidate.Baseline.AverageDurationMicroseconds)} us over {FindingImpact.Format(candidate.Baseline.ExecutionCount)} executions."),
                new FindingEvidenceRefV1(FindingEvidenceKind.QueryStorePlan, candidate.Regressed.PlanId, "Slower (regressed) plan",
                    $"Average duration {Round(candidate.Regressed.AverageDurationMicroseconds)} us over {FindingImpact.Format(candidate.Regressed.ExecutionCount)} executions."),
            ],
            [
                "Only Regular executions in the same replica group and epoch were compared; aborted and exception executions were excluded.",
                RuleEvidence.CompiledPlanCaveat,
                "Query Store aggregates bucket runtime over intervals; the averages are interval-weighted, not per-execution traces.",
            ],
            [
                "Parameter values, data volume, or statistics may have changed, making the plan choice a symptom rather than the root cause.",
                "The slower plan may be optimal for a skewed parameter and only looks worse in aggregate.",
            ],
            [
                "Open the Query Store tab and compare the two plans structurally.",
                "Check for parameter-sensitive behavior before considering forcing the faster plan.",
                "Confirm the regressed plan is still the one being chosen for current executions.",
            ],
            "Read-only recommendation: investigate why the workload moved to the slower plan before considering a plan guide or forced plan; SQLSimCity never changes the server.",
            RuleEvidence.From(family.Family.Evidence));
    }

    private static string OwningTarget(QueryFamilyDetailV1 family) => "target";

    private static string Round(decimal value) => Math.Round(value, 1, MidpointRounding.AwayFromZero).ToString(CultureInfo.InvariantCulture);

    private sealed record RegressionCandidate(
        string Replica,
        string Epoch,
        PlanAggregate Baseline,
        PlanAggregate Regressed,
        decimal TotalImpactMicroseconds);
}
