using SqlSimCity.Contracts.V1;
using SqlSimCity.Findings.Engine;
using SqlSimCity.Findings.Rules;

namespace SqlSimCity.Findings.Tests;

public sealed class PlanRegressionRuleTests
{
    private static readonly PlanRegressionRule Rule = new();

    private static QueryFamilyDetailV1 RegressedFamily(
        string replicaB = "primary", string replicaR = "primary",
        string epochB = "e1", string epochR = "e1",
        long countB = 100, long countR = 100,
        decimal avgB = 1000, decimal avgR = 2000,
        DateTimeOffset? lastB = null, DateTimeOffset? lastR = null,
        DataStatus status = DataStatus.Available)
    {
        var plans = new[]
        {
            FindingsTestData.Plan("pBaseline", lastExecution: lastB ?? FindingsTestData.Now.AddHours(-4)),
            FindingsTestData.Plan("pRegressed", lastExecution: lastR ?? FindingsTestData.Now),
        };
        var runtime = new[]
        {
            FindingsTestData.Bucket("pBaseline", replica: replicaB, epoch: epochB, count: countB, totalDuration: avgB * countB),
            FindingsTestData.Bucket("pRegressed", replica: replicaR, epoch: epochR, count: countR, totalDuration: avgR * countR),
        };
        return FindingsTestData.Family("fam-regress", plans, runtime, status: status);
    }

    [Fact]
    public void Fires_with_correct_direction_and_total_impact()
    {
        var result = Rule.Evaluate(FindingsTestData.Bundle([RegressedFamily()]));

        Assert.Equal(FindingStatus.Firing, result.Outcome);
        var finding = Assert.Single(result.Findings);
        Assert.Equal(FindingImpactDimension.DurationMicroseconds, finding.Impact.Dimension);
        // (2000 - 1000) * 100 regressed executions.
        Assert.Equal("100000", finding.Impact.Magnitude);
        Assert.Equal("pRegressed", finding.Scope.PlanId);
        Assert.Contains(finding.Evidence, e => e.Ref == "pRegressed");
        Assert.Contains(finding.Evidence, e => e.Ref == "pBaseline");
    }

    [Fact]
    public void Does_not_fire_when_workload_moved_back_to_the_faster_plan()
    {
        // The faster plan is the most recent one -> not a regression.
        var family = RegressedFamily(lastB: FindingsTestData.Now, lastR: FindingsTestData.Now.AddHours(-4));
        var result = Rule.Evaluate(FindingsTestData.Bundle([family]));
        Assert.NotEqual(FindingStatus.Firing, result.Outcome);
        Assert.Empty(result.Findings);
    }

    [Fact]
    public void Does_not_compare_across_different_replicas()
    {
        var family = RegressedFamily(replicaB: "primary", replicaR: "secondary-1");
        var result = Rule.Evaluate(FindingsTestData.Bundle([family]));
        Assert.Equal(FindingStatus.NotEvaluated, result.Outcome);
    }

    [Fact]
    public void Does_not_compare_across_different_epochs()
    {
        var family = RegressedFamily(epochB: "e1", epochR: "e2");
        var result = Rule.Evaluate(FindingsTestData.Bundle([family]));
        Assert.Equal(FindingStatus.NotEvaluated, result.Outcome);
    }

    [Fact]
    public void Requires_minimum_execution_evidence()
    {
        var family = RegressedFamily(countB: 10, countR: 10);
        var result = Rule.Evaluate(FindingsTestData.Bundle([family]));
        Assert.Equal(FindingStatus.NotEvaluated, result.Outcome);
    }

    [Fact]
    public void Reports_insufficient_when_comparable_but_not_material()
    {
        var family = RegressedFamily(avgB: 1000, avgR: 1100); // below 1.5x materiality
        var result = Rule.Evaluate(FindingsTestData.Bundle([family]));
        Assert.Equal(FindingStatus.InsufficientEvidence, result.Outcome);
    }

    [Fact]
    public void Downgrades_confidence_when_evidence_is_stale()
    {
        var fresh = Rule.Evaluate(FindingsTestData.Bundle([RegressedFamily(status: DataStatus.Available)])).Findings[0];
        var stale = Rule.Evaluate(FindingsTestData.Bundle([RegressedFamily(status: DataStatus.Stale)])).Findings[0];
        Assert.Equal(FindingConfidence.High, fresh.Confidence);
        Assert.True((int)stale.Confidence < (int)fresh.Confidence);
    }

