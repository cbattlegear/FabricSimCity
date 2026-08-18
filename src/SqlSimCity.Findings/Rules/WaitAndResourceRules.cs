using SqlSimCity.Contracts.V1;
using SqlSimCity.Findings.Engine;

namespace SqlSimCity.Findings.Rules;

/// <summary>
/// Reports the dominant Query Store wait category for a family when one category accounts for the
/// large majority of its total captured wait time. It names where the family's time went; it never
/// claims a wait type is inherently bad (no "CXPACKET is always a problem" folklore).
/// </summary>
public sealed class DominantWaitRule : IFindingRule
{
    private const decimal MinTotalWaitMs = 500m;
    private const decimal DominanceShare = 0.6m;

    public string RuleId => "dominant-wait";
    public string RuleVersion => "1";
    public string Title => "Dominant Query Store wait category";
    public string Description =>
        "One Query Store wait category accounts for the large majority of a family's captured wait time; reported as a pointer, never a verdict.";
    public RuleSupportStatus Support => RuleSupportStatus.Supported;

    public RuleResult Evaluate(FindingsEvidenceBundle bundle)
    {
        if (bundle.Families.Count == 0)
            return RuleResult.NotEvaluated("No Query Store families were loaded.");

        var findings = new List<FindingV1>();
        var anyWaits = false;

        foreach (var family in bundle.Families)
        {
            var totals = new Dictionary<string, decimal>(StringComparer.Ordinal);
            foreach (var bucket in family.Runtime)
                foreach (var (category, ms) in bucket.WaitMilliseconds)
                    totals[category] = totals.GetValueOrDefault(category) + FindingImpact.Parse(ms);

            var totalWait = totals.Values.Sum();
            if (totalWait <= 0)
                continue;
            anyWaits = true;
            if (totalWait < MinTotalWaitMs)
                continue;

            var dominant = totals.OrderByDescending(kv => kv.Value).ThenBy(kv => kv.Key, StringComparer.Ordinal).First();
            var share = dominant.Value / totalWait;
            if (share < DominanceShare)
                continue;

            var scope = new FindingScopeV1(bundle.TargetId, family.Family.DatabaseId, family.Family.FamilyId, null,
                family.Family.FamilyId)
            { ResourceId = dominant.Key };
            findings.Add(FindingFactory.Create(
                this,
                scope,
                $"Family {family.Family.FamilyId} waits mostly on {dominant.Key}",
                RuleEvidence.QueryStoreWindow(FamilyRuntime.EarliestInterval(family), FamilyRuntime.LatestInterval(family), RuleEvidence.CompiledPlanCaveat),
                FindingSeverity.Advisory,
                new MeasuredImpactV1(FindingImpactDimension.WaitMilliseconds, FindingImpact.Format(dominant.Value), "milliseconds",
                    $"'{dominant.Key}' is {FindingImpact.Format(Math.Round(share * 100, 1))}% of {FindingImpact.Format(totalWait)} ms total captured wait."),
                RuleEvidence.Downgrade(FindingConfidence.Medium, family.Family.Evidence.Status),
                [new FindingEvidenceRefV1(FindingEvidenceKind.QueryStoreFamily, family.Family.FamilyId, family.Family.FamilyId,
                    $"Wait category '{dominant.Key}' = {FindingImpact.Format(dominant.Value)} ms of {FindingImpact.Format(totalWait)} ms total.")],
                ["Query Store wait categories are coarse buckets, not individual wait types.", "A dominant wait category indicates where time went, not that the wait is a problem.", RuleEvidence.CompiledPlanCaveat],
                ["The dominant wait may be entirely expected for this workload shape.",
                 "Signal/CPU waits can dominate simply because the query is CPU-bound by design."],
                ["Correlate the dominant category with the plan shape and current live waits.",
                 "Avoid acting on the wait category alone."],
                "Read-only recommendation: use the dominant wait category as a starting pointer for investigation only; SQLSimCity never changes the server.",
                RuleEvidence.From(family.Family.Evidence)));
        }

        if (findings.Count > 0)
            return RuleResult.Firing($"{findings.Count} family/families have a dominant wait category.", findings);
        return anyWaits
            ? RuleResult.NotEvaluated("Wait time was captured but no single category dominated above the threshold.")
            : RuleResult.NotEvaluated("No family had captured Query Store wait time.");
    }
}

