using System.Globalization;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Findings.Engine;

namespace SqlSimCity.Findings.Rules;

/// <summary>
/// Reports a parameter-sensitive (PSP) or optional-parameter (OPPO) family whose variant plans are
/// materially imbalanced: the slowest variant runs far slower per execution than the fastest, with
/// enough executions on both. This is an intended feature working poorly, not a regression, so it is
/// advisory.
/// </summary>
public sealed class VariantImbalanceRule : IFindingRule
{
    private const decimal MinExecutions = 30m;
    private const decimal ImbalanceRatio = 3m;

    public string RuleId => "variant-imbalance";
    public string RuleVersion => "1";
    public string Title => "PSP/OPPO variant imbalance";
    public string Description =>
        "Within a parameter-sensitive or optional-parameter family, one variant plan runs far slower per execution than another with sufficient evidence.";
    public RuleSupportStatus Support => RuleSupportStatus.Supported;

    public RuleResult Evaluate(FindingsEvidenceBundle bundle)
    {
        if (bundle.Families.Count == 0)
            return RuleResult.NotEvaluated("No Query Store families were loaded.");

        var findings = new List<FindingV1>();
        var anyVariantFamily = false;

        foreach (var family in bundle.Families)
        {
            var variantPlanIds = family.Plans
                .Where(plan => plan.PlanType == QueryPlanType.Variant &&
                               plan.Optimization is QueryOptimizationKind.ParameterSensitivePlan or QueryOptimizationKind.OptionalParameterPlanOptimization)
                .Select(plan => plan.PlanId)
                .ToHashSet(StringComparer.Ordinal);
            if (variantPlanIds.Count < 2)
                continue;
            anyVariantFamily = true;

            var variants = FamilyRuntime.AggregateByPlan(
                    family.Runtime.Where(b => b.ExecutionType == QueryStoreExecutionType.Regular && variantPlanIds.Contains(b.PlanId)))
                .Where(a => a.ExecutionCount >= MinExecutions && a.AverageDurationMicroseconds > 0)
                .ToArray();
            if (variants.Length < 2)
                continue;

            var fast = variants.OrderBy(a => a.AverageDurationMicroseconds).ThenBy(a => a.PlanId, StringComparer.Ordinal).First();
            var slow = variants.OrderByDescending(a => a.AverageDurationMicroseconds).ThenBy(a => a.PlanId, StringComparer.Ordinal).First();
            if (slow.AverageDurationMicroseconds < fast.AverageDurationMicroseconds * ImbalanceRatio)
                continue;

            var impact = (slow.AverageDurationMicroseconds - fast.AverageDurationMicroseconds) * slow.ExecutionCount;
            var scope = new FindingScopeV1(bundle.TargetId, family.Family.DatabaseId, family.Family.FamilyId, slow.PlanId,
                family.Family.FamilyId);
            findings.Add(FindingFactory.Create(
                this,
                scope,
                $"Variant imbalance in family {family.Family.FamilyId}",
                RuleEvidence.QueryStoreWindow(FamilyRuntime.EarliestInterval(family), FamilyRuntime.LatestInterval(family), RuleEvidence.CompiledPlanCaveat),
                FindingSeverity.Advisory,
                new MeasuredImpactV1(FindingImpactDimension.DurationMicroseconds, FindingImpact.Format(impact), "microseconds",
                    $"Slow variant avg {Round(slow.AverageDurationMicroseconds)} us vs fast variant avg {Round(fast.AverageDurationMicroseconds)} us over {FindingImpact.Format(slow.ExecutionCount)} slow executions."),
                RuleEvidence.Downgrade(FindingConfidence.Medium, family.Family.Evidence.Status),
                [
                    new FindingEvidenceRefV1(FindingEvidenceKind.QueryStorePlan, fast.PlanId, "Fast variant", $"Average duration {Round(fast.AverageDurationMicroseconds)} us over {FindingImpact.Format(fast.ExecutionCount)} executions."),
                    new FindingEvidenceRefV1(FindingEvidenceKind.QueryStorePlan, slow.PlanId, "Slow variant", $"Average duration {Round(slow.AverageDurationMicroseconds)} us over {FindingImpact.Format(slow.ExecutionCount)} executions."),
                ],
                ["Variants are an intended feature; imbalance is a tuning signal, not a defect.", RuleEvidence.CompiledPlanCaveat],
                ["The slow variant may be correct for a genuinely harder parameter bucket.",
                 "Row-count skew across parameter values can make per-execution averages incomparable."],
                ["Inspect which parameter values map to each variant.",
                 "Confirm the dispatcher's boundaries match the actual data distribution."],
                "Read-only recommendation: review the parameter-sensitive variant boundaries; SQLSimCity never changes the server.",
                RuleEvidence.From(family.Family.Evidence)));
        }

        if (findings.Count > 0)
            return RuleResult.Firing($"{findings.Count} family/families show variant imbalance.", findings);
        return anyVariantFamily
            ? RuleResult.Insufficient("Variant families existed but none had two variants with enough comparable executions.")
            : RuleResult.NotEvaluated("No PSP/OPPO family had multiple variant plans.");
    }