    [Fact]
    public void Chooses_the_slice_with_the_largest_total_impact()
    {
        // Two comparable slices in one family; the higher-count slice has the larger absolute impact
        // even though both share the same per-execution ratio.
        var plans = new[]
        {
            FindingsTestData.Plan("pB", lastExecution: FindingsTestData.Now.AddHours(-4)),
            FindingsTestData.Plan("pR", lastExecution: FindingsTestData.Now),
        };
        var runtime = new[]
        {
            FindingsTestData.Bucket("pB", replica: "r-small", count: 40, totalDuration: 1000 * 40),
            FindingsTestData.Bucket("pR", replica: "r-small", count: 40, totalDuration: 2000 * 40),
            FindingsTestData.Bucket("pB", replica: "r-big", count: 1000, totalDuration: 1000 * 1000),
            FindingsTestData.Bucket("pR", replica: "r-big", count: 1000, totalDuration: 2000 * 1000),
        };
        var family = FindingsTestData.Family("fam-multi", plans, runtime);
        var finding = Assert.Single(Rule.Evaluate(FindingsTestData.Bundle([family])).Findings);
        Assert.Equal("1000000", finding.Impact.Magnitude); // the big slice
    }

    [Fact]
    public void Not_evaluated_when_no_families()
    {
        Assert.Equal(FindingStatus.NotEvaluated, Rule.Evaluate(FindingsTestData.Bundle()).Outcome);
    }
}

public sealed class PlanLifecycleRuleTests
{
    [Fact]
    public void ForcedPlanFailure_fires_only_with_failures()
    {
        var rule = new ForcedPlanFailureRule();
        var failing = FindingsTestData.Family("f1",
            [FindingsTestData.Plan("pForced", forced: true, forceFailures: 3)],
            [FindingsTestData.Bucket("pForced")]);
        var finding = Assert.Single(rule.Evaluate(FindingsTestData.Bundle([failing])).Findings);
        Assert.Equal("pForced", finding.Scope.PlanId);
        Assert.Equal("3", finding.Impact.Magnitude);

        var forcedNoFailure = FindingsTestData.Family("f2",
            [FindingsTestData.Plan("pForced2", forced: true, forceFailures: 0)],
            [FindingsTestData.Bucket("pForced2")]);
        Assert.Equal(FindingStatus.NotEvaluated, rule.Evaluate(FindingsTestData.Bundle([forcedNoFailure])).Outcome);
    }

    [Fact]
    public void PlanInstability_excludes_psp_variants()
    {
        var rule = new PlanInstabilityRule();
        // Five independent compiled plans -> fires.
        var plans = Enumerable.Range(0, 5).Select(i => FindingsTestData.Plan($"p{i}")).ToArray();
        var runtime = Enumerable.Range(0, 5).Select(i => FindingsTestData.Bucket($"p{i}", count: 50)).ToArray();
        var unstable = FindingsTestData.Family("f-unstable", plans, runtime);
        Assert.Equal(FindingStatus.Firing, rule.Evaluate(FindingsTestData.Bundle([unstable])).Outcome);

        // Five PSP variants -> excluded, no finding.
        var variants = Enumerable.Range(0, 5)
            .Select(i => FindingsTestData.Plan($"v{i}", type: QueryPlanType.Variant, optimization: QueryOptimizationKind.ParameterSensitivePlan))
            .ToArray();
        var variantRuntime = Enumerable.Range(0, 5).Select(i => FindingsTestData.Bucket($"v{i}", count: 50)).ToArray();
        var variantFamily = FindingsTestData.Family("f-variants", variants, variantRuntime);
        Assert.Equal(FindingStatus.NotEvaluated, rule.Evaluate(FindingsTestData.Bundle([variantFamily])).Outcome);
    }

    [Fact]
    public void VariantImbalance_requires_two_variants_with_evidence()
    {
        var rule = new VariantImbalanceRule();
        var plans = new[]
        {
            FindingsTestData.Plan("vFast", type: QueryPlanType.Variant, optimization: QueryOptimizationKind.ParameterSensitivePlan, dispatcherId: "disp"),
            FindingsTestData.Plan("vSlow", type: QueryPlanType.Variant, optimization: QueryOptimizationKind.ParameterSensitivePlan, dispatcherId: "disp"),
        };
        var runtime = new[]
        {
            FindingsTestData.Bucket("vFast", count: 100, totalDuration: 1000 * 100),
            FindingsTestData.Bucket("vSlow", count: 100, totalDuration: 4000 * 100),
        };
        var family = FindingsTestData.Family("f-imbalance", plans, runtime);
        var finding = Assert.Single(rule.Evaluate(FindingsTestData.Bundle([family])).Findings);
        Assert.Equal(FindingSeverity.Advisory, finding.Severity);
    }
}
