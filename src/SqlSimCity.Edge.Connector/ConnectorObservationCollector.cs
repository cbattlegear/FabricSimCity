using SqlSimCity.Collection.LiveIncidents;
using SqlSimCity.Collection.Negotiation;
using SqlSimCity.Collection.Probes;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.Edge.Envelope;

namespace SqlSimCity.Edge.Connector;

public sealed record ObservationInput(ObservationSection Section, ObservationFreshnessV1 Freshness, object Payload);

public interface IObservationProvider
{
    Task<IReadOnlyList<ObservationInput>> CollectAsync(
        DateTimeOffset now,
        CancellationToken cancellationToken);
}

public sealed class FixtureObservationProvider : IObservationProvider
{
    private readonly FixtureAtlasSnapshotSource _atlas = new();
    private readonly FixtureQueryStoreHistorySource _queryStore = new();
    private readonly FixtureDatabaseCitySource _databaseCity = new();
    private readonly string _targetId;

    public FixtureObservationProvider(string fixturesDirectory, string targetId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(fixturesDirectory);
        ArgumentException.ThrowIfNullOrWhiteSpace(targetId);
        if (!Directory.Exists(fixturesDirectory))
            throw new DirectoryNotFoundException("The configured fixture directory does not exist.");
        _targetId = targetId;
    }

    public async Task<IReadOnlyList<ObservationInput>> CollectAsync(
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var atlas = _atlas.GetCurrent();
        atlas = atlas with
        {
            Target = atlas.Target with { TargetId = _targetId },
        };
        var atlasFreshness = new ObservationFreshnessV1(
            atlas.Collection?.SourceTimestamp ?? atlas.GeneratedAt,
            now,
            atlas.Collection?.StaleAfter);

        var capabilities = await BuildCapabilitiesAsync(now, cancellationToken).ConfigureAwait(false);
        var queryStore = await BuildQueryStoreAsync(cancellationToken).ConfigureAwait(false);
        var city = await BuildDatabaseCityAsync(cancellationToken).ConfigureAwait(false);
        var liveSnapshot = ConnectorObservationSanitizer.Live(
            await new FixtureLiveIncidentCollector(new FixedTimeProvider(now))
                .CollectAsync(1, cancellationToken).ConfigureAwait(false));
        liveSnapshot = liveSnapshot with
        {
            Target = liveSnapshot.Target with { TargetId = _targetId },
        };
        var live = new LiveIncidentResponseV1(
            liveSnapshot,
            new LiveCollectorStatusV1(
                SamplerRunState.Stopped,
                1,
                now,
                now,
                0,
                null,
                "Connector fixture captured one point-in-time sample.",
                0,
                0));

        return
        [
            new ObservationInput(
                ObservationSection.Atlas,
                atlasFreshness,
                new AtlasObservationV1(atlas, _atlas.GetStatus())),
            new ObservationInput(
                ObservationSection.Capabilities,
                new ObservationFreshnessV1(capabilities.GeneratedAt, now, null),
                capabilities),
            new ObservationInput(
                ObservationSection.QueryStore,
                new ObservationFreshnessV1(queryStore.Status.LastPublishedAt, now, null),
                queryStore),
            new ObservationInput(
                ObservationSection.DatabaseCity,
                new ObservationFreshnessV1(city.Summaries.GeneratedAt, now, null),
                city),
            new ObservationInput(
                ObservationSection.Live,
                new ObservationFreshnessV1(liveSnapshot.SourceTimestamp, now, liveSnapshot.FreshUntil),
                live),
        ];
    }

    private async Task<CapabilitiesSnapshotV1> BuildCapabilitiesAsync(
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var fixtureTarget = FixtureProbeExecutor.GetKnownTargetIds()[0];
        var profile = await new CapabilityNegotiator(
                new FixtureProbeExecutor(fixtureTarget),
                new FixedTimeProvider(now))
            .NegotiateAsync(
                new CapabilityNegotiationRequest(fixtureTarget, "db:atlas-sales"),
                cancellationToken)
            .ConfigureAwait(false);
        return new CapabilitiesSnapshotV1(
            "1",
            now,
            [profile with { TargetId = _targetId }]);
    }

    private async Task<QueryStoreObservationV1> BuildQueryStoreAsync(CancellationToken cancellationToken)
    {
        var page = await _queryStore.GetQueriesAsync(
            null, "cpu", 200, null, cancellationToken).ConfigureAwait(false);
        var families = new List<QueryFamilyDetailV1>(page.Items.Count);
        var plans = new Dictionary<string, NormalizedShowplanV1>(StringComparer.Ordinal);
        foreach (var summary in page.Items)
        {
            if (await _queryStore.GetFamilyAsync(summary.FamilyId, cancellationToken).ConfigureAwait(false) is not { } family)
                continue;
            families.Add(family);
            foreach (var planSummary in family.Plans)
            {
                if (await _queryStore.GetPlanAsync(planSummary.PlanId, cancellationToken).ConfigureAwait(false) is { } plan)
                    plans[plan.PlanId] = plan;
            }
        }
        return new QueryStoreObservationV1(
            await _queryStore.GetStatusAsync(cancellationToken).ConfigureAwait(false),
            families,
            plans.Values.ToArray());
    }

    private async Task<DatabaseCityObservationV1> BuildDatabaseCityAsync(CancellationToken cancellationToken)
    {
        var summaries = await _databaseCity.GetSummariesAsync(cancellationToken).ConfigureAwait(false);
        var pages = new List<DatabaseCityPageV1>();
        foreach (var database in summaries.Databases)
        foreach (var metric in Enum.GetValues<DatabaseCityMetric>())
        {
            if (await _databaseCity.GetDatabaseAsync(
                    database.DatabaseId,
                    metric,
                    50,
                    null,
                    cancellationToken).ConfigureAwait(false) is { } page)
            {
                pages.Add(page);
            }
        }
        return new DatabaseCityObservationV1(summaries, pages);
    }

    private sealed class FixedTimeProvider(DateTimeOffset value) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => value;
    }
}

public sealed class ConnectorObservationCollector(
    ConnectorOptions options,
    IObservationProvider provider,
    string bootId,
    string epochId)
{
    private long _sequence;

    public async Task<ObservationBatchV1?> CollectBatchAsync(
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var inputs = await provider.CollectAsync(now, cancellationToken).ConfigureAwait(false);
        if (inputs.Count == 0)
            return null;

        var sequence = Interlocked.Increment(ref _sequence);
        var builder = new ObservationBatchBuilder(options.ConnectorId, options.TargetId, epochId, bootId);
        foreach (var input in inputs)
            builder.AddSection(input.Section, sequence, now, input.Freshness, input.Payload);

        var batchId = Guid.NewGuid().ToString("N");
        return builder.Build(batchId, now, now);
    }
}
