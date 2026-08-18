namespace SqlSimCity.Contracts.V1;

/// <summary>
/// The evaluation outcome of one rule against the current evidence. A rule that could run but had
/// no qualifying evidence is <see cref="NotEvaluated"/> (its prerequisites were not met) or
/// <see cref="InsufficientEvidence"/> (prerequisites met, but not enough measured evidence to make a
/// claim) -- never a silent empty success. A finding a reader actually sees is <see cref="Firing"/>.
/// Low-confidence or stale evidence can only ever downgrade a finding; it is never promoted into a
/// definitive diagnosis.
/// </summary>
public enum FindingStatus { Firing, NotEvaluated, InsufficientEvidence }

/// <summary>
/// Qualitative, color-independent severity. This is an editorial ranking of how much a reader should
/// care, never a folklore numeric threshold and never an automated verdict about the server's health.
/// </summary>
public enum FindingSeverity { Informational, Advisory, Notable, Serious }

/// <summary>How much the evidence supports the finding. Always paired with the caveats that produced it.</summary>
public enum FindingConfidence { Low, Medium, High }

/// <summary>
/// The single dimension a finding's measured impact is expressed in. <see cref="None"/> is used for
/// configuration/advisory findings that carry no numeric magnitude (they are never assigned a
/// fabricated zero). Every numeric magnitude in <see cref="MeasuredImpactV1"/> is a decimal string.
/// </summary>
public enum FindingImpactDimension
{
    None,
    DurationMicroseconds,
    CpuMicroseconds,
    LogicalReads8KiBPages,
    WaitMilliseconds,
    BlockedSessions,
    MemoryGrantKb,
    AbortedExecutionShare,
    PlanCount,
    LogSpacePercent,
    IoStallMilliseconds,
}

/// <summary>Whether a rule can be evaluated at all against the current versioned contracts.</summary>
public enum RuleSupportStatus { Supported, Unsupported }

/// <summary>
/// The visible evidence surface a <see cref="FindingEvidenceRefV1"/> points to, so the reader can
/// navigate to the exact Query Store / live / atlas / capability fact the finding was derived from.
/// A finding never references an opaque internal assertion; every reference resolves to something a
/// human can open in the existing tabs.
/// </summary>
public enum FindingEvidenceKind
{
    QueryStoreFamily,
    QueryStorePlan,
    QueryStoreRuntimeBucket,
    QueryStoreStatus,
    LiveRequest,
    LiveBlockingNode,
    LiveMemoryGrant,
    LiveLogSpace,
    LiveFileIo,
    AtlasDatabase,
    Capability,
}

/// <summary>
/// One navigable reference to a visible fact. <see cref="Observation"/> is a curated, redacted
/// sentence describing exactly the measured fact -- never raw SQL text, raw Showplan XML, a host or
/// login name, or any secret.
/// </summary>
public sealed record FindingEvidenceRefV1(
    FindingEvidenceKind Kind,
    string Ref,
    string Label,
    string Observation);

/// <summary>
/// The exact measured magnitude behind a finding. <see cref="Magnitude"/> is a decimal string (never
/// a narrowed number) and is <c>null</c> only for a genuinely non-numeric configuration/advisory
/// finding -- it is never a zero standing in for "unknown". <see cref="Basis"/> states how the number
/// was derived, including which comparable buckets were summed.
/// </summary>
public sealed record MeasuredImpactV1(
    FindingImpactDimension Dimension,
    string? Magnitude,
    string Unit,
    string Basis);

/// <summary>
/// The observed window a finding describes. For Query Store this is the aggregate interval range; for
/// live evidence it is the point-in-time sample. <see cref="Caveat"/> discloses the aggregation limit
/// of that window (e.g. compiled plans carry no actual operator timing; a sample only proves the
/// instant it was taken).
/// </summary>
public sealed record ObservedWindowV1(
    DateTimeOffset? Start,
    DateTimeOffset? End,
    string Kind,
    string Caveat);