/// <summary>
/// Reports a family that dominates CPU among the loaded top families, when there is enough evidence.
/// The share is explicitly scoped to the bounded set of families loaded this evaluation -- it is never
/// presented as a share of the entire server's workload.
/// </summary>
public sealed class QueryResourceDominanceRule : IFindingRule
{
    private const decimal DominanceShare = 0.4m;
    private const decimal MinTotalCpuMicroseconds = 1_000_000m;

    public string RuleId => "query-resource-dominance";
    public string RuleVersion => "1";
    public string Title => "One family dominates CPU";
    public string Description =>
        "Among the bounded set of top families loaded this evaluation, one family accounts for a dominant share of total CPU.";
    public RuleSupportStatus Support => RuleSupportStatus.Supported;

    public RuleResult Evaluate(FindingsEvidenceBundle bundle)
    {
        if (bundle.Families.Count < 2)
            return RuleResult.NotEvaluated("Fewer than two families were loaded; a dominance share is not meaningful.");

        var totals = bundle.Families
            .Select(family => (family, cpu: FindingImpact.Parse(family.Family.TotalCpuMicroseconds)))
            .ToArray();
        var sum = totals.Sum(t => t.cpu);
        if (sum < MinTotalCpuMicroseconds)
            return RuleResult.Insufficient("Total loaded CPU was too low to make a dominance claim.");

        var top = totals.OrderByDescending(t => t.cpu).ThenBy(t => t.family.Family.FamilyId, StringComparer.Ordinal).First();
        var share = top.cpu / sum;
        if (share < DominanceShare)
            return RuleResult.NotEvaluated("No single loaded family reached the CPU dominance share.");

        var family = top.family;
        var scope = new FindingScopeV1(bundle.TargetId, family.Family.DatabaseId, family.Family.FamilyId, null,
            family.Family.FamilyId);
        var finding = FindingFactory.Create(
            this,
            scope,
            $"Family {family.Family.FamilyId} dominates loaded CPU",
            RuleEvidence.QueryStoreWindow(family.Family.FirstObservedAt, family.Family.LastObservedAt, RuleEvidence.CompiledPlanCaveat),
            FindingSeverity.Advisory,
            new MeasuredImpactV1(FindingImpactDimension.CpuMicroseconds, family.Family.TotalCpuMicroseconds, "microseconds",
                $"{FindingImpact.Format(Math.Round(share * 100, 1))}% of {FindingImpact.Format(sum)} us total CPU across {bundle.Families.Count} loaded families."),
            RuleEvidence.Downgrade(FindingConfidence.Medium, family.Family.Evidence.Status),
            [new FindingEvidenceRefV1(FindingEvidenceKind.QueryStoreFamily, family.Family.FamilyId, family.Family.FamilyId,
                $"Total CPU {family.Family.TotalCpuMicroseconds} us.")],
            ["The share is over the bounded set of top families loaded this evaluation, not the whole server workload.", RuleEvidence.CompiledPlanCaveat],
            ["A single heavy batch/ETL family can legitimately dominate CPU for part of a day.",
             "The bounded loaded set may omit other heavy families, inflating this family's apparent share."],
            ["Confirm the family's role (OLTP vs batch) before treating it as a problem.",
             "Widen the loaded window if you need a server-wide CPU ranking."],
            "Read-only recommendation: use this ranking to prioritize investigation only; SQLSimCity never changes the server.",
            RuleEvidence.From(family.Family.Evidence));

        return RuleResult.Firing("One family dominates loaded CPU.", [finding]);
    }
}
