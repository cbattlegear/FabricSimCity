using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Findings.Engine;

/// <summary>
/// The complete, already-bounded evidence set one findings evaluation runs against. It is assembled
/// once per request by an <see cref="Evidence.IFindingsEvidenceProvider"/> from the same visible
/// sources the atlas, Query Store, live, and capability tabs expose, so every finding derived from it
/// references a fact a human can independently open. The engine that consumes this bundle is pure: it
/// never opens a connection, never mutates a server, and produces identical output for identical input.
/// </summary>
/// <remarks>
/// <see cref="Families"/> and <see cref="Plans"/> are deliberately a bounded projection, never the
/// whole Query Store. A connected provider pages/indexes the top families by measured impact and loads
/// only their plans, so evaluation stays bounded even against a 100k-family target.
/// </remarks>
public sealed record FindingsEvidenceBundle(
    string TargetId,
    string TargetDisplayName,
    DateTimeOffset GeneratedAt,
    CapabilitiesSnapshotV1? Capabilities,
    AtlasSnapshotV1? Atlas,
    LiveIncidentSnapshotV1? Live,
    QueryStoreCollectorStatusV1? QueryStoreStatus,
    IReadOnlyList<QueryFamilyDetailV1> Families,
    IReadOnlyList<NormalizedShowplanV1> Plans,
    string BundleReason)
{
    public static FindingsEvidenceBundle Empty(string targetId, string displayName, DateTimeOffset generatedAt, string reason) =>
        new(targetId, displayName, generatedAt, null, null, null, null, [], [], reason);
}
