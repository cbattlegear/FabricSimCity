using System.Text.Json;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.Edge.Envelope;

namespace SqlSimCity.Edge.Connector;

/// <summary>One section's content plus its source freshness, produced for a single collection cycle.</summary>
public sealed record ObservationInput(ObservationSection Section, ObservationFreshnessV1 Freshness, object Payload);

/// <summary>Produces the source-neutral observations a connector packages each cycle.</summary>
public interface IObservationProvider
{
    IReadOnlyList<ObservationInput> Collect(DateTimeOffset now);
}

/// <summary>
/// The default observation provider. It reuses the exact validated V1 contracts: the atlas snapshot
/// comes from <see cref="FixtureAtlasSnapshotSource"/> (the same source-neutral contract a connected
/// collector produces), and the capability and live sections are shipped from the canonical
/// <c>fixtures/v1</c> documents. No raw SQL, plan XML, host name, or credential is ever packaged; the
/// connector only forwards already-sanitized, normalized contract evidence. In a real deployment this
/// provider is swapped for one backed by the connected <c>SqlSimCity.Collection</c> collectors near
/// SQL Server; the transport, spool, signing, and central ingestion paths are identical either way.
/// </summary>
public sealed class FixtureObservationProvider : IObservationProvider
{
    private readonly FixtureAtlasSnapshotSource _atlas = new();
    private readonly string _fixturesDirectory;
    private readonly TimeSpan _liveFreshness;

    public FixtureObservationProvider(string fixturesDirectory, TimeSpan? liveFreshness = null)
    {
        _fixturesDirectory = fixturesDirectory ?? throw new ArgumentNullException(nameof(fixturesDirectory));
        _liveFreshness = liveFreshness ?? TimeSpan.FromSeconds(30);
    }

    public IReadOnlyList<ObservationInput> Collect(DateTimeOffset now)
    {
        var inputs = new List<ObservationInput>();

        var snapshot = _atlas.GetCurrent();
        inputs.Add(new ObservationInput(
            ObservationSection.Atlas,
            new ObservationFreshnessV1(snapshot.GeneratedAt, now, null),
            snapshot));

        if (TryReadFixture("target-capabilities.json", out var capabilities))
        {
            inputs.Add(new ObservationInput(
                ObservationSection.Capabilities,
                new ObservationFreshnessV1(snapshot.GeneratedAt, now, null),
                capabilities));
        }

        if (TryReadFixture("live-cases.json", out var live))
        {
            // Live samples are point-in-time and can be missed; freshUntil is the cadence boundary.
            inputs.Add(new ObservationInput(
                ObservationSection.Live,
                new ObservationFreshnessV1(now, now, now + _liveFreshness),
                live));
        }

        return inputs;
    }

    private bool TryReadFixture(string fileName, out JsonElement element)
    {
        element = default;
        var path = Path.Combine(_fixturesDirectory, fileName);
        if (!File.Exists(path))
            return false;

        using var document = JsonDocument.Parse(File.ReadAllBytes(path));
        element = document.RootElement.Clone();
        return true;
    }
}

/// <summary>
/// Builds one immutable <see cref="ObservationBatchV1"/> per collection cycle from an
/// <see cref="IObservationProvider"/>, assigning the monotonic per-target sequence and the current
/// boot epoch. Every section shares the cycle's sequence so the central store can reason about one
/// generation per cycle.
/// </summary>
public sealed class ConnectorObservationCollector(
    ConnectorOptions options,
    IObservationProvider provider,
    string bootId,
    string epochId)
{
    private long _sequence;

    public ObservationBatchV1? CollectBatch(DateTimeOffset now)
    {
        var inputs = provider.Collect(now);
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
