using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Domain;

/// <summary>
/// Source of the current, read-only capability-negotiation snapshot for
/// <c>/api/v1/capabilities</c>. Mirrors <see cref="IAtlasSnapshotSource"/>'s shape so the two
/// endpoints share the same wiring pattern; there is deliberately no corresponding write/mutation
/// interface.
/// </summary>
public interface ICapabilitiesSource
{
    CapabilitiesSnapshotV1 GetCurrent();
}
