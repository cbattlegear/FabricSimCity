using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Findings.Engine;

/// <summary>
/// Runs every registered <see cref="IFindingRule"/> against one <see cref="FindingsEvidenceBundle"/>
/// and produces a deterministic, ordered <see cref="FindingsEvaluation"/>. The engine is pure and
/// order-stable: rules are evaluated in <see cref="IFindingRule.RuleId"/> order, findings are ordered
/// by severity, then confidence, then measured impact, then finding id, and an unsupported rule is
/// surfaced in the status without ever being run or fabricating output.
/// </summary>
public sealed class FindingsEngine
{
    public const string EngineVersion = "1.0";

    private readonly IFindingRule[] _rules;

    public FindingsEngine(IEnumerable<IFindingRule> rules)
    {
        ArgumentNullException.ThrowIfNull(rules);
        _rules = rules.OrderBy(rule => rule.RuleId, StringComparer.Ordinal).ToArray();
        var duplicate = _rules.GroupBy(rule => rule.RuleId, StringComparer.Ordinal).FirstOrDefault(group => group.Count() > 1);
        if (duplicate is not null)
            throw new ArgumentException($"Duplicate rule id '{duplicate.Key}' registered.", nameof(rules));
    }

    public FindingsEvaluation Evaluate(FindingsEvidenceBundle bundle)
    {
        ArgumentNullException.ThrowIfNull(bundle);

        var findings = new List<FindingV1>();
        var evaluations = new List<RuleEvaluationV1>(_rules.Length);
        var firingRuleCount = 0;
        var supportedRuleCount = 0;

        foreach (var rule in _rules)
        {
            if (rule.Support == RuleSupportStatus.Unsupported)
            {
                evaluations.Add(new RuleEvaluationV1(
                    rule.RuleId, rule.RuleVersion, rule.Title, rule.Description,
                    RuleSupportStatus.Unsupported, FindingStatus.NotEvaluated, 0,
                    "Not supported by the current contracts; this rule is disclosed but never evaluated."));
                continue;
            }

            supportedRuleCount++;
            var result = rule.Evaluate(bundle);
            AssertScopedFingerprints(rule, result);
            if (result.Outcome == FindingStatus.Firing)
            {
                firingRuleCount++;
                findings.AddRange(result.Findings);
            }

            evaluations.Add(new RuleEvaluationV1(
                rule.RuleId, rule.RuleVersion, rule.Title, rule.Description,
                RuleSupportStatus.Supported, result.Outcome, result.Findings.Count, result.Reason));
        }

        var ordered = findings
            .OrderByDescending(finding => (int)finding.Severity)
            .ThenByDescending(finding => (int)finding.Confidence)
            .ThenByDescending(FindingImpact.MagnitudeOf)
            .ThenBy(finding => finding.FindingId, StringComparer.Ordinal)
            .ToArray();

        var status = new FindingsEngineStatusV1(
            "1.0",
            bundle.GeneratedAt,
            EngineVersion,
            _rules.Length,
            supportedRuleCount,
            firingRuleCount,
            ordered.Length,
            evaluations,
            BuildSources(bundle),
            bundle.BundleReason);

        return new FindingsEvaluation(ordered, status);
    }

    private static void AssertScopedFingerprints(IFindingRule rule, RuleResult result)
    {
        foreach (var finding in result.Findings)
        {
            var expected = FindingFactory.Fingerprint(rule.RuleId, rule.RuleVersion, finding.Scope);
            if (!string.Equals(finding.FindingId, expected, StringComparison.Ordinal))
                throw new InvalidOperationException(
                    $"Rule '{rule.RuleId}' produced a finding whose id is not the deterministic scope fingerprint.");
        }

        var duplicate = result.Findings
            .GroupBy(finding => finding.FindingId, StringComparer.Ordinal)
            .FirstOrDefault(group => group.Count() > 1);
        if (duplicate is not null)
            throw new InvalidOperationException(
                $"Rule '{rule.RuleId}' fired more than once for scope fingerprint '{duplicate.Key}'.");
    }

    private static List<FindingSourceFreshnessV1> BuildSources(FindingsEvidenceBundle bundle)
    {
        var sources = new List<FindingSourceFreshnessV1>();

        if (bundle.Live is { } live)
            sources.Add(new FindingSourceFreshnessV1(
                EvidenceSource.LiveDmvSample, live.Status, live.SourceTimestamp, live.FreshUntil,
                "Live incident sampler snapshot; a point-in-time sample, not a continuous trace."));

        if (bundle.Families.Count > 0 || bundle.QueryStoreStatus is not null)
        {
            var evidence = bundle.Families.Count > 0 ? bundle.Families[0].Family.Evidence : null;
            sources.Add(new FindingSourceFreshnessV1(
                EvidenceSource.QueryStoreAggregate,
                evidence?.Status ?? DataStatus.Unknown,
                evidence?.ObservedAt,
                evidence?.FreshUntil,
                "Query Store aggregate history over its retention window; compiled plans carry no actual operator timing."));
        }

        if (bundle.Atlas is not null)
            sources.Add(new FindingSourceFreshnessV1(
                EvidenceSource.QueryStoreAggregate, DataStatus.Available, bundle.Atlas.GeneratedAt, null,
                "Atlas snapshot of per-database size, live activity, and Query Store health."));

        return sources;
    }
}
