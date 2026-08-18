using SqlSimCity.Contracts.V1;
using SqlSimCity.Findings.Engine;
using SqlSimCity.Findings.Rules;

namespace SqlSimCity.Findings.Tests;

public sealed class QueryStoreAndWorkloadRuleTests
{
    [Fact]
    public void QueryStoreHealth_flags_problems_but_not_unsupported_system_db()
    {
        var rule = new QueryStoreHealthRule();
        var atlas = FindingsTestData.Atlas(
            FindingsTestData.AtlasDb("master", "master", QueryStoreCapability.Unsupported, QueryStoreHealth.Unavailable, DataStatus.Unsupported),
            FindingsTestData.AtlasDb("sales", "sales", QueryStoreCapability.Available, QueryStoreHealth.Healthy, DataStatus.Available),
            FindingsTestData.AtlasDb("archive", "archive", QueryStoreCapability.Disabled, QueryStoreHealth.Unavailable, DataStatus.Disabled),
            FindingsTestData.AtlasDb("crm", "crm", QueryStoreCapability.Available, QueryStoreHealth.ReadOnly, DataStatus.Available));

        var result = rule.Evaluate(FindingsTestData.Bundle(atlas: atlas));
        Assert.Equal(FindingStatus.Firing, result.Outcome);
        Assert.Equal(2, result.Findings.Count); // archive + crm; master (unsupported) and healthy sales excluded
        Assert.Contains(result.Findings, f => f.Scope.DatabaseId!.EndsWith("archive"));
        Assert.DoesNotContain(result.Findings, f => f.Scope.DatabaseId!.EndsWith("master"));
    }

    [Fact]
    public void QueryStoreHealth_detects_nearly_full()
    {
        var rule = new QueryStoreHealthRule();
        var atlas = FindingsTestData.Atlas(
            FindingsTestData.AtlasDb("sales", "sales", QueryStoreCapability.Available, QueryStoreHealth.Healthy, DataStatus.Available,
                current: "950", max: "1000"));
        var finding = Assert.Single(rule.Evaluate(FindingsTestData.Bundle(atlas: atlas)).Findings);
        Assert.Contains("nearly full", finding.Title, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void QueryStoreHealth_disabled_is_high_confidence_direct_observation()
    {
        var rule = new QueryStoreHealthRule();
        var atlas = FindingsTestData.Atlas(
            FindingsTestData.AtlasDb("archive", "archive", QueryStoreCapability.Disabled, QueryStoreHealth.Unavailable, DataStatus.Disabled));
        var finding = Assert.Single(rule.Evaluate(FindingsTestData.Bundle(atlas: atlas)).Findings);
        Assert.Equal(FindingConfidence.High, finding.Confidence);
    }

    [Fact]
    public void QueryStoreHealth_not_evaluated_without_atlas()
    {
        Assert.Equal(FindingStatus.NotEvaluated, new QueryStoreHealthRule().Evaluate(FindingsTestData.Bundle()).Outcome);
    }

    [Fact]
    public void AbortedExceptionShare_fires_above_threshold_only()
    {
        var rule = new AbortedExceptionShareRule();
        var high = FindingsTestData.Family("f-bad",
            [FindingsTestData.Plan("p1")],
            [
                FindingsTestData.Bucket("p1", QueryStoreExecutionType.Regular, count: 60),
                FindingsTestData.Bucket("p1", QueryStoreExecutionType.Aborted, count: 30),
                FindingsTestData.Bucket("p1", QueryStoreExecutionType.Exception, count: 10),
            ]);
        var finding = Assert.Single(rule.Evaluate(FindingsTestData.Bundle([high])).Findings);
        Assert.Equal(FindingImpactDimension.AbortedExecutionShare, finding.Impact.Dimension);
        Assert.Equal("0.4", finding.Impact.Magnitude);

        var low = FindingsTestData.Family("f-ok",
            [FindingsTestData.Plan("p2")],
            [
                FindingsTestData.Bucket("p2", QueryStoreExecutionType.Regular, count: 95),
                FindingsTestData.Bucket("p2", QueryStoreExecutionType.Aborted, count: 5),
            ]);
        Assert.Equal(FindingStatus.NotEvaluated, rule.Evaluate(FindingsTestData.Bundle([low])).Outcome);
    }

    [Fact]
    public void DominantWait_names_the_dominant_category()
    {
        var rule = new DominantWaitRule();
        var waits = new Dictionary<string, string> { ["CPU"] = "800", ["Lock"] = "100" };
        var family = FindingsTestData.Family("f-wait",
            [FindingsTestData.Plan("p1")],
            [FindingsTestData.Bucket("p1", waits: waits)]);
        var finding = Assert.Single(rule.Evaluate(FindingsTestData.Bundle([family])).Findings);
        Assert.Contains("CPU", finding.Title, StringComparison.Ordinal);
        Assert.Equal("800", finding.Impact.Magnitude);
        Assert.Equal(FindingSeverity.Advisory, finding.Severity);
    }

    [Fact]
    public void QueryResourceDominance_scopes_share_to_loaded_families()
    {
        var rule = new QueryResourceDominanceRule();
        var dominant = FindingsTestData.Family("f-heavy", [FindingsTestData.Plan("p1")], [FindingsTestData.Bucket("p1")], totalCpu: 9_000_000);
        var small = FindingsTestData.Family("f-light", [FindingsTestData.Plan("p2")], [FindingsTestData.Bucket("p2")], totalCpu: 100_000);
        var finding = Assert.Single(rule.Evaluate(FindingsTestData.Bundle([dominant, small])).Findings);
        Assert.Equal("f-heavy", finding.Scope.QueryFamilyId);
        Assert.Contains(finding.Caveats, c => c.Contains("bounded set", StringComparison.OrdinalIgnoreCase));

        // A single family is never a dominance claim.
        Assert.Equal(FindingStatus.NotEvaluated, rule.Evaluate(FindingsTestData.Bundle([dominant])).Outcome);
    }
}
