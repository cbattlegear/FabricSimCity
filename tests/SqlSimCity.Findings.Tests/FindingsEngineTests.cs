using SqlSimCity.Contracts.V1;
using SqlSimCity.Findings.Engine;
using SqlSimCity.Findings.Rules;

namespace SqlSimCity.Findings.Tests;

public sealed class FindingFactoryTests
{
    private static readonly QueryStoreHealthRule Rule = new();

    [Fact]
    public void Fingerprint_is_deterministic_and_stable_across_magnitude()
    {
        var scope = new FindingScopeV1("t", "db", "fam", "plan", "name");
        var a = FindingFactory.Fingerprint(Rule.RuleId, Rule.RuleVersion, scope);
        var b = FindingFactory.Fingerprint(Rule.RuleId, Rule.RuleVersion, scope);
        Assert.Equal(a, b);
        // A different display name (not part of identity) does not change the id.
        var renamed = FindingFactory.Fingerprint(Rule.RuleId, Rule.RuleVersion, scope with { DisplayName = "other" });
        Assert.Equal(a, renamed);
    }

    [Fact]
    public void Fingerprint_changes_with_scope_and_rule()
    {
        var scope = new FindingScopeV1("t", "db", "fam", "plan", "name");
        var baseId = FindingFactory.Fingerprint("rule-a", "1", scope);
        Assert.NotEqual(baseId, FindingFactory.Fingerprint("rule-b", "1", scope));
        Assert.NotEqual(baseId, FindingFactory.Fingerprint("rule-a", "2", scope));
        Assert.NotEqual(baseId, FindingFactory.Fingerprint("rule-a", "1", scope with { ResourceId = "x" }));
        Assert.NotEqual(baseId, FindingFactory.Fingerprint("rule-a", "1", scope with { PlanId = "other" }));
    }
}

public sealed class FindingsEngineTests
{
    private static FindingsEngine EngineWith(params IFindingRule[] rules) => new(rules);

    [Fact]
    public void Orders_by_severity_then_confidence_then_impact()
    {
        var atlas = FindingsTestData.Atlas(
            FindingsTestData.AtlasDb("archive", "archive", QueryStoreCapability.Disabled, QueryStoreHealth.Unavailable, DataStatus.Disabled));
        var live = LiveTestData.Snapshot(blocking: LiveTestData.ChainWithSentinelRoot());
        var bundle = FindingsTestData.Bundle(atlas: atlas, live: live);

        var engine = new FindingsEngine(FindingRules.Default());
        var evaluation = engine.Evaluate(bundle);

        Assert.NotEmpty(evaluation.Findings);
        // Serious root-blocker must sort ahead of the Notable Query Store health finding.
        Assert.Equal("root-blocker", evaluation.Findings[0].RuleId);
        for (var i = 1; i < evaluation.Findings.Count; i++)
            Assert.True((int)evaluation.Findings[i - 1].Severity >= (int)evaluation.Findings[i].Severity);
    }

    [Fact]
    public void Is_deterministic_for_identical_input()
    {
        var bundle = FindingsTestData.Bundle(
            atlas: FindingsTestData.Atlas(FindingsTestData.AtlasDb("crm", "crm", QueryStoreCapability.Available, QueryStoreHealth.ReadOnly, DataStatus.Available)),
            live: LiveTestData.Snapshot(memoryGrants: [LiveTestData.WaitingGrant(85, "1000")]));
        var engine = new FindingsEngine(FindingRules.Default());
        var first = engine.Evaluate(bundle).Findings.Select(f => f.FindingId).ToArray();
        var second = engine.Evaluate(bundle).Findings.Select(f => f.FindingId).ToArray();
        Assert.Equal(first, second);
    }

    [Fact]
    public void Reports_unsupported_rules_without_running_them()
    {
        var engine = new FindingsEngine(FindingRules.Default());
        var status = engine.Evaluate(FindingsTestData.Bundle()).Status;
        var unsupported = status.Rules.Where(r => r.Support == RuleSupportStatus.Unsupported).ToArray();
        Assert.Equal(2, unsupported.Length);
        Assert.All(unsupported, r => Assert.Equal(FindingStatus.NotEvaluated, r.Outcome));
        Assert.Equal(status.RuleCount - unsupported.Length, status.SupportedRuleCount);
    }

    [Fact]
    public void Rejects_duplicate_rule_ids()
    {
        Assert.Throws<ArgumentException>(() => new FindingsEngine([new QueryStoreHealthRule(), new QueryStoreHealthRule()]));
    }

    [Fact]
    public void Guards_against_a_rule_returning_a_wrong_fingerprint()
    {
        var engine = EngineWith(new MisbehavingRule());
        Assert.Throws<InvalidOperationException>(() => engine.Evaluate(FindingsTestData.Bundle()));
    }

    [Fact]
    public void Status_lists_sources_present_in_the_bundle()
    {
        var bundle = FindingsTestData.Bundle(
            atlas: FindingsTestData.Atlas(),
            live: LiveTestData.Snapshot());
        var status = new FindingsEngine(FindingRules.Default()).Evaluate(bundle).Status;
        Assert.Contains(status.Sources, s => s.Source == EvidenceSource.LiveDmvSample);
    }

    private sealed class MisbehavingRule : IFindingRule
    {
        public string RuleId => "misbehaving";
        public string RuleVersion => "1";
        public string Title => "Misbehaving";
        public string Description => "Returns a finding with a hand-forged id.";
        public RuleSupportStatus Support => RuleSupportStatus.Supported;

        public RuleResult Evaluate(FindingsEvidenceBundle bundle)
        {
            var scope = new FindingScopeV1(bundle.TargetId, null, null, null, "x");
            var finding = new FindingV1("1.0", "not-a-real-fingerprint", RuleId, RuleVersion, "t", scope,
                new ObservedWindowV1(null, null, "k", "c"), FindingStatus.Firing, FindingSeverity.Advisory,
                new MeasuredImpactV1(FindingImpactDimension.None, null, "n/a", "b"), FindingConfidence.Low,
                [], [], [], [], "r", new FindingSourceFreshnessV1(EvidenceSource.NotProbed, DataStatus.Unknown, null, null, "r"));
            return RuleResult.Firing("bad", [finding]);
        }
    }
}