    private static string Round(decimal value) => Math.Round(value, 1, MidpointRounding.AwayFromZero).ToString(CultureInfo.InvariantCulture);
}

/// <summary>
/// Reports a family with a high share of aborted or exception executions relative to its total, which
/// wastes work and often signals client cancellations, timeouts, or runtime errors.
/// </summary>
public sealed class AbortedExceptionShareRule : IFindingRule
{
    private const decimal MinTotalExecutions = 20m;
    private const decimal ShareThreshold = 0.2m;

    public string RuleId => "aborted-exception-share";
    public string RuleVersion => "1";
    public string Title => "High aborted/exception execution share";
    public string Description =>
        "A family's aborted plus exception executions are a high share of its total executions, indicating wasted work from cancellations, timeouts, or errors.";
    public RuleSupportStatus Support => RuleSupportStatus.Supported;

    public RuleResult Evaluate(FindingsEvidenceBundle bundle)
    {
        if (bundle.Families.Count == 0)
            return RuleResult.NotEvaluated("No Query Store families were loaded.");

        var findings = new List<FindingV1>();
        var anyWithVolume = false;

        foreach (var family in bundle.Families)
        {
            decimal total = 0, bad = 0;
            foreach (var bucket in family.Runtime)
            {
                var count = FindingImpact.Parse(bucket.ExecutionCount);
                total += count;
                if (bucket.ExecutionType is QueryStoreExecutionType.Aborted or QueryStoreExecutionType.Exception)
                    bad += count;
            }
            if (total < MinTotalExecutions)
                continue;
            anyWithVolume = true;
            var share = total > 0 ? bad / total : 0m;
            if (share < ShareThreshold)
                continue;

            var scope = new FindingScopeV1(bundle.TargetId, family.Family.DatabaseId, family.Family.FamilyId, null,
                family.Family.FamilyId);
            findings.Add(FindingFactory.Create(
                this,
                scope,
                $"Family {family.Family.FamilyId} has a high aborted/exception share",
                RuleEvidence.QueryStoreWindow(FamilyRuntime.EarliestInterval(family), FamilyRuntime.LatestInterval(family), RuleEvidence.CompiledPlanCaveat),
                FindingSeverity.Notable,
                new MeasuredImpactV1(FindingImpactDimension.AbortedExecutionShare, FindingImpact.Format(Math.Round(share, 4)), "fraction",
                    $"{FindingImpact.Format(bad)} aborted/exception of {FindingImpact.Format(total)} total executions."),
                RuleEvidence.Downgrade(FindingConfidence.High, family.Family.Evidence.Status),
                [new FindingEvidenceRefV1(FindingEvidenceKind.QueryStoreFamily, family.Family.FamilyId, family.Family.FamilyId,
                    $"{FindingImpact.Format(bad)} of {FindingImpact.Format(total)} executions were aborted or raised an exception.")],
                ["Aborted executions are typically client cancellations or query timeouts; exceptions are runtime errors.", RuleEvidence.CompiledPlanCaveat],
                ["A deliberately cancelled long report or a client with an aggressive command timeout can produce aborts without a server fault.",
                 "A transient dependency outage can spike exceptions temporarily."],
                ["Correlate with application timeout settings.",
                 "Inspect the exception executions for a consistent error."],
                "Read-only recommendation: investigate the source of the cancellations/errors; SQLSimCity never changes the server.",
                RuleEvidence.From(family.Family.Evidence)));
        }

        if (findings.Count > 0)
            return RuleResult.Firing($"{findings.Count} family/families have a high aborted/exception share.", findings);
        return anyWithVolume
            ? RuleResult.NotEvaluated("Families had enough executions but none exceeded the aborted/exception share threshold.")
            : RuleResult.NotEvaluated("No family had enough total executions to assess an aborted/exception share.");
    }
}