/// <summary>
/// Where a finding applies. A rule fires at most once per scope, so the scope is part of the finding
/// identity. <see cref="ResourceId"/> carries a non-query scope discriminator (a blocking session id,
/// a memory-grant session id, a database file id, or a plan id) so live-resource findings from the same
/// rule stay distinct without abusing the query-family/plan fields.
/// </summary>
public sealed record FindingScopeV1(
    string TargetId,
    string? DatabaseId,
    string? QueryFamilyId,
    string? PlanId,
    string DisplayName)
{
    public string? ResourceId { get; init; }
}

/// <summary>Freshness/provenance of the evidence a finding rests on, mirroring the atlas/live evidence stamp.</summary>
public sealed record FindingSourceFreshnessV1(
    EvidenceSource Source,
    DataStatus Status,
    DateTimeOffset? ObservedAt,
    DateTimeOffset? FreshUntil,
    string Reason);

/// <summary>
/// One evidence-backed performance finding. Every field a reader needs to independently reproduce and
/// judge the claim is present: the observed window, the exact measured impact, the confidence, the
/// navigable evidence references, the caveats and alternate explanations, the read-only recommendation
/// text, and the concrete next checks. <see cref="FindingId"/> is a deterministic fingerprint of the
/// rule identity plus scope, so it is stable across evaluation runs and safe to use as the
/// acknowledgment/suppression key for local presentation state.
/// </summary>
public sealed record FindingV1(
    string SchemaVersion,
    string FindingId,
    string RuleId,
    string RuleVersion,
    string Title,
    FindingScopeV1 Scope,
    ObservedWindowV1 ObservedWindow,
    FindingStatus Status,
    FindingSeverity Severity,
    MeasuredImpactV1 Impact,
    FindingConfidence Confidence,
    IReadOnlyList<FindingEvidenceRefV1> Evidence,
    IReadOnlyList<string> Caveats,
    IReadOnlyList<string> AlternateExplanations,
    IReadOnlyList<string> RecommendedNextChecks,
    string ReadOnlyRecommendation,
    FindingSourceFreshnessV1 SourceFreshness);

/// <summary>
/// One rule's evaluation record for the engine status surface, including whether the rule is even
/// supported by the current contracts. Unsupported rules (for example, ones that would require tempdb
/// or per-operator query attribution the current contracts cannot provide) are reported explicitly
/// rather than omitted, so a reader knows the coverage boundary.
/// </summary>
public sealed record RuleEvaluationV1(
    string RuleId,
    string RuleVersion,
    string Title,
    string Description,
    RuleSupportStatus Support,
    FindingStatus Outcome,
    int FindingCount,
    string Reason);

/// <summary>
/// The read-only status of the findings engine for one evaluation: when it ran, which rules ran and
/// what they concluded, and the freshness of every evidence source it consumed. This is deliberately
/// separate from the findings themselves so "no findings" and "could not evaluate" are never conflated.
/// </summary>
public sealed record FindingsEngineStatusV1(
    string SchemaVersion,
    DateTimeOffset GeneratedAt,
    string EngineVersion,
    int RuleCount,
    int SupportedRuleCount,
    int FiringRuleCount,
    int FindingCount,
    IReadOnlyList<RuleEvaluationV1> Rules,
    IReadOnlyList<FindingSourceFreshnessV1> Sources,
    string Reason);

/// <summary>A paged, sorted, filtered slice of findings. Read-only; the token is opaque and bounded.</summary>
public sealed record FindingsPageV1(
    string SchemaVersion,
    IReadOnlyList<FindingV1> Items,
    string? NextPageToken,
    int PageSize,
    int TotalCount,
    DateTimeOffset GeneratedAt);

/// <summary>
/// The literal-safe redacted export/preview shape. It carries the same evidence-backed findings but is
/// produced through an explicit redaction pass that omits or hashes any string that could contain raw
/// SQL, raw plan XML, credentials, host/user/client names, or protected identifiers. A redaction or
/// parse failure omits or hashes the offending text; raw text is never passed through.
/// </summary>
public sealed record FindingsExportV1(
    string SchemaVersion,
    DateTimeOffset GeneratedAt,
    string EngineVersion,
    string RedactionNote,
    int RedactedFieldCount,
    IReadOnlyList<FindingV1> Findings);
