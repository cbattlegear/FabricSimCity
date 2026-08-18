using System.Security.Cryptography;
using System.Text;
using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Findings.Engine;

/// <summary>
/// Builds <see cref="FindingV1"/> values with a deterministic <see cref="FindingV1.FindingId"/>. The
/// id is a stable fingerprint of the rule identity plus the scope only -- never the measured magnitude
/// -- so it survives re-evaluation as numbers move, which is exactly what a client needs to key
/// durable acknowledgment/suppression state to (requirement 7). A rule fires at most once per scope.
/// </summary>
public static class FindingFactory
{
    public const string SchemaVersion = "1.0";

    public static string Fingerprint(string ruleId, string ruleVersion, FindingScopeV1 scope)
    {
        var canonical = string.Join(
            '\u001f',
            ruleId,
            ruleVersion,
            scope.TargetId,
            scope.DatabaseId ?? string.Empty,
            scope.QueryFamilyId ?? string.Empty,
            scope.PlanId ?? string.Empty,
            scope.ResourceId ?? string.Empty);
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(canonical));
        return Convert.ToHexStringLower(bytes.AsSpan(0, 16));
    }

    public static FindingV1 Create(
        IFindingRule rule,
        FindingScopeV1 scope,
        string title,
        ObservedWindowV1 window,
        FindingSeverity severity,
        MeasuredImpactV1 impact,
        FindingConfidence confidence,
        IReadOnlyList<FindingEvidenceRefV1> evidence,
        IReadOnlyList<string> caveats,
        IReadOnlyList<string> alternateExplanations,
        IReadOnlyList<string> recommendedNextChecks,
        string readOnlyRecommendation,
        FindingSourceFreshnessV1 sourceFreshness) =>
        new(
            SchemaVersion,
            Fingerprint(rule.RuleId, rule.RuleVersion, scope),
            rule.RuleId,
            rule.RuleVersion,
            title,
            scope,
            window,
            FindingStatus.Firing,
            severity,
            impact,
            confidence,
            evidence,
            caveats,
            alternateExplanations,
            recommendedNextChecks,
            readOnlyRecommendation,
            sourceFreshness);
}
