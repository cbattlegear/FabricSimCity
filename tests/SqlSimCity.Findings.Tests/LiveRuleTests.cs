using SqlSimCity.Contracts.V1;
using SqlSimCity.Findings.Engine;
using SqlSimCity.Findings.Rules;

namespace SqlSimCity.Findings.Tests;

public sealed class LiveRuleTests
{
    [Fact]
    public void RootBlocker_fires_for_real_root_and_excludes_minus5_sentinel()
    {
        var rule = new RootBlockerRule();
        var live = LiveTestData.Snapshot(blocking: LiveTestData.ChainWithSentinelRoot());
        var result = rule.Evaluate(FindingsTestData.Bundle(live: live));

        var finding = Assert.Single(result.Findings);
        Assert.Contains("80", finding.Title, StringComparison.Ordinal);
        Assert.Equal(FindingImpactDimension.BlockedSessions, finding.Impact.Dimension);
        Assert.Equal("2", finding.Impact.Magnitude); // s81 and s82 downstream
        Assert.Equal(FindingSeverity.Serious, finding.Severity);
        Assert.DoesNotContain(result.Findings, f => f.Scope.ResourceId == "sentinel-5");
    }

    [Fact]
    public void RootBlocker_reports_sentinel_only_roots_as_not_evaluated()
    {
        var rule = new RootBlockerRule();
        var sentinel = new BlockingNodeV1("sentinel-5", BlockingNodeKind.Sentinel, null, BlockingSentinelKind.UntrackedLatchOwner, true, false, false, 1);
        var blocked = new BlockingNodeV1("s90", BlockingNodeKind.Session, 90, BlockingSentinelKind.None, false, false, false, 0);
        var graph = new BlockingGraphV1(
            [sentinel, blocked],
            [new BlockingEdgeV1("e1", "s90", "sentinel-5", "PAGELATCH_SH", "10", ExecutionContextKind.Coordinator, 0)],
            ["sentinel-5"], [], new BlockingGraphSummaryV1(1, 0, 1, 0, 0, "Only a sentinel root."));
        var result = rule.Evaluate(FindingsTestData.Bundle(live: LiveTestData.Snapshot(blocking: graph)));
        Assert.Equal(FindingStatus.NotEvaluated, result.Outcome);
        Assert.Contains("sentinel", result.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void RootBlocker_not_evaluated_without_live()
    {
        Assert.Equal(FindingStatus.NotEvaluated, new RootBlockerRule().Evaluate(FindingsTestData.Bundle()).Outcome);
    }

    [Fact]
    public void MemoryGrantQueue_fires_for_waiting_grants_only()
    {
        var rule = new MemoryGrantQueueRule();
        var live = LiveTestData.Snapshot(memoryGrants:
        [
            LiveTestData.WaitingGrant(85, "512000"),
            LiveTestData.GrantedGrant(82),
        ]);
        var finding = Assert.Single(rule.Evaluate(FindingsTestData.Bundle(live: live)).Findings);
        Assert.Equal("512000", finding.Impact.Magnitude);
        Assert.Equal("memory-grant-queue", finding.Scope.ResourceId);

        var noneWaiting = LiveTestData.Snapshot(memoryGrants: [LiveTestData.GrantedGrant(82)]);
        Assert.Equal(FindingStatus.NotEvaluated, rule.Evaluate(FindingsTestData.Bundle(live: noneWaiting)).Outcome);
    }

    [Fact]
    public void MemoryGrantQueue_reports_null_magnitude_when_requested_size_unknown()
    {
        var rule = new MemoryGrantQueueRule();
        var live = LiveTestData.Snapshot(memoryGrants: [LiveTestData.WaitingGrant(85, null)]);
        var finding = Assert.Single(rule.Evaluate(FindingsTestData.Bundle(live: live)).Findings);
        Assert.Null(finding.Impact.Magnitude); // never a fabricated zero
    }

    [Fact]
    public void MemoryGrantQueue_discloses_the_known_size_denominator_for_a_mixed_queue()
    {
        var rule = new MemoryGrantQueueRule();
        var live = LiveTestData.Snapshot(memoryGrants:
        [
            LiveTestData.WaitingGrant(85, "512000"),
            LiveTestData.WaitingGrant(86, null),
            LiveTestData.WaitingGrant(87, null),
        ]);
        var finding = Assert.Single(rule.Evaluate(FindingsTestData.Bundle(live: live)).Findings);
        Assert.Equal("512000", finding.Impact.Magnitude);
        // The basis must not present a partial sum as the whole queue's demand.
        Assert.Contains("1 of 3", finding.Impact.Basis, StringComparison.Ordinal);
    }

    [Fact]
    public void LogSpacePressure_thresholds_and_severity()
    {
        var rule = new LogSpacePressureRule();
        Assert.Equal(FindingStatus.NotEvaluated, rule.Evaluate(FindingsTestData.Bundle(live: LiveTestData.Snapshot(logSpace: LiveTestData.LogSpace(12.5m)))).Outcome);

        var notable = Assert.Single(rule.Evaluate(FindingsTestData.Bundle(live: LiveTestData.Snapshot(logSpace: LiveTestData.LogSpace(88m)))).Findings);
        Assert.Equal(FindingSeverity.Notable, notable.Severity);

        var serious = Assert.Single(rule.Evaluate(FindingsTestData.Bundle(live: LiveTestData.Snapshot(logSpace: LiveTestData.LogSpace(97m)))).Findings);
        Assert.Equal(FindingSeverity.Serious, serious.Severity);
    }

    [Fact]
    public void FileIoPressure_requires_valid_delta_not_first_sample()
    {
        var rule = new FileIoPressureRule();
        var firing = Assert.Single(rule.Evaluate(FindingsTestData.Bundle(live: LiveTestData.Snapshot(fileIo: LiveTestData.FileIoWithStall(2000m)))).Findings);
        Assert.Equal(FindingImpactDimension.IoStallMilliseconds, firing.Impact.Dimension);

        // A first sample never fabricates a rate.
        Assert.Equal(FindingStatus.NotEvaluated, rule.Evaluate(FindingsTestData.Bundle(live: LiveTestData.Snapshot(fileIo: LiveTestData.FileIoFirstSample()))).Outcome);
        // A below-threshold delta does not fire.
        Assert.Equal(FindingStatus.NotEvaluated, rule.Evaluate(FindingsTestData.Bundle(live: LiveTestData.Snapshot(fileIo: LiveTestData.FileIoWithStall(10m)))).Outcome);
    }
}

public sealed class ShowplanAndUnsupportedRuleTests
{
    [Fact]
    public void ShowplanAdvisory_fires_on_material_warning_only()
    {
        var rule = new ShowplanAdvisoryRule();
        var withMissingIndex = FindingsTestData.Showplan("p1", new ShowplanWarningV1("MissingIndex", "Consider index on dbo.orders(customer_id)."));
        var finding = Assert.Single(rule.Evaluate(FindingsTestData.Bundle(plans: [withMissingIndex])).Findings);
        Assert.Equal(FindingSeverity.Advisory, finding.Severity);
        Assert.Equal("p1", finding.Scope.PlanId);

        var noWarnings = FindingsTestData.Showplan("p2");
        Assert.Equal(FindingStatus.NotEvaluated, rule.Evaluate(FindingsTestData.Bundle(plans: [noWarnings])).Outcome);

        var immaterial = FindingsTestData.Showplan("p3", new ShowplanWarningV1("SomeCosmeticNote", null));
        Assert.Equal(FindingStatus.NotEvaluated, rule.Evaluate(FindingsTestData.Bundle(plans: [immaterial])).Outcome);
    }

    [Fact]
    public void Unsupported_rules_never_fire_and_declare_support()
    {
        foreach (IFindingRule rule in new IFindingRule[] { new TempdbAttributionRule(), new PerOperatorAttributionRule() })
        {
            Assert.Equal(RuleSupportStatus.Unsupported, rule.Support);
            Assert.Equal(FindingStatus.NotEvaluated, rule.Evaluate(FindingsTestData.Bundle()).Outcome);
        }
    }
}
