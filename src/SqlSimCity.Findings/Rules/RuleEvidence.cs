using SqlSimCity.Contracts.V1;
using SqlSimCity.Findings.Engine;

namespace SqlSimCity.Findings.Rules;

/// <summary>Shared, side-effect-free helpers for turning visible facts into finding evidence stamps and windows.</summary>
internal static class RuleEvidence
{
    internal const string QueryStoreWindowKind = "Query Store aggregate interval range";
    internal const string LiveWindowKind = "Point-in-time live sample";

    internal const string CompiledPlanCaveat =
        "Query Store supplies aggregate query-level runtime, not actual operator progress or per-operator timing.";

    internal const string SampleCaveat =
        "A live sample only proves what was true at the instant it was taken; work that started and finished between samples is invisible.";

    internal static FindingSourceFreshnessV1 From(QueryStoreEvidenceV1 evidence) =>
        new(EvidenceSource.QueryStoreAggregate, evidence.Status, evidence.ObservedAt, evidence.FreshUntil, evidence.Reason);

    internal static FindingSourceFreshnessV1 From(EvidenceV1 evidence) =>
        new(evidence.Source, evidence.Status, evidence.ObservedAt, evidence.FreshUntil, evidence.Reason);

    internal static FindingSourceFreshnessV1 FromLive(LiveIncidentSnapshotV1 live) =>
        new(EvidenceSource.LiveDmvSample, live.Status, live.SourceTimestamp, live.FreshUntil,
            "Live incident sampler snapshot; a bounded-cadence sample, not a continuous trace.");

    internal static ObservedWindowV1 QueryStoreWindow(DateTimeOffset? start, DateTimeOffset? end, string caveat) =>
        new(start, end, QueryStoreWindowKind, caveat);

    internal static ObservedWindowV1 LiveWindow(LiveIncidentSnapshotV1 live) =>
        new(live.SourceTimestamp, live.CollectedAt, LiveWindowKind, SampleCaveat);

    /// <summary>
    /// Downgrades a confidence when the underlying evidence is stale or not fully available, so
    /// low-confidence evidence can never present as a definitive diagnosis (requirement, item 1).
    /// </summary>
    internal static FindingConfidence Downgrade(FindingConfidence confidence, DataStatus status) =>
        status switch
        {
            DataStatus.Available => confidence,
            DataStatus.Stale => Lower(confidence),
            _ => FindingConfidence.Low,
        };

    private static FindingConfidence Lower(FindingConfidence confidence) => confidence switch
    {
        FindingConfidence.High => FindingConfidence.Medium,
        FindingConfidence.Medium => FindingConfidence.Low,
        _ => FindingConfidence.Low,
    };
}
