using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Domain;

/// <summary>
/// Source-neutral producer of one <see cref="LiveIncidentSnapshotV1"/> per sampling cycle. Mirrors
/// <see cref="IAtlasSnapshotSource"/>'s role but is invoked repeatedly on a cadence (see
/// <c>SqlSimCity.Collection.Sampling.LiveIncidentSampler</c>) rather than serving one cached value.
/// Implementations must run identically whether backed by a live <c>Microsoft.Data.SqlClient</c>
/// connection or a deterministic fixture. There is deliberately no corresponding mutation
/// interface: this project never writes to a monitored server.
/// </summary>
public interface ILiveIncidentCollector
{
    /// <summary>
    /// Collects one snapshot. <paramref name="sequence"/> is the sampler's own monotonically
    /// increasing cycle counter, threaded through so <see cref="CollectionDiagnosticsV1.Sequence"/>
    /// always matches the cycle that produced it even when a collector is reused across restarts.
    /// </summary>
    Task<LiveIncidentSnapshotV1> CollectAsync(long sequence, CancellationToken cancellationToken);
}

/// <summary>
/// Source-neutral view of the latest live response. Archive mode implements this directly so it
/// never starts a cadence sampler or manufactures a newer observation.
/// </summary>
public interface ILiveIncidentResponseSource
{
    LiveIncidentResponseV1 GetCurrentResponse();
}
