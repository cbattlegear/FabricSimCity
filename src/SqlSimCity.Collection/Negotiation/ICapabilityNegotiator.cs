using SqlSimCity.Contracts.V1;

namespace SqlSimCity.Collection.Negotiation;

/// <summary>
/// Produces the canonical, source-neutral <see cref="TargetCapabilityProfileV1"/> for one target.
/// Implementations must run identically whether backed by a live
/// <c>Microsoft.Data.SqlClient</c> connection or a deterministic fixture (see
/// <c>SqlSimCity.Collection.Probes.IProbeExecutor</c>).
/// </summary>
public interface ICapabilityNegotiator
{
    Task<TargetCapabilityProfileV1> NegotiateAsync(CapabilityNegotiationRequest request, CancellationToken cancellationToken);
}
