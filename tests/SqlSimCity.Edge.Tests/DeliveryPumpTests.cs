using Microsoft.Extensions.Time.Testing;
using SqlSimCity.Edge.Delivery;
using SqlSimCity.Edge.Envelope;
using SqlSimCity.Edge.Spool;

namespace SqlSimCity.Edge.Tests;

public sealed class DeliveryPumpTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sqlsimcity-pump-" + Guid.NewGuid().ToString("N"));

    private sealed class FakeTransport(Func<ObservationBatchV1, int, DeliveryResponse> responder) : IDeliveryTransport
    {
        private int _calls;
        public int Calls => _calls;
        public Task<DeliveryResponse> SendAsync(ObservationBatchV1 batch, CancellationToken cancellationToken)
            => Task.FromResult(responder(batch, _calls++));
    }

    private static SpoolKey Key()
    {
        var bytes = new byte[32];
        for (var i = 0; i < bytes.Length; i++)
            bytes[i] = (byte)i;
        return new SpoolKey(1, bytes);
    }

    private EncryptedSpool NewSpool(SpoolKey key) => new(new SpoolOptions { DataDirectory = _dir }, key);

    private static ObservationBatchV1 MultiChunkBatch()
    {
        var freshness = new ObservationFreshnessV1(DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, null);
        var envelopes = new[]
        {
            new ObservationEnvelopeV1("1.0", "c", "t", 1, "e", "b", DateTimeOffset.UnixEpoch,
                ObservationSection.Atlas, "g", 0, 2, ObservationCompression.None,
                EdgeJson.Sha256Hex(new byte[] { 1 }), freshness, Convert.ToBase64String(new byte[] { 1 })),
            new ObservationEnvelopeV1("1.0", "c", "t", 1, "e", "b", DateTimeOffset.UnixEpoch,
                ObservationSection.Atlas, "g", 1, 2, ObservationCompression.None,
                EdgeJson.Sha256Hex(new byte[] { 2 }), freshness, Convert.ToBase64String(new byte[] { 2 })),
        };
        return new ObservationBatchV1("1.0", "c", "multi", ObservationBatchBuilder.DeriveIdempotencyKey("c", envelopes),
            DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, envelopes);
    }

    [Fact]
    public async Task Accepted_batch_is_delivered_and_acknowledged()
    {
        using var key = Key();
        var spool = NewSpool(key);
        var pump = new DeliveryPump(spool, new FakeTransport((_, _) => DeliveryResponse.Accepted));
        pump.Submit(EdgeTestSupport.SampleBatch());

        var summary = await pump.DrainOnceAsync(CancellationToken.None);
        Assert.Equal(1, summary.Delivered);
        Assert.Equal(0, spool.GetStatus().ItemCount);
    }

    [Fact]
    public async Task Transient_failure_retains_batch_and_suggests_delay()
    {
        using var key = Key();
        var spool = NewSpool(key);
        var pump = new DeliveryPump(spool, new FakeTransport((_, _) => new DeliveryResponse(DeliveryOutcome.Transient)));
        pump.Submit(EdgeTestSupport.SampleBatch());

        var summary = await pump.DrainOnceAsync(CancellationToken.None);
        Assert.Equal(0, summary.Delivered);
        Assert.NotNull(summary.SuggestedDelay);
        Assert.Equal(1, spool.GetStatus().ItemCount);
    }

    [Fact]
    public async Task Rate_limit_honors_retry_after()
    {
        using var key = Key();
        var spool = NewSpool(key);
        var pump = new DeliveryPump(spool,
            new FakeTransport((_, _) => new DeliveryResponse(DeliveryOutcome.RateLimited, TimeSpan.FromSeconds(17))));
        pump.Submit(EdgeTestSupport.SampleBatch());

        var summary = await pump.DrainOnceAsync(CancellationToken.None);
        Assert.Equal(TimeSpan.FromSeconds(17), summary.SuggestedDelay);
        Assert.Equal(1, spool.GetStatus().ItemCount);
    }

    [Fact]
    public async Task Auth_failure_stops_delivery()
    {
        using var key = Key();
        var spool = NewSpool(key);
        var pump = new DeliveryPump(spool, new FakeTransport((_, _) => new DeliveryResponse(DeliveryOutcome.AuthRejected)));
        pump.Submit(EdgeTestSupport.SampleBatch());

        var summary = await pump.DrainOnceAsync(CancellationToken.None);
        Assert.True(summary.AuthFaulted);
        Assert.True(pump.AuthFaulted);
        Assert.Equal(1, spool.GetStatus().ItemCount);

        // A faulted pump does not retry-storm: the next drain does nothing.
        var next = await pump.DrainOnceAsync(CancellationToken.None);
        Assert.Equal(0, next.Delivered);
    }

    [Fact]
    public async Task Permanent_rejection_is_dropped_with_accounting()
    {
        using var key = Key();
        var spool = NewSpool(key);
        var pump = new DeliveryPump(spool, new FakeTransport((_, _) => new DeliveryResponse(DeliveryOutcome.Conflict)));
        pump.Submit(EdgeTestSupport.SampleBatch());

        var summary = await pump.DrainOnceAsync(CancellationToken.None);
        Assert.Equal(1, summary.Dropped);
        Assert.Equal(0, spool.GetStatus().ItemCount);
    }

    [Fact]
    public async Task Payload_too_large_splits_at_chunk_boundary_and_delivers_halves()
    {
        using var key = Key();
        var spool = NewSpool(key);
        // 413 for any multi-chunk batch; accept single-chunk batches.
        var transport = new FakeTransport((batch, _) =>
            batch.Envelopes.Count > 1 ? new DeliveryResponse(DeliveryOutcome.PayloadTooLarge) : DeliveryResponse.Accepted);
        var pump = new DeliveryPump(spool, transport, new DeliveryPumpOptions { MaxBatchesPerDrain = 16 });
        pump.Submit(MultiChunkBatch());

        var summary = await pump.DrainOnceAsync(CancellationToken.None);
        Assert.True(summary.Split >= 1);
        Assert.Equal(2, summary.Delivered);
        Assert.Equal(0, spool.GetStatus().ItemCount);
    }

    [Fact]
    public async Task Offline_then_online_replays_in_order()
    {
        using var key = Key();
        var spool = NewSpool(key);
        var online = false;
        var delivered = new List<long>();
        var transport = new FakeTransport((batch, _) =>
        {
            if (!online)
                return new DeliveryResponse(DeliveryOutcome.Transient);
            delivered.Add(batch.Envelopes[0].Sequence);
            return DeliveryResponse.Accepted;
        });
        var pump = new DeliveryPump(spool, transport);

        var time = new FakeTimeProvider(DateTimeOffset.UnixEpoch);
        for (var i = 0; i < 3; i++)
            pump.Submit(EdgeTestSupport.SampleBatch(sequence: i));

        await pump.DrainOnceAsync(CancellationToken.None); // offline: nothing delivered
        Assert.Equal(3, spool.GetStatus().ItemCount);

        online = true;
        await pump.DrainOnceAsync(CancellationToken.None);
        Assert.Equal(new long[] { 0, 1, 2 }, delivered);
        Assert.Equal(0, spool.GetStatus().ItemCount);
    }

    [Fact]
    public async Task Payload_too_large_without_spool_room_retains_original()
    {
        using var key = Key();
        // Only one item fits, so the original occupies the sole slot and split halves cannot be spooled.
        var spool = new EncryptedSpool(new SpoolOptions { DataDirectory = _dir, MaxItems = 1 }, key);
        var transport = new FakeTransport((_, _) => new DeliveryResponse(DeliveryOutcome.PayloadTooLarge));
        var pump = new DeliveryPump(spool, transport);
        pump.Submit(MultiChunkBatch());

        var summary = await pump.DrainOnceAsync(CancellationToken.None);
        Assert.Equal(0, summary.Split);
        Assert.Equal(0, summary.Dropped);
        Assert.NotNull(summary.SuggestedDelay);
        Assert.Equal(1, spool.GetStatus().ItemCount); // original retained, nothing lost or duplicated
    }

    public void Dispose()
    {
        if (Directory.Exists(_dir))
            Directory.Delete(_dir, recursive: true);
    }
}
