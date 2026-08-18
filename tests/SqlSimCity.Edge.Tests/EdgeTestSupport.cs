using System.Security.Cryptography;
using SqlSimCity.Edge.Envelope;
using SqlSimCity.Edge.Signing;

namespace SqlSimCity.Edge.Tests;

/// <summary>An in-memory replay store for tests (the production one is file-backed).</summary>
internal sealed class InMemoryNonceReplayStore : INonceReplayStore
{
    private readonly HashSet<string> _seen = new(StringComparer.Ordinal);

    public bool TryRegister(string connectorId, string nonce, DateTimeOffset expiresAt)
        => _seen.Add($"{connectorId}\u0001{nonce}");
}

internal static class EdgeTestSupport
{
    public const string ConnectorId = "edge-test-connector";
    public const string TargetId = "target-abc";
    public const string KeyId = "2026-08";

    public static byte[] NewSecret()
    {
        var secret = new byte[32];
        RandomNumberGenerator.Fill(secret);
        return secret;
    }

    public static InMemoryConnectorSecretResolver Resolver(byte[] secret, string connectorId = ConnectorId, string keyId = KeyId)
        => new(new Dictionary<string, IReadOnlyDictionary<string, byte[]>>
        {
            [connectorId] = new Dictionary<string, byte[]> { [keyId] = secret },
        });

    public static ObservationBatchV1 SampleBatch(
        string connectorId = ConnectorId,
        string targetId = TargetId,
        long sequence = 1,
        string epochId = "epoch-1",
        string bootId = "boot-1",
        object? payload = null,
        ObservationSection section = ObservationSection.Atlas)
    {
        var builder = new ObservationBatchBuilder(connectorId, targetId, epochId, bootId);
        var freshness = new ObservationFreshnessV1(DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, null);
        builder.AddSection(section, sequence, DateTimeOffset.UnixEpoch, freshness, payload ?? new { hello = "world", n = sequence });
        return builder.Build(Guid.NewGuid().ToString("N"), DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch);
    }
}
