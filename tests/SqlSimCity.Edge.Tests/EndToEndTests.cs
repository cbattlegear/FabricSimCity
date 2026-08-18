using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using SqlSimCity.Contracts.V1;
using SqlSimCity.Domain;
using SqlSimCity.Edge.Envelope;
using SqlSimCity.Edge.Ingestion;
using SqlSimCity.Edge.Signing;

namespace SqlSimCity.Edge.Tests;

/// <summary>
/// A deterministic, in-memory end-to-end pass with no real network and no real SQL target: a
/// connector packages the exact <see cref="AtlasSnapshotV1"/> contract, signs the batch, the central
/// verifier authenticates it, the validator checks it, the store ingests it, and the reconstructed
/// atlas section deserializes back into the same contract. This is the fixture-central smoke path
/// exercised as a unit; no live target is contacted (disclosed).
/// </summary>
public sealed class EndToEndTests
{
    [Fact]
    public void Connector_to_central_round_trip_reconstructs_atlas_contract()
    {
        // --- Connector side: build and sign a batch carrying the real atlas contract. ---
        var snapshot = new FixtureAtlasSnapshotSource().GetCurrent();
        var freshness = new ObservationFreshnessV1(snapshot.GeneratedAt, snapshot.GeneratedAt, null);
        var builder = new ObservationBatchBuilder("edge-1", "target-1", "epoch-1", "boot-1");
        builder.AddSection(ObservationSection.Atlas, 1, snapshot.GeneratedAt, freshness, snapshot);
        var batch = builder.Build(Guid.NewGuid().ToString("N"), snapshot.GeneratedAt, snapshot.GeneratedAt);
        var body = EdgeJson.SerializeToUtf8Bytes(batch);

        var time = new FakeTimeProvider(DateTimeOffset.Parse("2026-08-17T12:00:00Z"));
        var secret = EdgeTestSupport.NewSecret();
        var signer = new HmacRequestSigner(time);
        var headers = signer.Sign("POST", "/api/v1/edge/ingest", "edge-1", "k1", secret, body);

        // --- Central side: verify, validate, ingest. ---
        var verifier = new HmacRequestVerifier(
            new InMemoryConnectorSecretResolver(new Dictionary<string, IReadOnlyDictionary<string, byte[]>>
            {
                ["edge-1"] = new Dictionary<string, byte[]> { ["k1"] = secret },
            }),
            new InMemoryNonceReplayStore(),
            new SignatureVerificationOptions(TimeSpan.FromMinutes(5)),
            time);

        var verification = verifier.Verify("POST", "/api/v1/edge/ingest",
            headers.ConnectorId, headers.KeyId, headers.UnixTimeSeconds.ToString(),
            headers.Nonce, headers.BodySha256Hex, headers.Signature, body);
        Assert.True(verification.IsAccepted);

        var received = JsonSerializer.Deserialize<ObservationBatchV1>(body, EdgeJson.Options)!;
        Assert.True(EdgeBatchValidator.TryValidate(received, new IngestionLimits(), out var chunks, out _));

        var store = new EdgeObservationStore();
        Assert.Equal(IngestionOutcome.Accepted, store.Ingest(received, chunks).Outcome);

        // --- The reconstructed atlas section is byte-identical evidence and re-parses to the contract. ---
        var section = store.GetSection("target-1", ObservationSection.Atlas);
        Assert.NotNull(section);
        var reconstructed = JsonSerializer.Deserialize<AtlasSnapshotV1>(section!.Content, EdgeJson.Options)!;
        Assert.Equal(snapshot.Target.TargetId, reconstructed.Target.TargetId);
        Assert.Equal(snapshot.Databases.Count, reconstructed.Databases.Count);

        var status = store.GetTargets();
        Assert.Single(status);
        Assert.Equal("target-1", status[0].TargetId);
    }
}
