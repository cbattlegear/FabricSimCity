using SqlSimCity.Collection.Negotiation;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;

namespace SqlSimCity.Api;

/// <summary>
/// Builds the <c>/api/v1/capabilities</c> snapshot by running the real
/// <see cref="CapabilityNegotiator"/> against every known fixture target in
/// <c>fixtures/v1/target-capabilities.json</c>, using <c>fixtures/v1/database-query-store.json</c>'s
/// healthy Query Store record as a representative per-database fact set. This produces genuine
/// <see cref="TargetCapabilityProfileV1"/> data -- the same shape a live
/// <c>SqlClientProbeExecutor</c> would produce -- before any live SQL Server connection exists.
/// The snapshot is computed once by the async startup factory (the fixture data is static and deterministic)
/// and cached, mirroring <see cref="SqlSimCity.Domain.IAtlasSnapshotSource"/>'s pattern.
/// </summary>
public sealed class FixtureCapabilitiesSource : ICapabilitiesSource
{
    private const string RepresentativeDatabaseName = "db:atlas-sales";

    private readonly CapabilitiesSnapshotV1 _snapshot;

    private FixtureCapabilitiesSource(CapabilitiesSnapshotV1 snapshot)
    {
        _snapshot = snapshot;
    }

    public static async Task<FixtureCapabilitiesSource> CreateAsync(
        TimeProvider? timeProvider = null,
        CancellationToken cancellationToken = default)
    {
        var time = timeProvider ?? TimeProvider.System;
        var generatedAt = time.GetUtcNow();
        var profiles = new List<TargetCapabilityProfileV1>();
        foreach (var targetId in FixtureProbeExecutor.GetKnownTargetIds())
        {
            var negotiator = new CapabilityNegotiator(new FixtureProbeExecutor(targetId), time);
            profiles.Add(await negotiator.NegotiateAsync(
                new CapabilityNegotiationRequest(targetId, RepresentativeDatabaseName),
                cancellationToken).ConfigureAwait(false));
        }

        return new FixtureCapabilitiesSource(new CapabilitiesSnapshotV1("1", generatedAt, profiles));
    }

    public CapabilitiesSnapshotV1 GetCurrent() => _snapshot;
}
