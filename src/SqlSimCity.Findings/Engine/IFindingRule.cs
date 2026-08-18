using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Findings.Engine;

/// <summary>
/// The outcome of running one rule. A rule never returns an empty <see cref="FindingStatus.Firing"/>
/// result: if its prerequisites are not met it returns <see cref="NotEvaluated"/>, and if they are met
/// but the measured evidence is too thin to make a claim it returns <see cref="Insufficient"/>. Both
/// carry a curated, secret-free reason so the engine status can explain the coverage boundary.
/// </summary>
public sealed record RuleResult(FindingStatus Outcome, string Reason, IReadOnlyList<FindingV1> Findings)
{
    public static RuleResult NotEvaluated(string reason) => new(FindingStatus.NotEvaluated, reason, []);

    public static RuleResult Insufficient(string reason) => new(FindingStatus.InsufficientEvidence, reason, []);

    public static RuleResult Firing(string reason, IReadOnlyList<FindingV1> findings) =>
        findings.Count == 0
            ? throw new ArgumentException("A firing rule result must contain at least one finding.", nameof(findings))
            : new RuleResult(FindingStatus.Firing, reason, findings);
}

/// <summary>
/// A single deterministic, side-effect-free findings rule. Rules are independently testable: given a
/// <see cref="FindingsEvidenceBundle"/> they return a <see cref="RuleResult"/> and never read ambient
/// state, wall-clock time, or a SQL connection. <see cref="Support"/> declares whether the current
/// versioned contracts can support the rule at all; an <see cref="RuleSupportStatus.Unsupported"/> rule
/// is surfaced explicitly in the engine status and never fabricates a finding.
/// </summary>
public interface IFindingRule
{
    string RuleId { get; }

    string RuleVersion { get; }

    string Title { get; }

    string Description { get; }

    RuleSupportStatus Support { get; }

    RuleResult Evaluate(FindingsEvidenceBundle bundle);
}
